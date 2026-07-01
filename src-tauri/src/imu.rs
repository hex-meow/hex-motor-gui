//! IMU device manager — host side of the hex-meow IMU.
//!
//! The IMU is a raw-CANopen *telemetry* device. It is discovered by the same
//! heartbeat sweep as motors (it heartbeats every 500 ms), so it shows up in
//! `list_devices` with its `0x1018` identity; the [`device_registry`] routes it
//! here. Unlike SmartKnob/HopeA3 we don't *drive* it — we:
//!   1. put it Operational with an NMT Start so it begins streaming,
//!   2. subscribe to its TPDO1 (COB-ID `0x180+nid`, a 26-byte CAN-FD frame
//!      carrying quaternion + accel + gyro + temp + counter),
//!   3. publish a snapshot the UI polls,
//! and expose bias-trim / yaw-reset as SDO writes to `0x3200`.
//!
//! [`device_registry`]: crate::device_registry

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use can_transport::{CanBus, CanFilter, CanFrame, CanRx};
use hex_motor::canopen::sdo;
use hex_motor::cia402::Cia402Manager;
use serde::Serialize;
use tokio::task::JoinHandle;

/// Command object: `0x3200:01` = still gyro-bias trim, `0x3200:02` = yaw reset.
const CMD_INDEX: u16 = 0x3200;
const CMD_SUB_BIAS_TRIM: u8 = 0x01;
const CMD_SUB_YAW_RESET: u8 = 0x02;

/// If no TPDO1 arrives within this window, flag the device offline (the last
/// values are kept so the UI doesn't flicker to zero).
const RX_TIMEOUT: Duration = Duration::from_millis(300);

/// TPDO1 COB-ID for a node: `0x180 + node-id`.
fn tpdo1_cob_id(nid: u8) -> u16 {
    0x180 + nid as u16
}

/// Snapshot handed to the frontend each poll.
#[derive(Debug, Clone, Default, Serialize)]
pub struct ImuState {
    pub node_id: u8,
    pub online: bool,
    /// Orientation `[w, x, y, z]` (unit quaternion, local→sensor).
    pub quaternion: [f32; 4],
    /// Acceleration `[x, y, z]` in g.
    pub accel: [f32; 3],
    /// Angular rate `[x, y, z]` in deg/s.
    pub gyro: [f32; 3],
    /// Die temperature in °C.
    pub temp_c: f32,
    /// Device sample counter (increments at the device fusion rate).
    pub counter: u32,
}

/// A running IMU session: owns the TPDO1 receive loop for one node.
pub struct ImuManager {
    node_id: u8,
    bus: Arc<dyn CanBus>,
    sdo_timeout: Option<Duration>,
    state: Arc<StdMutex<ImuState>>,
    running: Arc<AtomicBool>,
    task: JoinHandle<()>,
}

impl ImuManager {
    /// Subscribe to the IMU's TPDO1, put it Operational, and start streaming.
    pub async fn start(mgr: Arc<Cia402Manager>, nid: u8) -> anyhow::Result<Self> {
        let bus = mgr.bus();
        let sdo_timeout = Some(mgr.options().sdo_timeout);

        // Subscribe *before* enabling so we don't miss the first frames.
        let rx = bus
            .subscribe(CanFilter::exact_standard(tpdo1_cob_id(nid)))
            .await
            .map_err(|e| anyhow::anyhow!("subscribe TPDO1: {e}"))?;

        // NMT Start → Operational: the device begins streaming TPDO1.
        send_nmt(&bus, 0x01, nid).await?;

        let state = Arc::new(StdMutex::new(ImuState {
            node_id: nid,
            ..Default::default()
        }));
        let running = Arc::new(AtomicBool::new(true));

        let task = {
            let state = state.clone();
            let running = running.clone();
            tokio::spawn(async move { rx_loop(rx, nid, state, running).await })
        };

        log::info!("IMU 0x{nid:02X}: streaming TPDO1 on COB-ID 0x{:03X}", tpdo1_cob_id(nid));
        Ok(Self {
            node_id: nid,
            bus,
            sdo_timeout,
            state,
            running,
            task,
        })
    }

