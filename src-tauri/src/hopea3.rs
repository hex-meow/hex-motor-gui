//! HopeA3 — first **Robot Application**: an inverted-triangle 3-wheel omni base.
//!
//! Unlike Direct Control (discover unknown motors, drive each over SDO), a
//! Robot Application has a *fixed* motor count and layout, so it can use PDO
//! for control. HopeA3 drives all three HEX motors in **uncompressed MIT** mode
//! used as a direct velocity loop: with KP=0 and PDES unused, the motor's torque
//! law reduces to `τ = KD·(VDES − v) + TFF`, clamped by max torque — no profile
//! ramp (which is why this replaced PV). Each motor's **RPDO1** maps its MIT
//! velocity `0x2003:02` (f32 rev/s) + KD `0x2003:05` (u16) + max torque `0x6072`
//! (u16, ‰). The master streams targets at **500 Hz** as **one shared CAN-FD
//! frame** that all three motors receive — each reads its own 8-byte slice, the
//! other slices are consumed by placeholder mappings. This mirrors the
//! single-frame technique from a proven reference implementation.
//!
//! Feedback / odometry reuse the manager's existing TPDO1 stream (it already
//! parses position / host-filtered velocity / torque per motor); we read
//! `mgr.status(nid)` and run forward kinematics + dead-reckoning at the control
//! rate.
//!
//! Geometry, drivetrain and the installed motor type are **compile-time
//! constants** below (the chassis is not reconfigurable at runtime — only the
//! velocity/torque limits and the command are).

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use can_transport::CanFrame;
use hex_motor::canopen::rpdo_config::{build_rpdo_config_writes, RpdoRecipe};
use hex_motor::canopen::sdo;
use hex_motor::canopen::tpdo_config::TpdoEntry;
use hex_motor::cia402::{Cia402Manager, Logic};
use hex_motor::types::MotorMode;
use serde::Serialize;
use tokio::task::JoinHandle;

// ───────────────────────── compile-time chassis spec ─────────────────────────

// NOTE: the 4310/4342 motors report **and** accept velocity at the *output*
// (post-gearbox) shaft — i.e. the wheel shaft — so the reduction ratio cancels
// out of the kinematics entirely. `0x60FF` target velocity and the feedback
// velocity are both wheel rev/s; no gear factor is applied anywhere below.

/// Wheel radius (m). Wheel diameter is 0.2 m.
const WHEEL_RADIUS_M: f64 = 0.1;

/// The three motors' Node-IDs, indexed the same as [`CONTACTS_M`]:
/// `[motor1 (top-left), motor2 (bottom), motor3 (top-right)]`.
const NODE_IDS: [u8; 3] = [1, 2, 3];

/// Wheel ground-contact points in the chassis frame (ROS convention: +X
/// forward toward the "head" = the motor-1↔motor-3 edge, +Y left, +Z up),
/// metres, with the origin at **motor 2's contact** (as given). Indexed
/// `[motor1, motor2, motor3]`.
///
/// From the spec: motor 1 is 489.1 mm forward (X) and 281.8 mm left (Y) of
/// motor 2; motors 1/3 are mirrored across the X axis. This is ~equilateral.
const CONTACTS_M: [[f64; 2]; 3] = [
    [0.4891, 0.2818],  // motor 1, top-left
    [0.0, 0.0],        // motor 2, bottom (given zero point)
    [0.4891, -0.2818], // motor 3, top-right
];

/// Extra offset (m, chassis frame) applied **on top of the contact centroid**
/// to pick the control/odometry reference point. The body origin is
/// `centroid(CONTACTS_M) + BODY_OFFSET_M`. Leave at zero for "centre of the
/// three contacts"; tweak to shift the reference (e.g. to a payload centre).
const BODY_OFFSET_M: [f64; 2] = [0.0, 0.0];

/// Per-wheel direction sign. All `+1` because "all motors +rotation ⇒ chassis
/// rotates CCW" already matches the tangential-CCW drive directions derived
/// from the geometry. Flip an entry to `-1.0` only if a motor turns out wired
/// the other way on hardware.
const WHEEL_SIGN: [f64; 3] = [1.0, 1.0, 1.0];

