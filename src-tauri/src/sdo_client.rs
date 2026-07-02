//! SDO client for the CAN Analyzer's "SDO" tab — read/write any node's object
//! dictionary over the analyzer's existing bus.
//!
//! Same engine as the `comeow` CLI (the `canopen-sdo` crate over
//! `Arc<dyn CanBus>`); the datatype encode/format logic and the abort-code
//! help table are ported from comeow's `value.rs` / `output.rs` so the GUI and
//! the CLI speak the same CiA-309 datatype tokens and print the same values.
//!
//! Like comeow, this is a *pure* SDO client: no CANopen stack, no own node-id.
//! Sharing the analyzer's bus (instead of opening a second one) matters on
//! gs_usb, where the USB interface is claimed exclusively — and it means SDO
//! *responses* show up decoded in the analyzer trace as they arrive.

use std::sync::Arc;
use std::time::Duration;

use can_transport::CanBus;
use canopen_sdo::asynch::{download_bytes_retry, upload_bytes_retry, AsyncSdoError};
use canopen_sdo::{SdoAbortCode, SdoError};

// ───────────────────────── datatypes (ported from comeow) ─────────────────────────

/// How an integer value should be rendered when read back.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Radix {
    Dec,
    Hex,
}

/// The CiA-309 datatype tokens we support (comeow's set).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DataType {
    Bool,
    U8,
    U16,
    U32,
    U64,
    I8,
    I16,
    I32,
    I64,
    F32,
    F64,
    VisibleString,
    /// Raw bytes, written/printed as space-separated hex. Also covers the
    /// CiA-309 octet/unicode/domain types (`os`/`us`/`d`) on the wire.
    HexBytes,
}

impl DataType {
    /// Parse a datatype token (`u16`, `x32`, `vs`, …) into the type and the
    /// radix to print integers in (the `x*` tokens select hex display).
    pub fn parse_token(tok: &str) -> Result<(DataType, Radix), String> {
        use DataType::*;
        use Radix::*;
        Ok(match tok {
            "b" | "bool" => (Bool, Dec),
            "u8" => (U8, Dec),
            "u16" => (U16, Dec),
            "u32" => (U32, Dec),
            "u64" => (U64, Dec),
            "x8" => (U8, Hex),
            "x16" => (U16, Hex),
            "x32" => (U32, Hex),
            "x64" => (U64, Hex),
            "i8" => (I8, Dec),
            "i16" => (I16, Dec),
            "i32" => (I32, Dec),
            "i64" => (I64, Dec),
            "r32" | "f32" => (F32, Dec),
            "r64" | "f64" => (F64, Dec),
            "vs" | "string" => (VisibleString, Dec),
            "hex" | "os" | "us" | "d" => (HexBytes, Dec),
            other => {
                return Err(format!(
                    "unknown datatype `{other}` (try: b u8 u16 u32 u64 i8 i16 i32 i64 x8 x16 x32 x64 r32 r64 vs hex)"
                ))
            }
        })
    }
}

/// Parse an integer accepting decimal or `0x`/`0b`/`0o` prefixes.
fn parse_int_u64(s: &str) -> Result<u64, String> {
    let t = s.trim();
    let r = if let Some(h) = t.strip_prefix("0x").or_else(|| t.strip_prefix("0X")) {
        u64::from_str_radix(h, 16)
    } else if let Some(b) = t.strip_prefix("0b").or_else(|| t.strip_prefix("0B")) {
        u64::from_str_radix(b, 2)
    } else if let Some(o) = t.strip_prefix("0o").or_else(|| t.strip_prefix("0O")) {
        u64::from_str_radix(o, 8)
    } else {
        t.parse()
    };
    r.map_err(|e| format!("invalid integer `{s}`: {e}"))
}

fn parse_u(s: &str, max: u64, ty: &'static str) -> Result<u64, String> {
    let v = parse_int_u64(s)?;
    if v > max {
        return Err(format!("value {s} out of range for {ty}"));
    }
    Ok(v)
}