    pub fn state(&self) -> ImuState {
        self.state.lock().unwrap().clone()
    }

    pub fn node_id(&self) -> u8 {
        self.node_id
    }

    /// Trigger a still gyro-bias calibration (hold the device motionless).
    pub async fn bias_trim(&self) -> anyhow::Result<()> {
        sdo::download_u8(
            &*self.bus,
            self.node_id,
            CMD_INDEX,
            CMD_SUB_BIAS_TRIM,
            1,
            self.sdo_timeout,
        )
        .await
        .map_err(|e| anyhow::anyhow!("bias trim: {e}"))
    }

    /// Zero the yaw (re-level from gravity).
    pub async fn yaw_reset(&self) -> anyhow::Result<()> {
        sdo::download_u8(
            &*self.bus,
            self.node_id,
            CMD_INDEX,
            CMD_SUB_YAW_RESET,
            1,
            self.sdo_timeout,
        )
        .await
        .map_err(|e| anyhow::anyhow!("yaw reset: {e}"))
    }

    /// Stop the receive loop and put the device back to Pre-Operational.
    pub async fn stop(self) {
        self.running.store(false, Ordering::SeqCst);
        let _ = self.task.await;
        // Be polite: NMT "enter pre-operational" stops the TPDO stream.
        if let Err(e) = send_nmt(&self.bus, 0x80, self.node_id).await {
            log::warn!("IMU 0x{:02X}: NMT pre-op on stop: {e}", self.node_id);
        }
    }
}

/// Send an NMT node-control command. `cs`: 0x01 start, 0x80 enter
/// pre-operational, 0x02 stop, 0x81 reset node, 0x82 reset comms.
async fn send_nmt(bus: &Arc<dyn CanBus>, cs: u8, nid: u8) -> anyhow::Result<()> {
    let frame = CanFrame::new_data(0x000u16, &[cs, nid])
        .map_err(|e| anyhow::anyhow!("build NMT frame: {e}"))?;
    bus.send(frame)
        .await
        .map_err(|e| anyhow::anyhow!("send NMT: {e}"))
}

async fn rx_loop(
    mut rx: Box<dyn CanRx>,
    nid: u8,
    state: Arc<StdMutex<ImuState>>,
    running: Arc<AtomicBool>,
) {
    while running.load(Ordering::SeqCst) {
        match tokio::time::timeout(RX_TIMEOUT, rx.recv()).await {
            Ok(Ok(frame)) => {
                if let Some(parsed) = parse_tpdo1(nid, frame.data()) {
                    *state.lock().unwrap() = parsed;
                }
            }
            Ok(Err(e)) => {
                log::warn!("IMU 0x{nid:02X}: rx closed: {e}");
                break;
            }
            Err(_) => {
                // No frame within the window: stale → offline, keep last values.
                state.lock().unwrap().online = false;
            }
        }
    }
    state.lock().unwrap().online = false;
    log::info!("IMU 0x{nid:02X}: rx loop stopped");
}

/// Decode the 26-byte little-endian TPDO1 payload (see the IMU firmware's
/// `docs/canopen-od-design.md`). Returns `None` if the frame is too short.
fn parse_tpdo1(nid: u8, d: &[u8]) -> Option<ImuState> {
    if d.len() < 26 {
        return None;
    }
    let i16le = |o: usize| i16::from_le_bytes([d[o], d[o + 1]]) as f32;
    Some(ImuState {
        node_id: nid,
        online: true,
        // q0..q3 are i16 × 10000.
        quaternion: [
            i16le(0) / 10000.0,
            i16le(2) / 10000.0,
            i16le(4) / 10000.0,
            i16le(6) / 10000.0,
        ],
        // accel i16 in mg → g.
        accel: [i16le(8) / 1000.0, i16le(10) / 1000.0, i16le(12) / 1000.0],
        // gyro i16 in 0.1 deg/s → deg/s.
        gyro: [i16le(14) / 10.0, i16le(16) / 10.0, i16le(18) / 10.0],
        // temperature i16 in 0.01 °C → °C.
        temp_c: i16le(20) / 100.0,
        counter: u32::from_le_bytes([d[22], d[23], d[24], d[25]]),
    })
}
