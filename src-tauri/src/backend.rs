//! CAN backend factory.
//!
//! Adding a backend is a single arm in [`open_bus`]; the rest of the app
//! keeps holding an `Arc<dyn CanBus>` and never knows the difference.
//!
//! Spec format is `"<backend>:<name>"`, falling back to bare `<name>` which
//! is treated as `socketcan:<name>` on Linux. gs_usb adapters use a
//! `gs_usb<channel>` spec. Examples:
//! - `"can0"` (Linux SocketCAN, default)
//! - `"socketcan:vcan0"`
//! - `"gs_usb"` / `"gs_usb0"` — first gs_usb adapter, channel 0
//! - `"gs_usb1"` — channel 1 of a multi-channel gs_usb adapter
//!   (candleLight over USB, CAN-FD; works on Linux/macOS/Windows)

use std::sync::Arc;

use anyhow::{bail, Context, Result};
use can_transport::CanBus;

/// Open a bus. `hw_timestamp` asks the backend to stamp received frames with
/// its hardware clock (gs_usb only, needs firmware support); the returned bool
/// reports whether that actually engaged.
pub async fn open_bus(spec: &str, hw_timestamp: bool) -> Result<(Arc<dyn CanBus>, bool)> {
    // gs_usb is cross-platform and selected by a `gs_usb<channel>` spec.
    if let Some(channel) = gs_usb_channel(spec) {
        use can_transport::gs_usb::{GsUsbBus, GsUsbConfig};
        // CAN-FD, 1 Mbit nominal / 5 Mbit data (80 MHz device clock).
        let bus = GsUsbBus::open(
            GsUsbConfig::fd_1m_5m()
                .with_channel(channel)
                .with_hw_timestamp(hw_timestamp),
        )
        .await
        .with_context(|| format!("opening gs_usb / candleLight channel {channel}"))?;
        let hw_ts = bus.hw_timestamps_active();
        log::info!(
            "gs_usb ch{channel} opened: {:?}, hw_ts={hw_ts}",
            bus.capabilities()
        );
        return Ok((Arc::new(bus), hw_ts));
    }

    let (kind, name) = match spec.split_once(':') {
        Some((k, n)) => (k, n),
        None => ("socketcan", spec),
    };
    match kind {
        #[cfg(target_os = "linux")]
        "socketcan" => {
            let bus = can_transport::socketcan::SocketCanBus::open(name)
                .with_context(|| format!("opening SocketCAN interface '{name}'"))?;
            // SocketCAN hardware timestamps would need SO_TIMESTAMPING,
            // which can-transport does not expose yet.
            Ok((Arc::new(bus), false))
        }
        other => bail!(
            "backend '{other}' is not available on this build \
             (known: 'socketcan' on Linux, 'gs_usb<channel>' everywhere)"
        ),
    }
}

/// Parse a gs_usb interface spec into a channel number, or `None` if `spec`
/// is not a gs_usb spec. Accepts `gs_usb`, `gs_usb0`, `gs_usb1`, `gs_usb:1`,
/// and the underscore-less `gsusb2` variants.
fn gs_usb_channel(spec: &str) -> Option<u16> {
    let s = spec.trim().to_ascii_lowercase();
    let rest = s.strip_prefix("gs_usb").or_else(|| s.strip_prefix("gsusb"))?;
    let rest = rest.strip_prefix(':').unwrap_or(rest);
    if rest.is_empty() {
        Some(0)
    } else {
        rest.parse().ok()
    }
}