fn parse_i(s: &str, min: i64, max: i64, ty: &'static str) -> Result<i64, String> {
    let (neg, body) = match s.strip_prefix('-') {
        Some(rest) => (true, rest),
        None => (false, s),
    };
    let mag = parse_int_u64(body)? as i128;
    let v = if neg { -mag } else { mag };
    if v < min as i128 || v > max as i128 {
        return Err(format!("value {s} out of range for {ty}"));
    }
    Ok(v as i64)
}

fn parse_hex_bytes(s: &str) -> Result<Vec<u8>, String> {
    // Accept "DE AD BE EF", "de ad", or a contiguous "deadbeef".
    let compact: String = s.split_whitespace().collect();
    let compact = compact.strip_prefix("0x").unwrap_or(&compact);
    // Guard before byte-slicing: multibyte input (e.g. full-width ＤＥＡＤ from a
    // CJK IME) would otherwise panic on a char boundary inside `compact[i..i+2]`.
    if !compact.is_ascii() {
        return Err(format!("invalid hex bytes `{s}`: only ASCII hex digits allowed"));
    }
    if compact.len() % 2 != 0 {
        return Err(format!("invalid hex bytes `{s}`: need an even number of hex digits"));
    }
    let mut out = Vec::with_capacity(compact.len() / 2);
    let mut i = 0;
    while i < compact.len() {
        let b = u8::from_str_radix(&compact[i..i + 2], 16)
            .map_err(|e| format!("invalid hex bytes `{s}`: {e}"))?;
        out.push(b);
        i += 2;
    }
    Ok(out)
}

fn strip_quotes(s: &str) -> &str {
    let s = s.trim();
    if s.len() >= 2 && s.starts_with('"') && s.ends_with('"') {
        &s[1..s.len() - 1]
    } else {
        s
    }
}

/// Encode a textual value into little-endian wire bytes for an SDO write.
pub fn encode(ty: DataType, s: &str) -> Result<Vec<u8>, String> {
    use DataType::*;
    Ok(match ty {
        Bool => match s {
            "1" | "true" | "on" | "True" => vec![1],
            "0" | "false" | "off" | "False" => vec![0],
            _ => return Err(format!("invalid boolean `{s}` (use 0/1, true/false, on/off)")),
        },
        U8 => (parse_u(s, u8::MAX as u64, "u8")? as u8).to_le_bytes().to_vec(),
        U16 => (parse_u(s, u16::MAX as u64, "u16")? as u16).to_le_bytes().to_vec(),
        U32 => (parse_u(s, u32::MAX as u64, "u32")? as u32).to_le_bytes().to_vec(),
        U64 => parse_u(s, u64::MAX, "u64")?.to_le_bytes().to_vec(),
        I8 => (parse_i(s, i8::MIN as i64, i8::MAX as i64, "i8")? as i8).to_le_bytes().to_vec(),
        I16 => (parse_i(s, i16::MIN as i64, i16::MAX as i64, "i16")? as i16).to_le_bytes().to_vec(),
        I32 => (parse_i(s, i32::MIN as i64, i32::MAX as i64, "i32")? as i32).to_le_bytes().to_vec(),
        I64 => parse_i(s, i64::MIN, i64::MAX, "i64")?.to_le_bytes().to_vec(),
        F32 => s
            .parse::<f32>()
            .map_err(|e| format!("invalid float `{s}`: {e}"))?
            .to_le_bytes()
            .to_vec(),
        F64 => s
            .parse::<f64>()
            .map_err(|e| format!("invalid float `{s}`: {e}"))?
            .to_le_bytes()
            .to_vec(),
        // CANopen visible strings are not NUL-terminated.
        VisibleString => strip_quotes(s).as_bytes().to_vec(),
        HexBytes => parse_hex_bytes(s)?,
    })
}

