//! SmartKnob — a haptic rotary-input **Robot Application** (single motor).
//!
//! Port of [scottbez1/smartknob](https://github.com/scottbez1/smartknob)'s
//! firmware feel to a HEX 4310/4342 actuator. SmartKnob turns a brushless
//! gimbal motor into a software-configurable knob: virtual detents, endstops,
//! return-to-center, fine/coarse value dials, etc. The "feel" is pure torque
//! feedback computed from the shaft angle relative to the nearest *detent
//! center*.
//!
//! ## How it maps onto a HEX motor
//!
//! The original firmware runs a torque loop on the motor's own MCU
//! (`motor.move(torque)` in SimpleFOC). Our actuator instead exposes an
//! **uncompressed-MIT** control object (`0x2003`) where, with KP=0, the torque
//! law is `τ = TFF + KD·(VDES − v)`. So we keep smartknob's algorithm **on the
//! host** (it owns the detent state machine and computes the torque exactly as
//! the firmware does) and stream the result as the **torque feed-forward**
//! `0x2003:03` over **RPDO1** at [`CONTROL_HZ`]. The motor just applies the
//! torque we send — no dependence on the motor's internal position frame, which
//! makes multi-turn modes robust. VDES/KD are left at 0 (all damping is done in
//! software, faithfully to the firmware's PID D-term).
//!
//! This reuses the exact PDO plumbing HopeA3 uses (RPDO remap + a high-rate
//! control task streaming one CAN-FD frame), see [`crate::hopea3`].
//!
//! Unlike HopeA3 (fixed 3-motor chassis) the knob is a *single* motor whose
//! node-id the user picks at runtime from the discovered devices.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::{Duration, Instant};

use can_transport::CanFrame;
use hex_motor::canopen::rpdo_config::{build_rpdo_config_writes, RpdoRecipe};
use hex_motor::canopen::sdo;
use hex_motor::canopen::tpdo_config::TpdoEntry;
use hex_motor::cia402::{Cia402Manager, Logic};
use hex_motor::types::MotorMode;
use serde::Serialize;
use tokio::task::JoinHandle;

// ─────────────────────────── tunables / constants ───────────────────────────

/// Control + haptic loop rate. A knob wants this as high as the TPDO feedback
/// allows; 1 kHz gives crisp detents.
const CONTROL_HZ: u64 = 1000;

/// RPDO1 COB-ID the motor listens on. The motor's default RPDO1 is `0x200+nid`;
/// we keep that (the recipe just rewrites the *mapping*, not the id space).
fn rpdo_cob_id(nid: u8) -> u16 {
    0x200 + nid as u16
}

/// Bytes streamed each tick: TFF `0x2003:03`(f32,4) + KD `0x2003:05`(u16,2) +
/// max torque `0x6072`(u16,2) = 8.
const FRAME_LEN: usize = 8;

/// Uncompressed-MIT control object (`0x2003`). See module docs for the law.
const OD_MIT: u16 = 0x2003;
const MIT_SUB_PDES: u8 = 0x01; // f32 Rev   (position target, unused → 0)
const MIT_SUB_VDES: u8 = 0x02; // f32 Rev/s (velocity target, unused → 0)
const MIT_SUB_TFF: u8 = 0x03; // f32 Nm    (torque feed-forward, streamed)
const MIT_SUB_KP: u8 = 0x04; // u16        (position gain, → 0)
const MIT_SUB_KD: u8 = 0x05; // u16        (velocity gain, streamed; default 0)
const MIT_SUB_FACTOR: u8 = 0x07; // f32     (kp/kd phys→int divisor)
const OD_MAX_TORQUE: u16 = 0x6072; // u16 ‰ of peak

/// Direction sign (the firmware's `SK_INVERT_ROTATION`). Applied to both the
/// read angle and the output torque so the haptic spring stays *stable* either
/// way; flipping it only reverses **which way you turn to increase the value**.
/// (Spring stability itself relies on the motor's FOC calibration aligning
/// torque sign with the sensor sign — flip the motor's zero/direction if it
/// feels anti-stable.)
const DIRECTION: f64 = 1.0;

// Haptic constants, lifted verbatim from the firmware's `motor_task.cpp`.
const DEAD_ZONE_DETENT_PERCENT: f64 = 0.2;
const DEAD_ZONE_RAD: f64 = std::f64::consts::PI / 180.0; // 1°
const IDLE_VELOCITY_EWMA_ALPHA: f64 = 0.001;
const IDLE_VELOCITY_RAD_PER_SEC: f64 = 0.05;
const IDLE_CORRECTION_DELAY: Duration = Duration::from_millis(500);
const IDLE_CORRECTION_MAX_ANGLE_RAD: f64 = 5.0 * std::f64::consts::PI / 180.0;
const IDLE_CORRECTION_RATE_ALPHA: f64 = 0.0005;
/// Above this shaft speed (rad/s) we command zero torque, to avoid a runaway
/// positive-feedback loop (firmware's `fabsf(shaft_velocity) > 60`).
const MAX_VEL_RAD_S: f64 = 60.0;
/// PID output limit in firmware torque units (`PID_velocity.limit = 10`).
const PID_LIMIT: f64 = 10.0;

// ── Haptic click ──
//
// For modes with [`KnobConfig::click_torque_nm`] > 0, we inject a short
// alternating torque burst — a "click" — every time the logical position
// changes.  Direction alternates so clockwise and counter-clockwise
// transitions both feel crisp.  Works for any detent width, from fine (≤3°)
// to coarse.
//
//   Reference: scottbez1/smartknob firmware, motor_task.cpp:
//   "consider eliminating this D factor entirely and just 'play' a
//    hardcoded haptic 'click' (e.g. a quick burst of torque in each
//    direction) whenever the position changes when the detent width is
//    too small for the P factor to work well."

/// Detent widths below this threshold use haptic clicks instead of D-gain.
const CLICK_WIDTH_THRESHOLD_RAD: f64 = 3.0 * DEG;

