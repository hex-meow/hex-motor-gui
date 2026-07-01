//! Serde-able mirrors of the `hex_motor` types we hand to the frontend.
//!
//! Kept intentionally flat / string-tagged so the JS side can pattern-match
//! on string fields instead of parsing rust Debug output.

use serde::{Deserialize, Serialize};

use hex_motor::canopen::nmt::NmtState;
use hex_motor::cia402::{
    Connection as CoreConnection, LiveState as CoreLiveState, Logic as CoreLogic,
    Measurements as CoreMeasurements, MotorInfo as CoreMotorInfo,
    MotorLifecycle as CoreMotorLifecycle, ReinitReason as CoreReinitReason,
};
use hex_motor::types::{MotorErrorKind, MotorIdentity, MotorMode, MotorTarget};

#[derive(Debug, Clone, Serialize)]
pub struct MotorInfoDto {
    pub node_id: u8,
    pub friendly_name: String,
    pub identity: Option<MotorIdentityDto>,
    pub lifecycle: MotorLifecycleDto,
    pub online: bool,
    pub logic: Option<LogicDto>,
    pub nmt_state: Option<NmtStateDto>,
    /// `true` iff the motor is in a state where `set_mode` / `set_target`
    /// will be accepted (`Initialized` && `online`).
    pub is_ready: bool,
    /// `true` iff `initialize` is meaningful right now (lifecycle is
    /// `Identified` or `NeedsReinit`).
    pub can_initialize: bool,
    /// Peak torque (Nm) read from `0x6076` during init. Lets the UI render
    /// the `0x6072` permille input as an approximate Nm value. `None` until
    /// initialized (or if the motor doesn't expose it).
    pub peak_torque_nm: Option<f32>,
    /// Host device kind resolved from the `0x1018` identity via the GUI's
    /// non-motor registry: `"motor"` (default), `"imu"`, … The frontend routes
    /// the device to the matching panel on this field.
    pub device_type: String,
}