/// Shared CAN-FD COB-ID that all three motors listen to as RPDO1. Chosen clear
/// of every motor's TPDO (`0x180+nid`), heartbeat (`0x700+nid`) and SDO
/// (`0x580/0x600+nid`). `0x200 + 0x10` (our master node).
const SHARED_RPDO_COB_ID: u16 = 0x210;

/// Control / odometry loop rate.
const CONTROL_HZ: u64 = 500;

/// Bytes per motor in the shared frame: uncompressed-MIT velocity
/// `0x2003:02`(4) + KD `0x2003:05`(2) + max torque `0x6072`(2) = 8.
const SLICE_LEN: usize = 8;

/// Uncompressed-MIT control parameter object (`0x2003`). With KP=0 and PDES
/// unused, torque = KD·(VDES − v) + TFF, clamped by max torque (`0x6072`) — a
/// direct velocity loop with no profile ramp (unlike PV).
const OD_MIT: u16 = 0x2003;
const MIT_SUB_PDES: u8 = 0x01; // f32 Rev      (position, unused → 0)
const MIT_SUB_VDES: u8 = 0x02; // f32 Rev/s    (velocity target, streamed)
const MIT_SUB_TFF: u8 = 0x03; // f32 Nm       (torque feedforward, → 0)
const MIT_SUB_KP: u8 = 0x04; // u16 0..=10000 (position gain, → 0)
const MIT_SUB_KD: u8 = 0x05; // u16 0..=10000 (velocity gain, streamed)
const MIT_SUB_FACTOR: u8 = 0x07; // f32       (kp/kd phys→int divisor)
const OD_MAX_TORQUE: u16 = 0x6072; // u16 ‰ of peak

/// Placeholder mapping object for the bytes belonging to *other* motors. Using
/// the vendor object the proven reference implementation uses (`0x3000:03`,
/// 32-bit) rather than a CiA dummy, since HEX firmware is known to accept it.
/// One per 4 bytes ⇒ two per 8-byte slice.
const PAD_ENTRY: TpdoEntry = TpdoEntry {
    index: 0x3000,
    subindex: 3,
    bit_len: 32,
};

/// Default limits / torque (all runtime-adjustable except being clamped, never
/// errored, when the UI sends more).
pub const DEFAULT_MAX_TORQUE_PERMILLE: u16 = 800;
pub const DEFAULT_MAX_LINEAR_MPS: f64 = 3.0;
pub const DEFAULT_MAX_ANGULAR_RPS: f64 = 3.0;
/// Default MIT velocity gain (Nm·s/rad). Conservative starting point; tune live.
pub const DEFAULT_KD_SI: f64 = 0.1;

// ───────────────────────────── shared state ─────────────────────────────────

#[derive(Clone, Copy)]
struct Command {
    /// Body-frame twist (m/s, m/s, rad/s). Stored already clamped.
    vx: f64,
    vy: f64,
    wz: f64,
    /// Per-motor max torque (‰ of peak), indexed like [`NODE_IDS`].
    max_torque: [u16; 3],
    /// Per-motor MIT velocity gain KD in **SI units (Nm·s/rad)**, indexed like
    /// [`NODE_IDS`]. Converted to the wire u16 (Nm·s/Rev ÷ factor) in the loop.
    kd_si: [f64; 3],
    /// Adjustable limits.
    max_linear: f64,
    max_angular: f64,
}

impl Default for Command {
    fn default() -> Self {
        Self {
            vx: 0.0,
            vy: 0.0,
            wz: 0.0,
            max_torque: [DEFAULT_MAX_TORQUE_PERMILLE; 3],
            kd_si: [DEFAULT_KD_SI; 3],
            max_linear: DEFAULT_MAX_LINEAR_MPS,
            max_angular: DEFAULT_MAX_ANGULAR_RPS,
        }
    }
}

/// Snapshot handed to the frontend each poll.
#[derive(Debug, Clone, Default, Serialize)]
pub struct Hopea3State {
    /// World pose from dead-reckoning (m, m, rad).
    pub pose_x: f64,
    pub pose_y: f64,
    pub pose_theta: f64,
    /// Measured body twist from wheel feedback.
    pub meas_vx: f64,
    pub meas_vy: f64,
    pub meas_wz: f64,
    /// Commanded (clamped) body twist.
    pub cmd_vx: f64,
    pub cmd_vy: f64,
    pub cmd_wz: f64,
    pub max_linear: f64,
    pub max_angular: f64,
    pub motors: Vec<Hopea3Motor>,
    pub running: bool,
}