/// Click duration per direction (ticks at 1 kHz).  5 ms → 10 ms total per click.
const CLICK_TICKS_PER_PHASE: u32 = 5;

/// Default live-tunables.
pub const DEFAULT_STRENGTH_SCALE: f64 = 0.15; // Nm per firmware PID unit
pub const DEFAULT_TORQUE_LIMIT_NM: f64 = 2.0; // hard host-side clamp
pub const DEFAULT_MAX_TORQUE_PERMILLE: u16 = 700; // motor-side safety clamp
/// Coulomb friction compensation (Nm). A small torque applied in the
/// direction of motion to cancel the motor's mechanical drag. Applicable to
/// all non-Zero-G modes; the Zero-G mode uses its own adaptive velocity-hold
/// loop instead.
pub const DEFAULT_FRICTION_COMPENSATION: f64 = 0.03;

// ──────────────────── Zero-G (velocity-hold + friction cancellation) ──────────

/// Seed value for the Coulomb friction observer (Nm).  A reasonable starting
/// point for a HEX 4310/4342 gimbal motor; the observer adapts from here.
const ZERO_G_FRICTION_SEED: f64 = 0.05;

/// Maximum torque the zero-G loop may ever apply (Nm).
const ZERO_G_MAX_TORQUE: f64 = 0.2;

/// Per-tick velocity change threshold (rad/s per 1 ms tick) above which the
/// user is considered to be actively imparting torque.  During active input
/// the velocity-hold PI is paused and the observer adaptation is frozen so we
/// don't learn the user's force as "friction".
const ZERO_G_USER_ACCEL_THRESHOLD: f64 = 0.05;

/// Consecutive low-acceleration ticks before the velocity-hold PI engages
/// (50 ms at 1 kHz).  This prevents the PI from fighting the user's
/// intentional deceleration during a normal spin release.
const ZERO_G_COAST_TICKS: u32 = 50;

/// Velocity-hold proportional gain: Nm of torque per rad/s of velocity error.
/// Provides damping — a speed drop of 1 rad/s produces 0.5 Nm of restoring
/// torque.
const ZERO_G_VEL_HOLD_KP: f64 = 0.01;

/// Velocity-hold integral gain: Nm of torque per rad of accumulated position
/// error (the integral of velocity error).  Slowly trims out steady-state
/// offset so the held speed exactly matches the captured target.
const ZERO_G_VEL_HOLD_KI: f64 = 0.0;

/// Integral windup limit (Nm).  Prevents the I term from growing unbounded
/// while the user is actively overriding the knob.
const ZERO_G_VEL_HOLD_I_LIMIT: f64 = 0.08;

/// Velocity hysteresis: the shaft speed magnitude must exceed this threshold
/// (rad/s) before the friction-compensation sign is allowed to flip.  This
/// creates a deadband around zero crossing that eliminates the buzzy jitter
/// when the user holds the knob still.
const ZERO_G_SIGN_HYSTERESIS: f64 = 0.50;

/// Adaptation rate for the Coulomb friction observer (Nm per tick).  Single
/// symmetric rate — the old fast/slow two-stage scheme had an asymmetric
/// increase/decrease bias that caused the estimate to drift upward over time.
const ZERO_G_ADAPT_RATE: f64 = 0.0002;

// ───────────────────────────── presets (modes) ──────────────────────────────

const DEG: f64 = std::f64::consts::PI / 180.0;

/// One haptic preset — the equivalent of the firmware's `PB_SmartKnobConfig`.
/// Serialized to the UI so the mode buttons + dial stay in sync with the
/// backend.
#[derive(Debug, Clone, Serialize)]
pub struct KnobConfig {
    /// Initial logical position when this mode is selected.
    pub position: i32,
    pub min_position: i32,
    /// `max < min` ⇒ unbounded (free spin, no endstops).
    pub max_position: i32,
    /// Angular spacing between detents (radians).
    pub position_width_radians: f64,
    pub detent_strength_unit: f64,
    pub endstop_strength_unit: f64,
    /// Fraction of `position_width` you must pass before snapping (≥0.5).
    pub snap_point: f64,
    pub snap_point_bias: f64,
    /// If non-empty, only these positions have a detent (magnetic detents).
    pub detent_positions: Vec<i32>,
    /// Per-mode default click torque (Nm). When > 0, haptic clicks (biphasic
    /// torque pulses) fire on each detent transition instead of the classic
    /// D-gain damper.  Live-tunable per mode via [`Tuning::click_torque_nm`];
    /// this field seeds the initial value on first mode visit.
    pub click_torque_nm: f64,
    /// When `true`, an adaptive velocity-hold loop runs that observes the
    /// knob's natural deceleration and applies just enough torque to cancel
    /// mechanical drag — creating a "zero-G" weightless feel with no manual
    /// tuning required. The `friction_compensation` field is ignored for
    /// zero-G modes.
    pub zero_g: bool,
    /// Coulomb friction compensation (Nm). For non-Zero-G modes: a fixed
    /// torque in the direction of motion that helps cancel mechanical drag.
    /// Default per-mode; overridable live via tuning. Ignored when `zero_g`
    /// is true.
    pub friction_compensation: f64,
    /// Overall haptic strength (Nm per firmware PID-output unit). Per-mode
    /// default; overridable live via tuning. Higher = stronger detents /
    /// endstops.
    pub strength_scale: f64,
    /// Two-line label shown on the dial / mode button.
    pub text: String,
    /// Hue (0..255) for the dial accent — mirrors the firmware's LED hue.
    pub led_hue: i32,
}