impl From<&CoreMotorInfo> for MotorInfoDto {
    fn from(m: &CoreMotorInfo) -> Self {
        let can_initialize = matches!(
            m.lifecycle,
            CoreMotorLifecycle::Identified | CoreMotorLifecycle::NeedsReinit { .. }
        );
        // Resolve the host device kind from the 0x1018 identity (default motor).
        let device_type = match &m.identity {
            Some(id) => crate::device_registry::classify(id.vendor_id, id.product_code),
            None => crate::device_registry::DeviceKind::Motor,
        }
        .as_str()
        .to_string();
        Self {
            node_id: m.node_id,
            friendly_name: m.friendly_name(),
            identity: m.identity.as_ref().map(MotorIdentityDto::from),
            lifecycle: (&m.lifecycle).into(),
            online: m.online,
            logic: m.logic.as_ref().map(LogicDto::from),
            nmt_state: m.nmt_state.map(NmtStateDto::from),
            is_ready: m.is_ready(),
            can_initialize,
            peak_torque_nm: m.peak_torque_nm,
            device_type,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct MotorIdentityDto {
    pub node_id: u8,
    pub vendor_id: u32,
    pub product_code: u32,
    pub revision_number: u32,
    pub serial_number: u32,
    pub product_name: Option<String>,
}

impl From<&MotorIdentity> for MotorIdentityDto {
    fn from(id: &MotorIdentity) -> Self {
        Self {
            node_id: id.node_id,
            vendor_id: id.vendor_id,
            product_code: id.product_code,
            revision_number: id.revision_number,
            serial_number: id.serial_number,
            product_name: id.product_name.clone(),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind")]
pub enum MotorLifecycleDto {
    Unknown,
    Identified,
    Initializing,
    Initialized,
    NeedsReinit { reason: String },
}

impl From<&CoreMotorLifecycle> for MotorLifecycleDto {
    fn from(l: &CoreMotorLifecycle) -> Self {
        match l {
            CoreMotorLifecycle::Unknown => Self::Unknown,
            CoreMotorLifecycle::Identified => Self::Identified,
            CoreMotorLifecycle::Initializing => Self::Initializing,
            CoreMotorLifecycle::Initialized => Self::Initialized,
            CoreMotorLifecycle::NeedsReinit { reason } => Self::NeedsReinit {
                reason: match reason {
                    CoreReinitReason::LeftOperational => "LeftOperational".into(),
                },
            },
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "state")]
pub enum LogicDto {
    Disabled,
    Enabled { mode: MotorModeDto },
    Error { kind: String, raw_code: u16 },
}

impl From<&CoreLogic> for LogicDto {
    fn from(l: &CoreLogic) -> Self {
        match l {
            CoreLogic::Disabled => Self::Disabled,
            CoreLogic::Enabled(m) => Self::Enabled { mode: (*m).into() },
            CoreLogic::Error { kind, raw_code } => Self::Error {
                kind: motor_error_kind_name(*kind).into(),
                raw_code: *raw_code,
            },
        }
    }
}

fn motor_error_kind_name(k: MotorErrorKind) -> &'static str {
    match k {
        MotorErrorKind::OverCurrent => "OverCurrent",
        MotorErrorKind::OverVoltage => "OverVoltage",
        MotorErrorKind::UnderVoltage => "UnderVoltage",
        MotorErrorKind::DriverOverTemp => "DriverOverTemp",
        MotorErrorKind::MotorOverTemp => "MotorOverTemp",
        MotorErrorKind::HeartbeatLost => "HeartbeatLost",
        MotorErrorKind::EncoderError => "EncoderError",
        MotorErrorKind::HallError => "HallError",
        MotorErrorKind::MotorStall => "MotorStall",
        MotorErrorKind::StartupDifficult => "StartupDifficult",
        MotorErrorKind::VelocityError => "VelocityError",
        MotorErrorKind::PositionError => "PositionError",
        MotorErrorKind::Other => "Other",
    }
}

/// Modes are exposed as plain string variants so the JS side can store the
/// raw value of a `<select>` directly.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum MotorModeDto {
    ProfilePosition,
    ProfileVelocity,
    Torque,
    Mit,
}

impl From<MotorMode> for MotorModeDto {
    fn from(m: MotorMode) -> Self {
        match m {
            MotorMode::ProfilePosition => Self::ProfilePosition,
            MotorMode::ProfileVelocity => Self::ProfileVelocity,
            MotorMode::Torque => Self::Torque,
            MotorMode::Mit => Self::Mit,
        }
    }
}

impl From<MotorModeDto> for MotorMode {
    fn from(m: MotorModeDto) -> Self {
        match m {
            MotorModeDto::ProfilePosition => MotorMode::ProfilePosition,
            MotorModeDto::ProfileVelocity => MotorMode::ProfileVelocity,
            MotorModeDto::Torque => MotorMode::Torque,
            MotorModeDto::Mit => MotorMode::Mit,
        }
    }
}

/// Internally-tagged so JS sends `{"kind":"Velocity","rev_per_s":0.3}` etc.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(tag = "kind")]
pub enum MotorTargetDto {
    Disable,
    Position {
        rev: f32,
    },
    Velocity {
        rev_per_s: f32,
    },
    Torque {
        nm: f32,
    },
    Mit {
        pos: f32,
        vel: f32,
        tor: f32,
        kp: f32,
        kd: f32,
    },
}

impl From<MotorTargetDto> for MotorTarget {
    fn from(t: MotorTargetDto) -> Self {
        match t {
            MotorTargetDto::Disable => MotorTarget::Disable,
            MotorTargetDto::Position { rev } => MotorTarget::Position { rev },
            MotorTargetDto::Velocity { rev_per_s } => MotorTarget::Velocity { rev_per_s },
            MotorTargetDto::Torque { nm } => MotorTarget::Torque { nm },
            MotorTargetDto::Mit {
                pos,
                vel,
                tor,
                kp,
                kd,
            } => MotorTarget::Mit {
                pos,
                vel,
                tor,
                kp,
                kd,
            },
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize)]
pub enum NmtStateDto {
    BootUp,
    Stopped,
    Operational,
    PreOperational,
}

impl From<NmtState> for NmtStateDto {
    fn from(s: NmtState) -> Self {
        match s {
            NmtState::BootUp => Self::BootUp,
            NmtState::Stopped => Self::Stopped,
            NmtState::Operational => Self::Operational,
            NmtState::PreOperational => Self::PreOperational,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct LiveStateDto {
    pub connection: ConnectionDto,
    pub logic: Option<LogicDto>,
    pub measurements: MeasurementsDto,
}

impl From<&CoreLiveState> for LiveStateDto {
    fn from(s: &CoreLiveState) -> Self {
        Self {
            connection: (&s.connection).into(),
            logic: s.logic.as_ref().map(LogicDto::from),
            measurements: (&s.measurements).into(),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct ConnectionDto {
    pub online: bool,
    pub nmt_state: Option<NmtStateDto>,
    /// `Instant`s aren't serializable; we surface only "has it ever arrived"
    /// as a boolean for the UI's purposes.
    pub has_heartbeat: bool,
    pub has_tpdo: bool,
}

impl From<&CoreConnection> for ConnectionDto {
    fn from(c: &CoreConnection) -> Self {
        Self {
            online: c.online,
            nmt_state: c.nmt_state.map(NmtStateDto::from),
            has_heartbeat: c.last_heartbeat.is_some(),
            has_tpdo: c.last_tpdo.is_some(),
        }
    }
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct MeasurementsDto {
    pub position_rev: Option<f32>,
    pub velocity_rev_per_s: Option<f32>,
    pub torque_nm: Option<f32>,
    pub driver_temp_c: Option<f32>,
    pub motor_temp_c: Option<f32>,
    pub status_word: Option<u16>,
    pub mode_display: Option<u8>,
    pub error_register: Option<u8>,
    /// Motor's `0x1013` high-res timestamp in µs (wraps ~every 71 min).
    pub timestamp_us: Option<u32>,
}

impl From<&CoreMeasurements> for MeasurementsDto {
    fn from(m: &CoreMeasurements) -> Self {
        Self {
            position_rev: m.position_rev,
            velocity_rev_per_s: m.velocity_rev_per_s,
            torque_nm: m.torque_nm,
            driver_temp_c: m.driver_temp_c,
            motor_temp_c: m.motor_temp_c,
            status_word: m.status_word,
            mode_display: m.mode_display,
            error_register: m.error_register,
            timestamp_us: m.timestamp_us,
        }
    }
}