/// Init progress, polled by the UI while `hopea3_start` runs.
#[derive(Debug, Clone, Default, Serialize)]
pub struct InitProgress {
    /// `true` while an init is in flight.
    pub active: bool,
    /// 1-based index of the motor currently being initialized (0 = not started).
    pub current: u8,
    /// Total motors to initialize.
    pub total: u8,
    /// Current attempt number (1..=INIT_ATTEMPTS) for `current`.
    pub attempt: u8,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct Hopea3Motor {
    pub node_id: u8,
    pub online: bool,
    pub enabled: bool,
    /// Commanded motor shaft velocity this tick (rev/s).
    pub target_rev_per_s: f32,
    /// Measured motor shaft velocity (rev/s, host-filtered by the manager).
    pub velocity_rev_per_s: Option<f32>,
    pub torque_nm: Option<f32>,
    pub max_torque_permille: u16,
    pub driver_temp_c: Option<f32>,
    pub motor_temp_c: Option<f32>,
    /// `Some(reason)` if the motor is in a fault state.
    pub error: Option<String>,
}

// ───────────────────────────── kinematics ───────────────────────────────────

/// Precomputed inverse/forward kinematics for the fixed geometry.
struct Kinematics {
    /// Inverse-kinematics matrix J (3×3): `wheel_speed = J · [vx,vy,wz]`.
    /// Row i = `[cosθ_i, sinθ_i, rx_i·sinθ_i − ry_i·cosθ_i]` (units: wheel
    /// contact linear speed m/s), with the per-wheel sign folded in.
    j: [[f64; 3]; 3],
    /// `J⁻¹` for odometry: `[vx,vy,wz] = J⁻¹ · wheel_speed`.
    j_inv: [[f64; 3]; 3],
}

impl Kinematics {
    fn new() -> Self {
        let centroid = [
            (CONTACTS_M[0][0] + CONTACTS_M[1][0] + CONTACTS_M[2][0]) / 3.0,
            (CONTACTS_M[0][1] + CONTACTS_M[1][1] + CONTACTS_M[2][1]) / 3.0,
        ];
        let origin = [centroid[0] + BODY_OFFSET_M[0], centroid[1] + BODY_OFFSET_M[1]];

        let mut j = [[0.0f64; 3]; 3];
        for i in 0..3 {
            // Wheel position relative to the *body origin* (used for the moment arm).
            let rx = CONTACTS_M[i][0] - origin[0];
            let ry = CONTACTS_M[i][1] - origin[1];
            // Drive direction: tangential CCW about the *centroid* (a physical
            // mounting property, independent of where we put the body origin).
            let ang = (CONTACTS_M[i][1] - centroid[1]).atan2(CONTACTS_M[i][0] - centroid[0])
                + std::f64::consts::FRAC_PI_2;
            let (ct, st) = (ang.cos(), ang.sin());
            let s = WHEEL_SIGN[i];
            j[i] = [s * ct, s * st, s * (rx * st - ry * ct)];
        }
        let j_inv = invert3(&j).expect("HopeA3 kinematics matrix must be invertible");
        Self { j, j_inv }
    }

    /// Body twist → per-wheel velocity (output-shaft rev/s, = `0x60FF` target).
    fn twist_to_motor_rev_s(&self, vx: f64, vy: f64, wz: f64) -> [f64; 3] {
        let mut out = [0.0; 3];
        for i in 0..3 {
            let wheel_mps = self.j[i][0] * vx + self.j[i][1] * vy + self.j[i][2] * wz;
            out[i] = wheel_mps / (2.0 * std::f64::consts::PI * WHEEL_RADIUS_M);
        }
        out
    }