/// Format raw little-endian bytes from an SDO read using the given type.
pub fn format(ty: DataType, radix: Radix, raw: &[u8]) -> String {
    use DataType::*;
    match ty {
        Bool => {
            if le_u(raw) != 0 {
                "true (1)".into()
            } else {
                "false (0)".into()
            }
        }
        U8 | U16 | U32 | U64 => {
            let v = le_u(raw);
            match radix {
                Radix::Hex => format!("0x{v:X}"),
                Radix::Dec => v.to_string(),
            }
        }
        I8 => (raw.first().copied().unwrap_or(0) as i8).to_string(),
        I16 => i16::from_le_bytes(fixed::<2>(raw)).to_string(),
        I32 => i32::from_le_bytes(fixed::<4>(raw)).to_string(),
        I64 => i64::from_le_bytes(fixed::<8>(raw)).to_string(),
        F32 => f32::from_le_bytes(fixed::<4>(raw)).to_string(),
        F64 => f64::from_le_bytes(fixed::<8>(raw)).to_string(),
        VisibleString => String::from_utf8_lossy(raw).trim_end_matches('\0').to_string(),
        HexBytes => hex_join(raw),
    }
}

/// Format read bytes when no datatype was given: raw hex plus a small-int hint.
pub fn format_raw(raw: &[u8]) -> String {
    let hex = hex_join(raw);
    if raw.is_empty() {
        return "<empty>".into();
    }
    if raw.len() <= 4 {
        let v = le_u(raw);
        format!("{} bytes: {hex}  (u{}=0x{v:X}, {v})", raw.len(), raw.len() * 8)
    } else {
        format!("{} bytes: {hex}", raw.len())
    }
}

fn le_u(raw: &[u8]) -> u64 {
    let mut b = [0u8; 8];
    let n = raw.len().min(8);
    b[..n].copy_from_slice(&raw[..n]);
    u64::from_le_bytes(b)
}

fn fixed<const N: usize>(raw: &[u8]) -> [u8; N] {
    let mut b = [0u8; N];
    let n = raw.len().min(N);
    b[..n].copy_from_slice(&raw[..n]);
    b
}

fn hex_join(raw: &[u8]) -> String {
    raw.iter().map(|b| format!("{b:02X}")).collect::<Vec<_>>().join(" ")
}

// ───────────────────────── abort decoding (ported from comeow) ─────────────────────────

/// Plain-English description for the common CiA-301 abort codes.
pub fn abort_help(code: SdoAbortCode) -> &'static str {
    use SdoAbortCode::*;
    match code {
        ToggleBitNotAlternated => "toggle bit not alternated",
        ProtocolTimeout => "no response from node within the SDO timeout",
        InvalidCommandSpecifier => "client/server command specifier not valid",
        OutOfMemory => "out of memory on the server",
        UnsupportedAccess => "unsupported access to this object",
        ReadWriteOnly => "attempt to read a write-only object",
        WriteReadOnly => "attempt to write a read-only object",
        ObjectDoesNotExist => "object does not exist in the dictionary",
        NotMappable => "object cannot be mapped to a PDO",
        PdoLengthExceeded => "mapped objects exceed the PDO length",
        ParameterIncompatibility => "general parameter incompatibility",
        InternalIncompatibility => "general internal incompatibility in the device",
        HardwareError => "access failed due to a hardware error",
        DataTypeLengthMismatch => "data type / length of service parameter does not match",
        DataTypeLengthHigh => "data type / length too high",
        DataTypeLengthLow => "data type / length too low",
        SubindexDoesNotExist => "sub-index does not exist",
        InvalidValue => "invalid value for the parameter",
        ValueTooHigh => "value of the parameter written too high",
        ValueTooLow => "value of the parameter written too low",
        MaxLessThanMin => "maximum value is less than minimum value",
        ResourceNotAvailable => "resource not available (SDO connection)",
        General => "general error",
        StorageError => "data cannot be transferred or stored",
        StorageLocalControl => "data cannot be stored due to local control",
        StorageDeviceState => "data cannot be stored due to the device state",
        NoObjectDictionary => "object dictionary not present or dynamic generation failed",
        NoData => "no data available",
        InvalidBlockSize | InvalidSequenceNumber | CrcError => "SDO block-transfer error",
        Unknown(_) => "unknown / non-standard abort code",
    }
}