/// The full demo set, ported 1:1 from `interface_task.cpp`.
pub fn preset_configs() -> Vec<KnobConfig> {
    let c = |position,
             min_position,
             max_position,
             width_deg: f64,
             detent_strength_unit,
             endstop_strength_unit,
             snap_point,
             snap_point_bias,
             detent_positions: &[i32],
             zero_g,
             click_torque_nm,
             friction_compensation,
             strength_scale,
             text: &str,
             led_hue| KnobConfig {
        position,
        min_position,
        max_position,
        position_width_radians: width_deg * DEG,
        detent_strength_unit,
        endstop_strength_unit,
        snap_point,
        snap_point_bias,
        detent_positions: detent_positions.to_vec(),
        zero_g,
        click_torque_nm,
        friction_compensation,
        strength_scale,
        text: text.to_string(),
        led_hue,
    };
    vec![
        // ── Zero-G: adaptive frictionless spin (no fixed compensation needed) ──
        c(0, 0, -1, 10.0, 0.0, 1.0, 1.1, 0.0, &[], true, 0.0, 0.0, 0.1, "Zero-G\nWeightless spin", 180),
        // ── classic presets ──
        c(0, 0, -1, 10.0, 0.0, 1.0, 1.1, 0.0, &[], false, 0.0, 0.09, 0.15, "Unbounded\nNo detents", 200),
        c(0, 0, 10, 10.0, 0.0, 1.0, 1.1, 0.0, &[], false, 0.0, 0.05, 0.25, "Bounded 0-10\nNo detents", 0),
        c(0, 0, 72, 10.0, 0.0, 1.0, 1.1, 0.0, &[], false, 0.0, 0.08, DEFAULT_STRENGTH_SCALE, "Multi-rev\nNo detents", 73),
        c(0, 0, 1, 60.0, 1.0, 1.0, 0.55, 0.0, &[], false, 0.0, 0.05, 0.25, "On/off\nStrong detent", 157),
        c(0, 0, 0, 60.0, 0.01, 0.6, 1.1, 0.0, &[], false, 0.0, DEFAULT_FRICTION_COMPENSATION, 0.05, "Return-to-center", 45),
        c(127, 0, 255, 1.0, 0.0, 1.0, 1.1, 0.0, &[], false, 0.0, 0.02, 0.3, "Fine values\nNo detents", 219),
        c(127, 0, 255, 1.0, 1.0, 1.0, 1.1, 0.0, &[], false, 0.37, DEFAULT_FRICTION_COMPENSATION, 0.25, "Fine values\nWith detents", 25),
        c(0, 0, 31, 8.225806452, 2.0, 1.0, 1.1, 0.0, &[], false, 0.0, 0.08, 0.75, "Coarse values\nStrong detents", 200),
        c(0, 0, 31, 8.225806452, 0.2, 1.0, 1.1, 0.0, &[], false, 1.20, 0.02, 1.5, "Coarse values\nWeak detents", 0),
        c(0, 0, 31, 7.0, 2.5, 1.0, 0.7, 0.0, &[2, 10, 21, 22], false, 0.0, 0.01, 0.8, "Magnetic detents", 73),
        c(0, -6, 6, 60.0, 1.0, 1.0, 0.55, 0.4, &[], false, 0.0, 0.02, 0.15, "Return-to-center\nwith detents", 157),
    ]
}

// ───────────────────────────── shared state ─────────────────────────────────

/// Live, host-tunable parameters (independent of the selected mode).
#[derive(Clone, Copy)]
struct Tuning {
    /// Proportional gain (firmware PID units). Replaces
    /// `config.detent_strength_unit * 4.0` when not at an endstop.
    /// Seeded from the active config on first mode visit.
    p_gain: f64,
    /// Derivative gain (firmware PID units). Replaces `derivative_gain(&config)`.
    /// Seeded from the active config on first mode visit.
    d_gain: f64,
    /// Nm per firmware PID-output unit (overall haptic strength).
    strength_scale: f64,
    /// Hard host-side torque clamp (Nm).
    torque_limit_nm: f64,
    /// Motor-side `0x6072` safety clamp (‰ of peak).
    max_torque_permille: u16,
    /// Coulomb friction compensation (Nm). Added in the direction of motion
    /// to cancel mechanical drag. Used by non-Zero-G modes; ignored when the
    /// active config has `zero_g = true`.
    friction_compensation: f64,
    /// Haptic click torque (Nm). When > 0 and the active config has
    /// `use_click = true`, a biphasic torque pulse fires on each detent
    /// transition.  Live-tunable; seeded from [`DEFAULT_CLICK_TORQUE_NM`]
    /// when the config first enables clicks.
    click_torque_nm: f64,
}

impl Default for Tuning {
    fn default() -> Self {
        Self {
            p_gain: 0.0,
            d_gain: 0.0,
            strength_scale: DEFAULT_STRENGTH_SCALE,
            torque_limit_nm: DEFAULT_TORQUE_LIMIT_NM,
            max_torque_permille: DEFAULT_MAX_TORQUE_PERMILLE,
            friction_compensation: 0.0,
            click_torque_nm: 0.0,
        }
    }
}

/// Snapshot handed to the frontend each poll.
#[derive(Debug, Clone, Default, Serialize)]
pub struct SmartKnobState {
    pub running: bool,
    /// Index into [`preset_configs`] currently active.
    pub config_index: usize,
    /// The active config (so the UI dial can draw detents/bounds).
    pub config: Option<KnobConfig>,
    /// Current logical position (detent index).
    pub current_position: i32,
    pub min_position: i32,
    pub max_position: i32,
    /// `0` = unbounded.
    pub num_positions: i32,
    /// Smooth pointer between detents: `-angle_to_detent_center / width`,
    /// in (−snap..+snap). Add to `current_position` for a continuous value.
    pub sub_position_unit: f64,
    /// Continuous shaft angle since start (radians) and its rev equivalent.
    pub shaft_angle_rad: f64,
    pub shaft_velocity_rev_per_s: f64,
    /// Torque we are commanding this tick (Nm) and what the motor reports.
    pub applied_torque_nm: f64,
    pub measured_torque_nm: Option<f32>,
    pub at_endstop: bool,
    // Motor health.
    pub node_id: u8,
    pub online: bool,
    pub enabled: bool,
    pub driver_temp_c: Option<f32>,
    pub motor_temp_c: Option<f32>,
    pub error: Option<String>,
    // Tuning echo.
    pub strength_scale: f64,
    pub torque_limit_nm: f64,
    pub max_torque_permille: u16,
    pub friction_compensation: f64,
    pub click_torque_nm: f64,
    pub p_gain: f64,
    pub d_gain: f64,
}