    /// Per-wheel velocity (output-shaft rev/s, from feedback) → body twist.
    fn motor_rev_s_to_twist(&self, motor_rev_s: [f64; 3]) -> (f64, f64, f64) {
        let mut wheel_mps = [0.0; 3];
        for i in 0..3 {
            wheel_mps[i] = motor_rev_s[i] * 2.0 * std::f64::consts::PI * WHEEL_RADIUS_M;
        }
        let vx = self.j_inv[0][0] * wheel_mps[0]
            + self.j_inv[0][1] * wheel_mps[1]
            + self.j_inv[0][2] * wheel_mps[2];
        let vy = self.j_inv[1][0] * wheel_mps[0]
            + self.j_inv[1][1] * wheel_mps[1]
            + self.j_inv[1][2] * wheel_mps[2];
        let wz = self.j_inv[2][0] * wheel_mps[0]
            + self.j_inv[2][1] * wheel_mps[1]
            + self.j_inv[2][2] * wheel_mps[2];
        (vx, vy, wz)
    }
}

/// Invert a 3×3 matrix (cofactor method). `None` if (near-)singular.
fn invert3(m: &[[f64; 3]; 3]) -> Option<[[f64; 3]; 3]> {
    let det = m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1])
        - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
        + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
    if det.abs() < 1e-12 {
        return None;
    }
    let inv_det = 1.0 / det;
    let mut out = [[0.0; 3]; 3];
    out[0][0] = (m[1][1] * m[2][2] - m[1][2] * m[2][1]) * inv_det;
    out[0][1] = (m[0][2] * m[2][1] - m[0][1] * m[2][2]) * inv_det;
    out[0][2] = (m[0][1] * m[1][2] - m[0][2] * m[1][1]) * inv_det;
    out[1][0] = (m[1][2] * m[2][0] - m[1][0] * m[2][2]) * inv_det;
    out[1][1] = (m[0][0] * m[2][2] - m[0][2] * m[2][0]) * inv_det;
    out[1][2] = (m[0][2] * m[1][0] - m[0][0] * m[1][2]) * inv_det;
    out[2][0] = (m[1][0] * m[2][1] - m[1][1] * m[2][0]) * inv_det;
    out[2][1] = (m[0][1] * m[2][0] - m[0][0] * m[2][1]) * inv_det;
    out[2][2] = (m[0][0] * m[1][1] - m[0][1] * m[1][0]) * inv_det;
    Some(out)
}

// ───────────────────────────── the driver ───────────────────────────────────

/// A running HopeA3 chassis: owns the 500 Hz control/odom task.
pub struct Hopea3 {
    cmd: Arc<StdMutex<Command>>,
    state: Arc<StdMutex<Hopea3State>>,
    running: Arc<AtomicBool>,
    task: JoinHandle<()>,
}

/// How many times to attempt each motor's init before giving up. Motor init
/// (especially the firmware's flaky heartbeat-fault clear) can fail
/// intermittently, so we retry per motor.
const INIT_ATTEMPTS: u8 = 3;

impl Hopea3 {
    /// Configure the three motors (init + RPDO mapping + PV mode + enable) and
    /// start the 500 Hz control/odometry loop. The manager must already be
    /// connected with heartbeat broadcast on. `progress` is updated in place so
    /// the UI can show which motor is being initialized.
    pub async fn start(
        mgr: Arc<Cia402Manager>,
        progress: &StdMutex<InitProgress>,
    ) -> anyhow::Result<Self> {
        let kin = Kinematics::new();
        let cmd = Arc::new(StdMutex::new(Command::default()));
        let state = Arc::new(StdMutex::new(Hopea3State::default()));

        let sdo_timeout = Some(mgr.options().sdo_timeout);
        let bus = mgr.bus();
        let default_torque = cmd.lock().unwrap().max_torque;

        *progress.lock().unwrap() = InitProgress {
            active: true,
            current: 0,
            total: NODE_IDS.len() as u8,
            attempt: 0,
        };

        // Per-motor init, each retried up to INIT_ATTEMPTS times. Between
        // attempts we clear faults and wait, since the most common failure is
        // the firmware's phase-dependent heartbeat-fault clear.
        let mut kd_factor = [1.0f32; 3];
        for (slice, &nid) in NODE_IDS.iter().enumerate() {
            let mut last_err = None;
            for attempt in 1..=INIT_ATTEMPTS {
                {
                    let mut p = progress.lock().unwrap();
                    p.current = (slice + 1) as u8;
                    p.attempt = attempt;
                }
                match init_one_motor(&mgr, &bus, sdo_timeout, slice, nid, default_torque[slice]).await
                {
                    Ok(factor) => {
                        log::info!("HopeA3: motor 0x{nid:02X} ready (slice {slice}, attempt {attempt}, kd_factor {factor})");
                        kd_factor[slice] = factor;
                        last_err = None;
                        break;
                    }
                    Err(e) => {
                        log::warn!("HopeA3: motor 0x{nid:02X} init attempt {attempt}/{INIT_ATTEMPTS} failed: {e}");
                        last_err = Some(e);
                        let _ = mgr.clear_error(nid).await;
                        tokio::time::sleep(Duration::from_millis(300)).await;
                    }
                }
            }
            if let Some(e) = last_err {
                progress.lock().unwrap().active = false;
                return Err(e.context(format!("motor 0x{nid:02X} failed after {INIT_ATTEMPTS} attempts")));
            }
        }
        progress.lock().unwrap().active = false;

        // 2) Control + odometry loop.
        let running = Arc::new(AtomicBool::new(true));
        let task = {
            let cmd = cmd.clone();
            let state = state.clone();
            let running = running.clone();
            tokio::spawn(async move {
                control_loop(mgr, bus, kin, kd_factor, cmd, state, running).await;
            })
        };

        Ok(Self {
            cmd,
            state,
            running,
            task,
        })
    }

