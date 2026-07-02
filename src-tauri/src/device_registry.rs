//! Non-motor device registry (CANopen `0x1018` identity → host device kind).
//!
//! Motor discovery + identity reading already lives in `hex-motor`
//! (`KNOWN_DEVICES`), and motors are this GUI's *default* device kind. This
//! table is the GUI-owned companion: it lists the **non-motor** hex-meow
//! devices the GUI knows how to display, so a node discovered on the bus can be
//! routed to the right panel purely from its `0x1018` identity.
//!
//! A device kind shares **one** frontend panel across all its product codes —
//! add a row here for every new IMU (or other non-motor) product code and they
//! all open the same IMU panel. See `docs/device-identity.md`.

use serde::Serialize;

/// HEXFELLOW vendor id — ASCII "hex" (`0x00 'h' 'e' 'x'`), i.e. `0x00686578`.
/// Used by HEXFELLOW devices (CiA402 motors, GELLO, …).
pub const VENDOR_HEX: u32 = 0x0068_6578;

/// hex-meow vendor id — ASCII "hexm" (`'h' 'e' 'x' 'm'`), i.e. `0x6865786D`.
pub const VENDOR_HEXM: u32 = 0x6865_786D;

/// Generic-IMU product code — ASCII "IMU" (`0x00 'I' 'M' 'U'`).
pub const PRODUCT_IMU: u32 = 0x0049_4D55;

/// Which panel a discovered device opens. `Motor` is the implicit default for
/// anything not listed in [`NON_MOTOR_DEVICES`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum DeviceKind {
    Motor,
    Imu,
}

impl DeviceKind {
    /// Lowercase tag the frontend matches on (`"motor"`, `"imu"`).
    pub fn as_str(self) -> &'static str {
        match self {
            DeviceKind::Motor => "motor",
            DeviceKind::Imu => "imu",
        }
    }
}

/// One non-motor device family. `product_code == None` is a vendor-wide
/// wildcard (matches any product code under `vendor_id`).
pub struct KnownDevice {
    pub vendor_id: u32,
    pub product_code: Option<u32>,
    pub kind: DeviceKind,
    pub name: &'static str,
}

/// The non-motor devices this GUI can display. Every IMU product code routes to
/// the single IMU panel — add new rows as new IMU variants ship.
pub const NON_MOTOR_DEVICES: &[KnownDevice] = &[
    KnownDevice {
        vendor_id: VENDOR_HEXM,
        product_code: Some(PRODUCT_IMU),
        kind: DeviceKind::Imu,
        name: "hex-meow IMU",
    },
    // Future IMU product codes (all share the IMU panel), e.g.:
    // KnownDevice { vendor_id: VENDOR_HEXM, product_code: Some(0x...), kind: DeviceKind::Imu, name: "..." },
];

/// Classify a node from its `0x1018` identity. Anything not registered as a
/// non-motor device is treated as a [`DeviceKind::Motor`] (the GUI default).
pub fn classify(vendor_id: u32, product_code: u32) -> DeviceKind {
    NON_MOTOR_DEVICES
        .iter()
        .find(|d| {
            d.vendor_id == vendor_id && d.product_code.map_or(true, |pc| pc == product_code)
        })
        .map(|d| d.kind)
        .unwrap_or(DeviceKind::Motor)
}