// ───────────────────────────── the driver ───────────────────────────────────

/// A running SmartKnob: owns the high-rate haptic loop for one motor.
pub struct SmartKnob {
    node_id: u8,
    /// Index of the requested config; the loop picks it up and applies it.
    requested_config: Arc<StdMutex<usize>>,
    tuning: Arc<StdMutex<Tuning>>,
    /// Per-mode tuning overrides — one entry per preset.  When the user adjusts
    /// the sliders we write into this slot; on mode switch we restore from it.
    /// Initialised from each preset's defaults, so a never-touched mode keeps
    /// its stock feel.
    per_mode_tuning: Arc<StdMutex<Vec<Tuning>>>,
    state: Arc<StdMutex<SmartKnobState>>,
    running: Arc<AtomicBool>,
    task: JoinHandle<()>,
}

/// How many times to attempt motor init before giving up (init can be flaky).
const INIT_ATTEMPTS: u8 = 3;

impl SmartKnob {
    /// Initialize the chosen motor for MIT torque-stream control and start the
    /// haptic loop. The manager must already be connected with heartbeat on.
    pub async fn start(
        mgr: Arc<Cia402Manager>,
        nid: u8,
        config_index: usize,
    ) -> anyhow::Result<Self> {
        let configs = preset_configs();
        let config_index = config_index.min(configs.len() - 1);
        let bus = mgr.bus();
        let sdo_timeout = Some(mgr.options().sdo_timeout);
        let mut tuning = Tuning::default();
        // Seed live tunables from the selected preset so the sliders show the
        // preset's defaults on start.
        tuning.friction_compensation = configs[config_index].friction_compensation;
        tuning.strength_scale = configs[config_index].strength_scale;
        tuning.p_gain = configs[config_index].detent_strength_unit * 4.0;
        tuning.d_gain = derivative_gain(&configs[config_index]);
        tuning.click_torque_nm = configs[config_index].click_torque_nm;

        
        // 对特殊模式覆盖 p_gain / d_gain
        // let idx = config_index;
        // Per-motor init, retried — same recovery dance as HopeA3.
        let mut last_err = None;
        for attempt in 1..=INIT_ATTEMPTS {
            match init_motor(&mgr, &bus, sdo_timeout, nid, tuning.max_torque_permille).await {
                Ok(()) => {
                    log::info!("SmartKnob: motor 0x{nid:02X} ready (attempt {attempt})");
                    last_err = None;
                    break;
                }
                Err(e) => {
                    log::warn!("SmartKnob: init 0x{nid:02X} attempt {attempt}/{INIT_ATTEMPTS}: {e}");
                    last_err = Some(e);
                    let _ = mgr.clear_error(nid).await;
                    tokio::time::sleep(Duration::from_millis(300)).await;
                }
            }
        }
        if let Some(e) = last_err {
            return Err(e.context(format!("motor 0x{nid:02X} failed after {INIT_ATTEMPTS} attempts")));
        }

        // Per-mode tuning, seeded from each preset's defaults.
        let mut per_mode_tuning: Vec<Tuning> = configs
            .iter()
            .map(|c| Tuning {
                strength_scale: c.strength_scale,
                torque_limit_nm: DEFAULT_TORQUE_LIMIT_NM,
                max_torque_permille: DEFAULT_MAX_TORQUE_PERMILLE,
                friction_compensation: c.friction_compensation,
                p_gain: c.detent_strength_unit * 4.0,
                d_gain: derivative_gain(c),
                click_torque_nm: c.click_torque_nm,
            })
            .collect();

        // Add the following coverage: Directly modify the values for the special mode
        // The mode index corresponds to the sequence of the preset_configs():
        

        let per_mode_tuning = Arc::new(StdMutex::new(per_mode_tuning));

        let requested_config = Arc::new(StdMutex::new(config_index));
        let tuning = Arc::new(StdMutex::new(tuning));
        let state = Arc::new(StdMutex::new(SmartKnobState {
            node_id: nid,
            config_index,
            ..Default::default()
        }));
        let running = Arc::new(AtomicBool::new(true));

        let task = {
            let mgr = mgr.clone();
            let bus = bus.clone();
            let requested_config = requested_config.clone();
            let tuning = tuning.clone();
            let per_mode_tuning = per_mode_tuning.clone();
            let state = state.clone();
            let running = running.clone();
            tokio::spawn(async move {
                haptic_loop(
                    mgr, bus, nid, requested_config, tuning, per_mode_tuning, state, running,
                )
                .await;
            })
        };

        Ok(Self {
            node_id: nid,
            requested_config,
            tuning,
            per_mode_tuning,
            state,
            running,
            task,
        })
    }

    /// Switch haptic mode (the front-panel "mode" button that stands in for the
    /// missing press sensor). Clamped to the preset range.
    pub fn set_config(&self, index: usize) {
        let max = preset_configs().len().saturating_sub(1);
        *self.requested_config.lock().unwrap() = index.min(max);
    }

    /// Update live haptic tunables.  Persists into the per-mode slot for the
    /// currently-active config so the tuned values survive a mode round-trip.
    pub fn set_tuning(
        &self,
        p_gain: f64,
        d_gain: f64,
        strength_scale: f64,
        torque_limit_nm: f64,
        max_torque_permille: u16,
        friction_compensation: f64,
        click_torque_nm: f64,
    ) {
        let clamped = Tuning {
            p_gain: p_gain.max(0.0),
            d_gain: d_gain.max(0.0),
            strength_scale: strength_scale.max(0.0),
            torque_limit_nm: torque_limit_nm.max(0.0),
            max_torque_permille: max_torque_permille.min(1000),
            friction_compensation: friction_compensation.max(0.0),
            click_torque_nm: click_torque_nm.max(0.0),
        };
        *self.tuning.lock().unwrap() = clamped;
        // Persist into the per-mode slot for the current config.
        let idx = *self.requested_config.lock().unwrap();
        if let Some(slot) = self.per_mode_tuning.lock().unwrap().get_mut(idx) {
            *slot = clamped;
        }
    }