    /// Update the commanded twist (clamped to the current limits, never errored).
    pub fn set_cmd(&self, vx: f64, vy: f64, wz: f64) {
        let mut c = self.cmd.lock().unwrap();
        let (vx, vy, wz) = clamp_twist(vx, vy, wz, c.max_linear, c.max_angular);
        c.vx = vx;
        c.vy = vy;
        c.wz = wz;
    }

    /// Update per-motor max torque (‰), pushed to the stream on the next tick.
    pub fn set_max_torque(&self, permille: [u16; 3]) {
        let mut c = self.cmd.lock().unwrap();
        c.max_torque = permille.map(|p| p.min(1000));
    }

    /// Update per-motor MIT velocity gain KD (SI, Nm·s/rad), streamed next tick.
    pub fn set_kd(&self, kd_si: [f64; 3]) {
        let mut c = self.cmd.lock().unwrap();
        c.kd_si = kd_si.map(|k| k.max(0.0));
    }

    /// Update the velocity limits (re-clamps the current command).
    pub fn set_limits(&self, max_linear: f64, max_angular: f64) {
        let mut c = self.cmd.lock().unwrap();
        c.max_linear = max_linear.max(0.0);
        c.max_angular = max_angular.max(0.0);
        let (vx, vy, wz) = clamp_twist(c.vx, c.vy, c.wz, c.max_linear, c.max_angular);
        c.vx = vx;
        c.vy = vy;
        c.wz = wz;
    }

    /// Reset the dead-reckoned pose to the origin.
    pub fn reset_odom(&self) {
        let mut s = self.state.lock().unwrap();
        s.pose_x = 0.0;
        s.pose_y = 0.0;
        s.pose_theta = 0.0;
    }

    pub fn state(&self) -> Hopea3State {
        self.state.lock().unwrap().clone()
    }

    /// Stop the loop, zero the targets and disable all motors.
    pub async fn stop(self, mgr: &Cia402Manager) {
        self.running.store(false, Ordering::SeqCst);
        let _ = self.task.await;
        for &nid in &NODE_IDS {
            if let Err(e) = mgr.disable(nid).await {
                log::warn!("HopeA3: disable 0x{nid:02X} on stop: {e}");
            }
        }
    }
}