fn err_string(e: AsyncSdoError) -> String {
    match e {
        AsyncSdoError::Sdo(SdoError::ServerAborted(c)) | AsyncSdoError::Sdo(SdoError::ClientAborted(c)) => {
            format!("ABORT {c} — {}", abort_help(c))
        }
        AsyncSdoError::Sdo(other) => other.to_string(),
        AsyncSdoError::Io(io) => format!("I/O error: {io}"),
    }
}

// ───────────────────────── the two operations ─────────────────────────

/// SDO upload (read). `dtype` is a comeow datatype token or `None` for the
/// raw-hex rendering. Returns the formatted line, e.g. `0x1018:01 = 1234`.
pub async fn read(
    bus: &Arc<dyn CanBus>,
    node: u8,
    index: u16,
    sub: u8,
    dtype: Option<&str>,
    timeout: Duration,
    retries: u8,
) -> Result<String, String> {
    let ty = match dtype {
        Some(tok) => Some(DataType::parse_token(tok)?),
        None => None,
    };
    let bytes = upload_bytes_retry(&**bus, node, index, sub, Some(timeout), retries)
        .await
        .map_err(err_string)?;
    let rendered = match ty {
        Some((dt, radix)) => format(dt, radix, &bytes),
        None => format_raw(&bytes),
    };
    Ok(format!("0x{index:04X}:{sub:02X} = {rendered}"))
}

/// SDO download (write). Value is encoded per the datatype token.
pub async fn write(
    bus: &Arc<dyn CanBus>,
    node: u8,
    index: u16,
    sub: u8,
    dtype: &str,
    value: &str,
    timeout: Duration,
    retries: u8,
) -> Result<String, String> {
    let (dt, _radix) = DataType::parse_token(dtype)?;
    let data = encode(dt, value)?;
    download_bytes_retry(&**bus, node, index, sub, &data, Some(timeout), retries)
        .await
        .map_err(err_string)?;
    Ok(format!("0x{index:04X}:{sub:02X} ← {} ({} bytes) OK", value, data.len()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip_u16() {
        let bytes = encode(DataType::U16, "1000").unwrap();
        assert_eq!(bytes, vec![0xE8, 0x03]);
        assert_eq!(format(DataType::U16, Radix::Dec, &bytes), "1000");
        assert_eq!(format(DataType::U16, Radix::Hex, &bytes), "0x3E8");
    }

    #[test]
    fn hex_input_and_bytes() {
        assert_eq!(encode(DataType::U32, "0x04CE").unwrap(), vec![0xCE, 0x04, 0x00, 0x00]);
        assert_eq!(encode(DataType::HexBytes, "DE AD BE EF").unwrap(), vec![0xDE, 0xAD, 0xBE, 0xEF]);
        assert_eq!(encode(DataType::HexBytes, "deadbeef").unwrap(), vec![0xDE, 0xAD, 0xBE, 0xEF]);
    }

    #[test]
    fn signed_and_overflow() {
        assert_eq!(encode(DataType::I16, "-1").unwrap(), vec![0xFF, 0xFF]);
        assert!(encode(DataType::U8, "256").is_err());
        assert!(encode(DataType::I8, "200").is_err());
    }

    #[test]
    fn hex_bytes_rejects_non_ascii() {
        // Full-width IME digits / mixed multibyte must error, not panic.
        assert!(encode(DataType::HexBytes, "ＤＥＡＤ").is_err());
        assert!(encode(DataType::HexBytes, "aあ").is_err());
    }

    #[test]
    fn visible_string_not_nul_terminated() {
        let bytes = encode(DataType::VisibleString, "save").unwrap();
        assert_eq!(bytes, b"save");
        assert_eq!(format(DataType::VisibleString, Radix::Dec, &bytes), "save");
    }
}