    pub fn state(&self) -> SmartKnobState {
        self.state.lock().unwrap().clone()
    }

    pub fn node_id(&self) -> u8 {
        self.node_id
    }

    /// Stop the loop, zero torque and disable the motor.
    pub async fn stop(self, mgr: &Cia402Manager) {
        self.running.store(false, Ordering::SeqCst);
        let _ = self.task.await;
        if let Err(e) = mgr.disable(self.node_id).await {
            log::warn!("SmartKnob: disable 0x{:02X} on stop: {e}", self.node_id);
        }
    }
}

/// Best-effort fault clear (so the user can recover without leaving the panel).
pub async fn clear_error(mgr: &Cia402Manager, nid: u8) {
    if let Err(e) = mgr.clear_error(nid).await {
        log::warn!("SmartKnob: clear_error 0x{nid:02X}: {e}");
    }
}

/// Initialize one motor: CiA402 init, remap RPDO1 to the MIT torque-stream
/// frame, zero the static MIT params (PDES/VDES/KP — we only stream TFF), set
/// max torque, switch to MIT mode (which enables).
async fn init_motor(
    mgr: &Cia402Manager,
    bus: &Arc<dyn can_transport::CanBus>,
    sdo_timeout: Option<Duration>,
    nid: u8,
    max_torque: u16,
) -> anyhow::Result<()> {
    mgr.initialize(nid)
        .await
        .map_err(|e| anyhow::anyhow!("initialize: {e}"))?;

    let recipe = RpdoRecipe {
        rpdo_index: 0,
        cob_id: rpdo_cob_id(nid),
        entries: vec![
            TpdoEntry { index: OD_MIT, subindex: MIT_SUB_TFF, bit_len: 32 }, // torque FF
            TpdoEntry { index: OD_MIT, subindex: MIT_SUB_KD, bit_len: 16 },  // KD
            TpdoEntry { index: OD_MAX_TORQUE, subindex: 0, bit_len: 16 },    // max torque
        ],
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

    // Zero everything but TFF: PDES, VDES, KP. (KD is streamed, default 0.)
    sdo::download_f32(&**bus, nid, OD_MIT, MIT_SUB_PDES, 0.0, sdo_timeout)
        .await
        .map_err(|e| anyhow::anyhow!("zero PDES: {e}"))?;
    sdo::download_f32(&**bus, nid, OD_MIT, MIT_SUB_VDES, 0.0, sdo_timeout)
        .await
        .map_err(|e| anyhow::anyhow!("zero VDES: {e}"))?;
    sdo::download_u16(&**bus, nid, OD_MIT, MIT_SUB_KP, 0, sdo_timeout)
        .await
        .map_err(|e| anyhow::anyhow!("zero KP: {e}"))?;

    mgr.set_max_torque(nid, max_torque)
        .await
        .map_err(|e| anyhow::anyhow!("set_max_torque: {e}"))?;
    mgr.set_mode(nid, MotorMode::Mit)
        .await
        .map_err(|e| anyhow::anyhow!("set_mode MIT: {e}"))?;
    Ok(())
}

// ───────────────────────────── the haptic loop ──────────────────────────────

/// Mutable per-tick haptic state (the firmware's locals, hoisted into a struct).
struct Haptic {
    /// Continuous (unwrapped) shaft angle, radians.
    shaft_angle: f64,
    /// Detent center the knob is currently snapped to, radians.
    detent_center: f64,
    current_position: i32,
    /// Smoothed |velocity| for idle detection (rad/s).
    idle_velocity_ewma: f64,
    last_idle_start: Option<Instant>,
    latest_sub_position_unit: f64,
    /// Continuous (unwrapped) revolution accumulator.
    accum_rev: f64,
    /// Last *wrapped* sensor reading (revolutions), for delta unwrapping.
    prev_raw_rev: Option<f64>,
    // ── Zero-G velocity-hold + adaptive friction observer ──
    /// Estimated Coulomb friction magnitude (Nm).  The observer watches
    /// |v| decay during coasting and adapts until the decay stops — at
    /// which point friction is exactly cancelled.
    friction_observer: f64,
    /// Velocity target captured when the user releases the knob (rad/s).
    zero_g_target_velocity: f64,
    /// Integral accumulator for the velocity-hold PI loop (Nm).
    zero_g_vel_integral: f64,
    /// Consecutive ticks with acceleration below the user-activity threshold.
    zero_g_coast_ticks: u32,
    /// Last sign of the friction-compensation torque (for hysteresis).
    zero_g_last_friction_sign: f64,
    /// Shaft velocity from the *previous* tick (rad/s).
    prev_velocity_rad_s: f64,
    // ── Haptic click state (fine detents) ──
    /// Logical position at the *previous* tick, used to detect detent
    /// transitions and trigger a click.
    prev_current_position: i32,
    /// Remaining ticks in the current click sequence (counts down to 0).
    click_ticks_remaining: u32,
    /// Sign of the first phase of the *next* click (±1).  Flips after each
    /// triggered click so alternating detent transitions feel symmetric.
    click_dir: f64,
}

async fn haptic_loop(
    mgr: Arc<Cia402Manager>,
    bus: Arc<dyn can_transport::CanBus>,
    nid: u8,
    requested_config: Arc<StdMutex<usize>>,
    tuning: Arc<StdMutex<Tuning>>,
    per_mode_tuning: Arc<StdMutex<Vec<Tuning>>>,
    state: Arc<StdMutex<SmartKnobState>>,
    running: Arc<AtomicBool>,
) {
    let configs = preset_configs();
    let period = Duration::from_micros(1_000_000 / CONTROL_HZ);
    let mut tick = tokio::time::interval(period);
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

    let mut active_index = usize::MAX; // force first-tick config apply
    let mut config = configs[0].clone();
    let mut h = Haptic {
        shaft_angle: 0.0,
        detent_center: 0.0,
        current_position: 0,
        idle_velocity_ewma: 0.0,
        last_idle_start: None,
        latest_sub_position_unit: 0.0,
        accum_rev: 0.0,
        prev_raw_rev: None,
        friction_observer: ZERO_G_FRICTION_SEED,
        zero_g_target_velocity: 0.0,
        zero_g_vel_integral: 0.0,
        zero_g_coast_ticks: 0,
        zero_g_last_friction_sign: 0.0,
        prev_velocity_rad_s: 0.0,
        prev_current_position: configs[0].position,
        click_ticks_remaining: 0,
        click_dir: 1.0,
    };

    while running.load(Ordering::SeqCst) {
        tick.tick().await;
        let mut tun = *tuning.lock().unwrap();

        // ── read feedback; unwrap to a continuous shaft angle ──
        let ls = mgr.status(nid);
        let m = &ls.measurements;
        let raw_rev = m.position_rev.unwrap_or(0.0) as f64;
        match h.prev_raw_rev {
            None => h.accum_rev = raw_rev,
            Some(prev) => {
                let mut d = raw_rev - prev;
                if d > 0.5 {
                    d -= 1.0;
                } else if d < -0.5 {
                    d += 1.0;
                }
                h.accum_rev += d;
            }
        }
        h.prev_raw_rev = Some(raw_rev);
        h.shaft_angle = DIRECTION * h.accum_rev * std::f64::consts::TAU;
        let velocity_rad_s = DIRECTION * m.velocity_rev_per_s.unwrap_or(0.0) as f64 * std::f64::consts::TAU;

        let (enabled, error) = match ls.logic.as_ref() {
            Some(Logic::Enabled(_)) => (true, None),
            Some(Logic::Error { kind, raw_code }) => (false, Some(format!("{kind:?} (0x{raw_code:04X})"))),
            _ => (false, None),
        };

        // ── apply a pending mode switch ──
        let wanted = (*requested_config.lock().unwrap()).min(configs.len() - 1);
        if wanted != active_index {
            config = configs[wanted].clone();
            active_index = wanted;
            // Recenter on the new mode (firmware: position change + detent recenter).
            h.current_position = config.position;
            if config.min_position <= config.max_position {
                h.current_position = h.current_position.clamp(config.min_position, config.max_position);
            }
            // Place the detent center at the current shaft angle so the knob
            // doesn't jump, biased by the configured sub-position (0 here).
            h.detent_center = h.shaft_angle;
            h.last_idle_start = None;
            h.prev_current_position = h.current_position;
            h.click_ticks_remaining = 0;
            h.click_dir = 1.0;
            // Restore per-mode tuning (user-tweaked values, or preset defaults on
            // first visit).  Also write them back into the shared Tuning so the
            // frontend sees the restored values on the next poll.
            let saved = {
                let pmt = per_mode_tuning.lock().unwrap();
                pmt[wanted]
            };
            tun.strength_scale = saved.strength_scale;
            tun.torque_limit_nm = saved.torque_limit_nm;
            tun.max_torque_permille = saved.max_torque_permille;
            tun.friction_compensation = saved.friction_compensation;
            tun.click_torque_nm = saved.click_torque_nm;
            tun.p_gain = saved.p_gain;
            tun.d_gain = saved.d_gain;
            *tuning.lock().unwrap() = saved;
            // Reset the friction observer and velocity-hold state when switching modes.
            h.friction_observer = config.friction_compensation.max(ZERO_G_FRICTION_SEED);
            h.zero_g_target_velocity = 0.0;
            h.zero_g_vel_integral = 0.0;
            h.zero_g_coast_ticks = 0;
            h.zero_g_last_friction_sign = 0.0;
        }

        // ── idle re-centering (drift the center toward rest when stationary) ──
        // Skip for single-detent (return-to-center) modes: the detent center
        // must stay anchored at the absolute zero so the knob always returns
        // to the same position.  Idle re-centering would drift the reference
        // toward wherever friction happened to stop the knob.
        let num_positions = config.max_position - config.min_position + 1;
        if num_positions != 1 {
            h.idle_velocity_ewma = velocity_rad_s.abs() * IDLE_VELOCITY_EWMA_ALPHA
                + h.idle_velocity_ewma * (1.0 - IDLE_VELOCITY_EWMA_ALPHA);
            if h.idle_velocity_ewma > IDLE_VELOCITY_RAD_PER_SEC {
                h.last_idle_start = None;
            } else if h.last_idle_start.is_none() {
                h.last_idle_start = Some(Instant::now());
            }
            if let Some(start) = h.last_idle_start {
                if start.elapsed() > IDLE_CORRECTION_DELAY
                    && (h.shaft_angle - h.detent_center).abs() < IDLE_CORRECTION_MAX_ANGLE_RAD
                {
                    h.detent_center = h.shaft_angle * IDLE_CORRECTION_RATE_ALPHA
                        + h.detent_center * (1.0 - IDLE_CORRECTION_RATE_ALPHA);
                }
            }
        }

        // ── snap-to-detent state machine (firmware verbatim) ──
        let width = config.position_width_radians;
        let mut angle_to_detent_center = h.shaft_angle - h.detent_center;

        let snap_point_radians = width * config.snap_point;
        let bias_radians = width * config.snap_point_bias;
        let snap_dec = snap_point_radians + if h.current_position <= 0 { bias_radians } else { -bias_radians };
        let snap_inc = -snap_point_radians + if h.current_position >= 0 { -bias_radians } else { bias_radians };

        if angle_to_detent_center > snap_dec
            && (num_positions <= 0 || h.current_position > config.min_position)
        {
            h.detent_center += width;
            angle_to_detent_center -= width;
            h.current_position -= 1;
        } else if angle_to_detent_center < snap_inc
            && (num_positions <= 0 || h.current_position < config.max_position)
        {
            h.detent_center -= width;
            angle_to_detent_center += width;
            h.current_position += 1;
        }

        h.latest_sub_position_unit = -angle_to_detent_center / width;

        let dead_zone_adjustment = angle_to_detent_center.clamp(
            (-width * DEAD_ZONE_DETENT_PERCENT).max(-DEAD_ZONE_RAD),
            (width * DEAD_ZONE_DETENT_PERCENT).min(DEAD_ZONE_RAD),
        );

        let out_of_bounds = num_positions > 0
            && ((angle_to_detent_center > 0.0 && h.current_position == config.min_position)
                || (angle_to_detent_center < 0.0 && h.current_position == config.max_position));

        // P/D gains.  User-tunable for normal (non-endstop) operation;
        // endstop always uses the hardcoded config strength so boundaries
        // stay firm regardless of the feel tuning.
        let p_gain = if out_of_bounds {
            config.endstop_strength_unit * 4.0
        } else {
            tun.p_gain
        };
        let d_gain = tun.d_gain;

        // ── haptic click: inject a brief torque burst on detent transition ──
        // When the user-tunable `click_torque_nm` is > 0, we play a short
        // biphasic torque pulse — a "click" — whenever the logical position
        // changes.  Direction alternates so clockwise and counter-clockwise
        // transitions both feel like a crisp detent.  Works for any detent width.
        let click_active = tun.click_torque_nm > 0.0
            && !out_of_bounds
            && config.detent_positions.is_empty();
        if click_active && h.current_position != h.prev_current_position {
            h.prev_current_position = h.current_position;
            h.click_ticks_remaining = CLICK_TICKS_PER_PHASE * 2;
            h.click_dir = -h.click_dir;
        }

        // ── compute the haptic (PID) torque ──
        let haptic_component = if velocity_rad_s.abs() > MAX_VEL_RAD_S {
            0.0 // runaway guard
        } else {
            let mut input = -angle_to_detent_center + dead_zone_adjustment;
            // Magnetic detents: no spring unless we're at a listed position.
            if !out_of_bounds && !config.detent_positions.is_empty() {
                if !config.detent_positions.contains(&h.current_position) {
                    input = 0.0;
                }
            }
            let pid = (p_gain * input - d_gain * velocity_rad_s).clamp(-PID_LIMIT, PID_LIMIT);
            tun.strength_scale * pid
        };

        // ── minimum restoring torque for single-detent (return-to-center) ──
        // The dead zone (±20% of width, i.e. ±12° for the 60° preset) creates
        // a flat region where the spring torque is zero.  Static friction can
        // trap the knob anywhere inside that region.  A small directional
        // torque floor pushes through stiction and brings the knob to true
        // center.  Only active when nearly stationary and within the dead zone.
        let min_restoring = if num_positions == 1 {
            let abs_angle = angle_to_detent_center.abs();
            let dead_zone = (width * DEAD_ZONE_DETENT_PERCENT).min(DEAD_ZONE_RAD);
            if abs_angle > 0.0005
                && abs_angle < dead_zone
                && velocity_rad_s.abs() < IDLE_VELOCITY_RAD_PER_SEC
            {
                (-angle_to_detent_center).signum() * 0.00
            } else {
                0.0
            }
        } else {
            0.0
        };

        // ── friction compensation (two paths) ──
        let friction_torque = if config.zero_g {
            // ── Zero-G: velocity-hold PI + adaptive friction cancellation ──
            //
            // Phase 1 — user interaction: pure feed-forward friction
            // compensation.  The observer adapts while the knob coasts, but
            // pauses during active user input so we don't learn the user's
            // force as "friction".
            //
            // Phase 2 — coasting (velocity-hold): once the user has released
            // the knob for ~50 ms, a PI controller engages that maintains the
            // captured velocity — emulating Newton's first law (zero friction
            // → constant speed).  The integral term slowly trims out the
            // remaining offset so the held speed matches the target exactly.
            //
            // A sign hysteresis deadband around zero crossing prevents the
            // buzzy jitter that the old instantaneous sign() flip produced
            // when the user grabbed the knob to stop it.
            if velocity_rad_s.abs() > IDLE_VELOCITY_RAD_PER_SEC {
                let abs_v = velocity_rad_s.abs();
                let vel_delta = (velocity_rad_s - h.prev_velocity_rad_s).abs();
                let user_active = vel_delta > ZERO_G_USER_ACCEL_THRESHOLD;

                // ── coasting detection & velocity capture ──
                if user_active {
                    h.zero_g_target_velocity = velocity_rad_s;
                    h.zero_g_vel_integral = 0.0;
                    h.zero_g_coast_ticks = 0;
                } else {
                    h.zero_g_coast_ticks += 1;
                }

                // ── velocity ceiling (runaway guard — also covers friction) ──
                if abs_v > MAX_VEL_RAD_S {
                    h.zero_g_vel_integral = 0.0;
                    h.zero_g_coast_ticks = 0;
                    0.0
                } else if h.zero_g_coast_ticks > ZERO_G_COAST_TICKS {
                    // ── Phase 2: velocity-hold PI — maintain captured speed ──
                    let error = h.zero_g_target_velocity - velocity_rad_s;
                    h.zero_g_vel_integral = (h.zero_g_vel_integral
                        + error * ZERO_G_VEL_HOLD_KI)
                        .clamp(-ZERO_G_VEL_HOLD_I_LIMIT, ZERO_G_VEL_HOLD_I_LIMIT);
                    let hold_torque =
                        ZERO_G_VEL_HOLD_KP * error + h.zero_g_vel_integral;

                    // ── friction observer adaptation (symmetric, coasting only) ──
                    if haptic_component.abs() < 0.001 {
                        if abs_v < h.prev_velocity_rad_s.abs() - 0.0005 {
                            // Speed decaying → friction > estimate → increase.
                            h.friction_observer = (h.friction_observer
                                + ZERO_G_ADAPT_RATE)
                                .min(ZERO_G_MAX_TORQUE);
                        } else if abs_v > h.prev_velocity_rad_s.abs() + 0.0005 {
                            // Speed increasing → over-compensating → decrease.
                            h.friction_observer = (h.friction_observer
                                - ZERO_G_ADAPT_RATE)
                                .max(0.0);
                        }
                        // else: |v| stable → estimate is correct — hold.
                    }

                    // ── sign hysteresis ──
                    if velocity_rad_s > ZERO_G_SIGN_HYSTERESIS {
                        h.zero_g_last_friction_sign = 1.0;
                    } else if velocity_rad_s < -ZERO_G_SIGN_HYSTERESIS {
                        h.zero_g_last_friction_sign = -1.0;
                    }
                    // else: keep last sign (deadband — prevents jitter on stop)

                    let friction_ff =
                        h.friction_observer * h.zero_g_last_friction_sign;
                    (friction_ff + hold_torque)
                        .clamp(-ZERO_G_MAX_TORQUE, ZERO_G_MAX_TORQUE)
                } else {
                    // ── Phase 1: user recently interacted — pure feed-forward ──
                    h.zero_g_vel_integral = 0.0;
                    h.friction_observer * velocity_rad_s.signum()
                }
            } else {
                // Stationary — zero torque, reset PI state.
                h.zero_g_vel_integral = 0.0;
                h.zero_g_coast_ticks = 0;
                h.zero_g_last_friction_sign = 0.0;
                0.0
            }
        } else {
            // ── fixed Coulomb friction compensation ──
            // A user-tunable torque in the direction of motion. Uses a smooth
            // `atan` taper so it engages gently above the idle threshold.
            if velocity_rad_s.abs() > IDLE_VELOCITY_RAD_PER_SEC {
                let taper = (velocity_rad_s.abs() / (IDLE_VELOCITY_RAD_PER_SEC * 10.0)).atan()
                    / std::f64::consts::FRAC_PI_2;
                tun.friction_compensation * velocity_rad_s.signum() * taper
            } else {
                0.0
            }
        };

        h.prev_velocity_rad_s = velocity_rad_s;

        // ── compute click torque ──
        let click_torque = if click_active && h.click_ticks_remaining > 0 {
            h.click_ticks_remaining -= 1;
            // Phase 1: first direction; Phase 2: reverse.
            let phase = h.click_ticks_remaining / CLICK_TICKS_PER_PHASE;
            let sign = if phase == 1 { h.click_dir } else { -h.click_dir };
            sign * tun.click_torque_nm
        } else {
            0.0
        };

        let torque_nm = (haptic_component + click_torque + min_restoring + friction_torque)
            .clamp(-tun.torque_limit_nm, tun.torque_limit_nm);
        let torque_cmd = (DIRECTION * torque_nm) as f32;

        // ── stream RPDO frame: TFF(f32) + KD(u16=0) + max torque(u16) ──
        let mut data = [0u8; FRAME_LEN];
        data[0..4].copy_from_slice(&torque_cmd.to_le_bytes());
        data[4..6].copy_from_slice(&0u16.to_le_bytes());
        data[6..8].copy_from_slice(&tun.max_torque_permille.to_le_bytes());
        match CanFrame::new_fd(rpdo_cob_id(nid), &data, true) {
            Ok(frame) => {
                if let Err(e) = bus.send(frame).await {
                    log::warn!("SmartKnob: RPDO send failed: {e}");
                }
            }
            Err(e) => log::error!("SmartKnob: build RPDO frame: {e}"),
        }

        // ── publish state ──
        {
            let mut s = state.lock().unwrap();
            s.running = true;
            s.config_index = active_index;
            s.config = Some(config.clone());
            s.current_position = h.current_position;
            s.min_position = config.min_position;
            s.max_position = config.max_position;
            s.num_positions = if num_positions > 0 { num_positions } else { 0 };
            s.sub_position_unit = h.latest_sub_position_unit;
            s.shaft_angle_rad = h.shaft_angle;
            s.shaft_velocity_rev_per_s = velocity_rad_s / std::f64::consts::TAU;
            s.applied_torque_nm = torque_nm;
            s.measured_torque_nm = m.torque_nm;
            s.at_endstop = out_of_bounds;
            s.node_id = nid;
            s.online = ls.connection.online;
            s.enabled = enabled;
            s.driver_temp_c = m.driver_temp_c;
            s.motor_temp_c = m.motor_temp_c;
            s.error = error;
            s.strength_scale = tun.strength_scale;
            s.torque_limit_nm = tun.torque_limit_nm;
            s.max_torque_permille = tun.max_torque_permille;
            s.friction_compensation = tun.friction_compensation;
            s.click_torque_nm = tun.click_torque_nm;
            s.p_gain = tun.p_gain;
            s.d_gain = tun.d_gain;
        }
    }

    state.lock().unwrap().running = false;
    log::info!("SmartKnob: haptic loop stopped");
}

/// Firmware's width-dependent derivative gain (creates "clicks" on fine
/// detents, kept small on coarse ones; disabled for magnetic detents).
///
/// Returns 0 when the config enables [`KnobConfig::use_click`] (the haptic
/// click pulse train replaces D-gain damping, avoiding the sensor noise
/// amplification that the original firmware's TODO flagged).  Also returns 0
/// for very fine detents (width ≤ [`CLICK_WIDTH_THRESHOLD_RAD`]) as a
/// fallback for modes that have detents but don't opt into clicks.
fn derivative_gain(config: &KnobConfig) -> f64 {
    if !config.detent_positions.is_empty() {
        return 0.0;
    }
    if config.click_torque_nm > 0.0 || config.position_width_radians < CLICK_WIDTH_THRESHOLD_RAD {
        return 0.0;
    }
    let lower = config.detent_strength_unit * 0.08; // at 3°
    let upper = config.detent_strength_unit * 0.02; // at 8°
    let w_lower = 3.0 * DEG;
    let w_upper = 8.0 * DEG;
    let raw = lower + (upper - lower) / (w_upper - w_lower) * (config.position_width_radians - w_lower);
    raw.clamp(lower.min(upper), lower.max(upper))
}