/// Initialize a single motor for uncompressed-MIT velocity control: CiA402 init
/// (TPDO1 + NMT Op + fault clear), overwrite RPDO1 with the shared-frame
/// mapping, zero the static MIT params (PDES/KP/TFF — we only stream VDES + KD),
/// read the kp/kd phys→int factor, set max torque, switch to MIT mode (which
/// also enables). Returns the motor's `0x2003:07` factor (for KD conversion).
/// One attempt; the caller retries.
async fn init_one_motor(
    mgr: &Cia402Manager,
    bus: &Arc<dyn can_transport::CanBus>,
    sdo_timeout: Option<Duration>,
    slice: usize,
    nid: u8,
    max_torque: u16,
) -> anyhow::Result<f32> {
    mgr.initialize(nid)
        .await
        .map_err(|e| anyhow::anyhow!("initialize: {e}"))?;

    let recipe = RpdoRecipe {
        rpdo_index: 0,
        cob_id: SHARED_RPDO_COB_ID,
        entries: rpdo_entries_for_slice(slice),
        transmission_type: 255,
    };
    let writes =
        build_rpdo_config_writes(&recipe).map_err(|e| anyhow::anyhow!("rpdo recipe: {e}"))?;
    for w in &writes {
        sdo::download(&**bus, nid, w.index, w.subindex, &w.data, sdo_timeout)
            .await
            .map_err(|e| anyhow::anyhow!("rpdo write {:04X}:{}: {e}", w.index, w.subindex))?;
        tokio::time::sleep(Duration::from_millis(10)).await;
    }

    // Static MIT params: zero PDES / KP / TFF so torque = KD·(VDES − v).
    sdo::download_f32(&**bus, nid, OD_MIT, MIT_SUB_PDES, 0.0, sdo_timeout)
        .await
        .map_err(|e| anyhow::anyhow!("zero PDES: {e}"))?;
    sdo::download_u16(&**bus, nid, OD_MIT, MIT_SUB_KP as u8, 0, sdo_timeout)
        .await
        .map_err(|e| anyhow::anyhow!("zero KP: {e}"))?;
    sdo::download_f32(&**bus, nid, OD_MIT, MIT_SUB_TFF, 0.0, sdo_timeout)
        .await
        .map_err(|e| anyhow::anyhow!("zero TFF: {e}"))?;

    // kp/kd phys→int divisor. Default to 1.0 if the motor doesn't expose it
    // (KD can still be tuned by feel); log so it's visible.
    let factor = match sdo::upload_f32(&**bus, nid, OD_MIT, MIT_SUB_FACTOR, sdo_timeout).await {
        Ok(f) if f.is_finite() && f.abs() > f32::EPSILON => f,
        other => {
            log::warn!("HopeA3: motor 0x{nid:02X} kp/kd factor read = {other:?}; using 1.0");
            1.0
        }
    };

    mgr.set_max_torque(nid, max_torque)
        .await
        .map_err(|e| anyhow::anyhow!("set_max_torque: {e}"))?;
    mgr.set_mode(nid, MotorMode::Mit)
        .await
        .map_err(|e| anyhow::anyhow!("set_mode MIT: {e}"))?;
    Ok(factor)
}

/// Best-effort fault clear on all three motors (CiA402 fault reset, `0x6040 =
/// 0x80`). Used before init and exposed as a manual "clear errors" action so the
/// user doesn't have to switch to the Direct Control tool to recover a chassis
/// that was left in a heartbeat-lost / fault state.
pub async fn clear_errors(mgr: &Cia402Manager) {
    for &nid in &NODE_IDS {
        if let Err(e) = mgr.clear_error(nid).await {
            log::warn!("HopeA3: clear_error 0x{nid:02X}: {e}");
        }
    }
}

/// RPDO1 mapping entries for the motor occupying `slice` (0..3) of the shared
/// frame: its own `[0x60FF/32, 0x6072/16, 0x6071/16]` at its offset, and two
/// 32-bit placeholders for every other motor's 8-byte slice.
fn rpdo_entries_for_slice(slice: usize) -> Vec<TpdoEntry> {
    let mut entries = Vec::with_capacity(3 + 4);
    for j in 0..3 {
        if j == slice {
            entries.push(TpdoEntry { index: OD_MIT, subindex: MIT_SUB_VDES, bit_len: 32 }); // velocity
            entries.push(TpdoEntry { index: OD_MIT, subindex: MIT_SUB_KD, bit_len: 16 }); // KD
            entries.push(TpdoEntry { index: OD_MAX_TORQUE, subindex: 0, bit_len: 16 }); // max torque
        } else {
            entries.push(PAD_ENTRY);
            entries.push(PAD_ENTRY);
        }
    }
    entries
}

fn clamp_twist(vx: f64, vy: f64, wz: f64, max_linear: f64, max_angular: f64) -> (f64, f64, f64) {
    let mag = (vx * vx + vy * vy).sqrt();
    let (vx, vy) = if max_linear > 0.0 && mag > max_linear {
        let s = max_linear / mag;
        (vx * s, vy * s)
    } else {
        (vx, vy)
    };
    let wz = wz.clamp(-max_angular, max_angular);
    (vx, vy, wz)
}

async fn control_loop(
    mgr: Arc<Cia402Manager>,
    bus: Arc<dyn can_transport::CanBus>,
    kin: Kinematics,
    kd_factor: [f32; 3],
    cmd: Arc<StdMutex<Command>>,
    state: Arc<StdMutex<Hopea3State>>,
    running: Arc<AtomicBool>,
) {
    let period = Duration::from_micros(1_000_000 / CONTROL_HZ);
    let dt = 1.0 / CONTROL_HZ as f64;
    let mut tick = tokio::time::interval(period);
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

    while running.load(Ordering::SeqCst) {
        tick.tick().await;

        let c = *cmd.lock().unwrap();

        // ── inverse kinematics → send shared RPDO frame ──
        // Per motor: VDES (f32 Rev/s) + KD (u16) + max torque (u16). KD is given
        // in SI (Nm·s/rad); convert to the motor's wire int: Rev units = ×τ,
        // then ÷ the per-motor 0x2003:07 factor, clamped 0..=10000.
        let targets = kin.twist_to_motor_rev_s(c.vx, c.vy, c.wz);
        let mut data = [0u8; SLICE_LEN * 3];
        for slice in 0..3 {
            let kd_rev = (c.kd_si[slice] * std::f64::consts::TAU) as f32;
            let kd_int = (kd_rev / kd_factor[slice]).round().clamp(0.0, 10_000.0) as u16;
            let off = slice * SLICE_LEN;
            data[off..off + 4].copy_from_slice(&(targets[slice] as f32).to_le_bytes());
            data[off + 4..off + 6].copy_from_slice(&kd_int.to_le_bytes());
            data[off + 6..off + 8].copy_from_slice(&c.max_torque[slice].to_le_bytes());
        }
        match CanFrame::new_fd(SHARED_RPDO_COB_ID, &data, true) {
            Ok(frame) => {
                if let Err(e) = bus.send(frame).await {
                    log::warn!("HopeA3: RPDO send failed: {e}");
                }
            }
            Err(e) => log::error!("HopeA3: build RPDO frame: {e}"),
        }

        // ── forward kinematics from wheel feedback → twist + odom ──
        let mut motor_rev_s = [0.0f64; 3];
        let mut motors = Vec::with_capacity(3);
        for (i, &nid) in NODE_IDS.iter().enumerate() {
            let ls = mgr.status(nid);
            let m = &ls.measurements;
            let vel = m.velocity_rev_per_s;
            motor_rev_s[i] = WHEEL_SIGN[i] * vel.unwrap_or(0.0) as f64;
            let (enabled, error) = match ls.logic.as_ref() {
                Some(Logic::Enabled(_)) => (true, None),
                Some(Logic::Error { kind, raw_code }) => {
                    (false, Some(format!("{kind:?} (0x{raw_code:04X})")))
                }
                _ => (false, None),
            };
            motors.push(Hopea3Motor {
                node_id: nid,
                online: ls.connection.online,
                enabled,
                target_rev_per_s: targets[i] as f32,
                velocity_rev_per_s: vel,
                torque_nm: m.torque_nm,
                max_torque_permille: c.max_torque[i],
                driver_temp_c: m.driver_temp_c,
                motor_temp_c: m.motor_temp_c,
                error,
            });
        }
        let (mvx, mvy, mwz) = kin.motor_rev_s_to_twist(motor_rev_s);

        {
            let mut s = state.lock().unwrap();
            // Dead-reckon in the world frame (Euler integration of body twist).
            let th = s.pose_theta;
            s.pose_x += (mvx * th.cos() - mvy * th.sin()) * dt;
            s.pose_y += (mvx * th.sin() + mvy * th.cos()) * dt;
            s.pose_theta = wrap_pi(s.pose_theta + mwz * dt);
            s.meas_vx = mvx;
            s.meas_vy = mvy;
            s.meas_wz = mwz;
            s.cmd_vx = c.vx;
            s.cmd_vy = c.vy;
            s.cmd_wz = c.wz;
            s.max_linear = c.max_linear;
            s.max_angular = c.max_angular;
            s.motors = motors;
            s.running = true;
        }
    }

    state.lock().unwrap().running = false;
    log::info!("HopeA3: control loop stopped");
}

fn wrap_pi(a: f64) -> f64 {
    let tau = std::f64::consts::TAU;
    let mut a = a % tau;
    if a > std::f64::consts::PI {
        a -= tau;
    } else if a < -std::f64::consts::PI {
        a += tau;
    }
    a
}
