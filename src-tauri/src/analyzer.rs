//! CAN bus analyzer — a passive sniffer + manual sender, for humans debugging.
//!
//! Unlike the motor sessions, the analyzer owns its **own** bus (opened directly
//! via [`crate::backend::open_bus`], no `Cia402Manager`) so it can watch a raw
//! bus without generating heartbeat/discovery traffic. It captures *all* traffic
//! on **two** subscriptions — `pass_all_standard` + `pass_all_extended`, because a
//! single [`CanFilter`] matches one id-width only — host-timestamps each frame on
//! arrival, and maintains:
//!   1. a fixed-cap ring buffer of recent frames (for the "trace" view), and
//!   2. a cumulative per-ID aggregate map (for the "grouped by ID" view).
//!
//! The frontend polls **bounded** snapshots at a fixed cadence (cursor-based for
//! the trace, whole-map for the aggregates); nothing re-renders per frame. This
//! is deliberately a debugging tool, not a recorder — old frames roll off the
//! ring (surfaced to the UI as a `gap`), and there is a hard cap on distinct ids.
//!
//! CAN *status* has two layers: software-derived health (frame rate, our own
//! subscriber-drop count, distinct ids) computed here, and controller health
//! (error counters / bus-off) polled on demand through `CanBus::bus_state()` —
//! netlink on SocketCAN, `GET_STATE` on gs_usb (firmware-gated; `Ok(None)`
//! renders as unknown). Timestamps prefer the device hardware clock when the
//! session enabled it (gs_usb), rebased onto the host axis by [`AnalyzerState::display_time`].

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Instant;

use anyhow::{anyhow, Result};
use async_trait::async_trait;
use can_transport::{
    CanBus, CanCapabilities, CanFilter, CanFrame, CanId, CanIoError, CanRx, FrameKind,
};
use serde::{Deserialize, Serialize};
use tokio::task::JoinHandle;

/// Hard cap on the trace ring. Older frames roll off (surfaced as a `gap`).
/// ~8192 × sizeof(TraceRecord) is well under 1 MB.
const RING_CAP: usize = 8192;
/// Hard cap on distinct ids tracked in the aggregate map — protects against a
/// device walking the id space or bus noise. Overflow is counted, not fatal.
const MAX_IDS: usize = 4096;
/// Per-ID rate = frames in the last completed window / actual window length.
/// A window closes on the first frame ≥ this after it opened, so slow IDs
/// measure over their real spacing. (Replaces an inter-arrival EWMA: at
/// connect, frames buffered by the adapter arrive µs apart and seeded the
/// EWMA with a huge rate that took ~90 frames — 90 s for a 1 Hz heartbeat —
/// to decay. A window bounds that pollution to one window.)
const RATE_WINDOW_US: u64 = 2_000_000;
/// Show 0 Hz for an ID silent this long; the rate would otherwise freeze at
/// its last value forever.
const RATE_STALE_US: u64 = 5_000_000;
/// Never return more than this many trace frames in a single poll, regardless of
/// what the caller asks for — bounds the IPC payload.
const MAX_BATCH: u32 = 5000;

// ───────────────────────────── capture state ─────────────────────────────

/// Frame width + raw id — distinguishes standard `0x123` from extended `0x123`.
type AggKey = (u32, bool);

#[derive(Clone, Copy)]
enum Dir {
    Rx,
    Tx,
}

impl Dir {
    fn as_str(self) -> &'static str {
        match self {
            Dir::Rx => "rx",
            Dir::Tx => "tx",
        }
    }
}

/// A captured frame in the ring. All-`Copy` so the poll path can memcpy a bounded
/// slice out from under the lock and format it *after* releasing the lock.
#[derive(Clone, Copy)]
struct TraceRecord {
    seq: u64,
    t_us: u64,
    id: CanId,
    kind: FrameKind,
    len: u8,
    dir: Dir,
    data: [u8; 64],
}

/// Cumulative per-ID stats. Survives ring eviction (updated in the capture path,
/// independent of the ring), so "grouped by ID" frequency stats persist.
#[derive(Clone, Copy)]
struct AggEntry {
    count: u64,
    first_us: u64,
    last_us: u64,
    last_len: u8,
    last_kind: FrameKind,
    last_data: [u8; 64],
    /// Rate over the last *completed* measurement window (0 until one closes).
    rate_hz: f32,
    /// Start of the currently-open window and frames counted since.
    win_start_us: u64,
    win_count: u32,
}

impl AggEntry {
    fn new(t_us: u64, kind: FrameKind, data: &[u8], len: u8) -> Self {
        let mut e = Self {
            count: 1,
            first_us: t_us,
            last_us: t_us,
            last_len: len,
            last_kind: kind,
            last_data: [0u8; 64],
            rate_hz: 0.0,
            // The first frame opens the window but isn't counted in it: rate
            // is "frames per elapsed time since window start".
            win_start_us: t_us,
            win_count: 0,
        };
        // `len` is the DLC (which for a Remote frame is nonzero while `data` is
        // empty), so clamp the copy to the bytes actually present.
        let n = (len as usize).min(data.len());
        e.last_data[..n].copy_from_slice(&data[..n]);
        e
    }

    fn update(&mut self, t_us: u64, kind: FrameKind, data: &[u8], len: u8) {
        self.count += 1;
        self.win_count += 1;
        let elapsed = t_us.saturating_sub(self.win_start_us);
        if elapsed >= RATE_WINDOW_US {
            self.rate_hz = self.win_count as f32 * 1_000_000.0 / elapsed as f32;
            self.win_start_us = t_us;
            self.win_count = 0;
        }
        self.last_us = t_us;
        self.last_kind = kind;
        self.last_len = len;
        let n = (len as usize).min(data.len());
        self.last_data[..n].copy_from_slice(&data[..n]);
    }
}

struct AnalyzerState {
    ring: VecDeque<TraceRecord>,
    /// seq of `ring.front()`; equals `next_seq` when the ring is empty.
    first_seq: u64,
    /// seq to assign to the next captured frame (monotonic for the session).
    next_seq: u64,
    agg: HashMap<AggKey, AggEntry>,
    /// distinct ids we could not track because the map hit `MAX_IDS`.
    agg_overflow: u64,
    total: u64,
    /// Fixed device-clock → host-axis offset (`device_ts − host_elapsed`),
    /// captured at the first hardware-stamped frame. Stamped frames display
    /// as `device_ts − offset` ≈ their host arrival time, so their *deltas*
    /// keep device precision while host-clock rows (TX mirror, pre-first-frame
    /// rows) sit on the same monotonic axis — no jump when stamping kicks in.
    hw_offset: Option<i64>,
}

impl AnalyzerState {
    fn new() -> Self {
        // seq is 1-based: the frontend's initial cursor is 0 and asks for
        // `seq > after_seq`, so the first frame (seq 1) must be > 0.
        Self {
            ring: VecDeque::with_capacity(RING_CAP),
            first_seq: 1,
            next_seq: 1,
            agg: HashMap::new(),
            agg_overflow: 0,
            total: 0,
            hw_offset: None,
        }
    }

    /// Map a frame's clock onto the session display axis (µs since capture
    /// start, host timeline). Host-clock rows pass through; hardware-stamped
    /// frames are rebased with a fixed offset captured at the first stamped
    /// frame, preserving device-precision deltas on a jump-free shared axis.
    /// The clocks drift apart only by crystal ppm — irrelevant over a debug
    /// session, and the staleness/rate math compares within one axis anyway.
    fn display_time(&mut self, host_us: u64, hw_us: Option<u64>) -> u64 {
        match hw_us {
            Some(h) => {
                let off = *self.hw_offset.get_or_insert(h as i64 - host_us as i64);
                (h as i64 - off).max(0) as u64
            }
            None => host_us,
        }
    }

    /// Record one frame (rx or tx). Sync + await-free: this is the hot path and
    /// the caller holds the std mutex, so it must never block.
    fn push(&mut self, id: CanId, kind: FrameKind, data: &[u8], len: u8, t_us: u64, dir: Dir) {
        let seq = self.next_seq;
        self.next_seq += 1;
        self.total += 1;

        let mut rec = TraceRecord {
            seq,
            t_us,
            id,
            kind,
            len,
            dir,
            data: [0u8; 64],
        };
        // Clamp to bytes present: a Remote frame has a nonzero `len` (DLC) but
        // an empty `data` slice — copying `len` bytes would panic (and poison
        // this lock, killing every poll command).
        let n = (len as usize).min(data.len());
        rec.data[..n].copy_from_slice(&data[..n]);
        if self.ring.len() == RING_CAP {
            self.ring.pop_front();
            self.first_seq += 1;
        }
        if self.ring.is_empty() {
            self.first_seq = seq;
        }
        self.ring.push_back(rec);

        let key = (id.raw(), id.is_extended());
        match self.agg.get_mut(&key) {
            Some(e) => e.update(t_us, kind, data, len),
            None => {
                if self.agg.len() >= MAX_IDS {
                    self.agg_overflow += 1;
                } else {
                    self.agg.insert(key, AggEntry::new(t_us, kind, data, len));
                }
            }
        }
    }

    fn clear(&mut self) {
        self.ring.clear();
        self.agg.clear();
        self.agg_overflow = 0;
        self.total = 0;
        self.first_seq = self.next_seq; // keep seq monotonic; empty ring
    }
}

#[derive(Default)]
struct AnalyzerStatus {
    /// Cumulative frames dropped by *our* 256-deep subscriber queues (both
    /// widths). This is GUI/host backpressure — NOT a bus-level error.
    our_dropped: AtomicU64,
}

// ─────────────────────────────── DTOs ───────────────────────────────

/// Display filter, applied at query time (we capture everything). Sent by the
/// frontend with each poll.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum FilterSpec {
    All,
    /// Match a CANopen node across its function-code ranges. `include_nodeless`
    /// keeps NMT/SYNC/TIME/LSS (which carry no node) visible for context.
    Node { node: u8, include_nodeless: bool },
    /// Bit-mask filter within one id width, mirroring `CanFilter::matches`.
    Mask { id: u32, mask: u32, extended: bool },
}

impl FilterSpec {
    fn matches(&self, id: CanId) -> bool {
        match self {
            FilterSpec::All => true,
            FilterSpec::Mask { id: fid, mask, extended } => match id {
                CanId::Standard(s) => !*extended && (s as u32 & mask) == (fid & mask),
                CanId::Extended(e) => *extended && (e & mask) == (fid & mask),
            },
            FilterSpec::Node { node, include_nodeless } => match id {
                // CANopen is 11-bit only; extended frames have no node.
                CanId::Extended(_) => false,
                CanId::Standard(s) => {
                    let n = (s & 0x7F) as u8;
                    let fc = s & 0x780;
                    let node_bearing = n != 0
                        && matches!(
                            fc,
                            0x080 | 0x180 | 0x200 | 0x280 | 0x300 | 0x380 | 0x400 | 0x480
                                | 0x500 | 0x580 | 0x600 | 0x700
                        );
                    if node_bearing && n == *node {
                        return true;
                    }
                    if *include_nodeless {
                        // NMT(0x000), SYNC(0x080), TIME(0x100), LSS(0x7E4/0x7E5).
                        matches!(s, 0x000 | 0x080 | 0x100 | 0x7E4 | 0x7E5)
                    } else {
                        false
                    }
                }
            },
        }
    }
}

/// A frame the user asked to transmit.
#[derive(Debug, Clone, Deserialize)]
pub struct SendSpec {
    pub id: u32,
    pub extended: bool,
    pub fd: bool,
    pub brs: bool,
    pub rtr: bool,
    /// Requested DLC for an RTR frame (ignored for data/FD frames).
    #[serde(default)]
    pub dlc: u8,
    pub data: Vec<u8>,
}

#[derive(Debug, Clone, Serialize)]
pub struct AnalyzerStatusDto {
    pub capturing: bool,
    pub total: u64,
    pub our_dropped: u64,
    pub distinct_ids: u32,
    pub agg_overflow: u64,
    pub ring_len: u32,
    pub next_seq: u64,
    /// Backend supports CAN-FD (drives the send widget's FD/BRS/64-byte gating).
    pub fd: bool,
    pub max_dlen: u32,
    /// Trace times come from the device's hardware clock (gs_usb hw ts).
    pub hw_ts: bool,
}

impl AnalyzerStatusDto {
    /// The snapshot returned when no analyzer session is running.
    pub fn idle() -> Self {
        Self {
            capturing: false,
            total: 0,
            our_dropped: 0,
            distinct_ids: 0,
            agg_overflow: 0,
            ring_len: 0,
            next_seq: 0,
            fd: false,
            max_dlen: 0,
            hw_ts: false,
        }
    }
}

/// Controller health snapshot for the status strip (mirrors
/// `can_transport::CanBusState`, stringly-typed for the frontend).
#[derive(Debug, Clone, Default, Serialize)]
pub struct BusHealthDto {
    /// `true` when the backend reported anything at all; `false` = unknown
    /// (backend without support — render "—").
    pub supported: bool,
    /// "error_active" | "error_warning" | "error_passive" | "bus_off" |
    /// "stopped" | "sleeping", when known.
    pub state: Option<String>,
    pub tx_errors: Option<u16>,
    pub rx_errors: Option<u16>,
}

impl BusHealthDto {
    pub fn from_state(s: Option<can_transport::CanBusState>) -> Self {
        use can_transport::CanControllerState as C;
        match s {
            None => Self::default(),
            Some(s) => Self {
                supported: true,
                state: s.state.map(|st| {
                    match st {
                        C::ErrorActive => "error_active",
                        C::ErrorWarning => "error_warning",
                        C::ErrorPassive => "error_passive",
                        C::BusOff => "bus_off",
                        C::Stopped => "stopped",
                        C::Sleeping => "sleeping",
                    }
                    .to_string()
                }),
                tx_errors: s.tx_errors,
                rx_errors: s.rx_errors,
            },
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct TraceFrameDto {
    pub seq: u64,
    /// Time in µs since capture start, on one shared session axis: the device
    /// hardware clock (rebased) when hw timestamps are active, host arrival
    /// time otherwise (and always for TX rows).
    pub t_us: u64,
    pub id: u32,
    pub extended: bool,
    /// "data" | "fd" | "fd_brs" | "remote".
    pub kind: String,
    pub dlc: u8,
    /// Lower-case space-separated hex of the `dlc` payload bytes ("11 22 aa").
    pub data: String,
    /// "rx" | "tx".
    pub dir: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct TraceReplyDto {
    pub frames: Vec<TraceFrameDto>,
    /// Cursor to pass as `after_seq` on the next poll.
    pub next_seq: u64,
    /// `true` when frames between the caller's cursor and our oldest were evicted.
    pub gap: bool,
    pub status: AnalyzerStatusDto,
}

impl TraceReplyDto {
    pub fn idle() -> Self {
        Self {
            frames: Vec::new(),
            next_seq: 0,
            gap: false,
            status: AnalyzerStatusDto::idle(),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct AggRowDto {
    pub id: u32,
    pub extended: bool,
    pub count: u64,
    pub rate_hz: f32,
    pub last_dlc: u8,
    pub last_kind: String,
    pub last_data: String,
    pub first_us: u64,
    pub last_us: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct AggReplyDto {
    pub rows: Vec<AggRowDto>,
    pub status: AnalyzerStatusDto,
}

impl AggReplyDto {
    pub fn idle() -> Self {
        Self {
            rows: Vec::new(),
            status: AnalyzerStatusDto::idle(),
        }
    }
}

// ─────────────────────────────── TX mirror ───────────────────────────────

/// Decorator around the analyzer's bus: every successful `send()` is also
/// recorded into the trace ring as a `dir=tx` row.
///
/// Neither backend delivers our own transmissions back to us (gs_usb drops its
/// TX-completion echoes in `parse_host_frame`; SocketCAN's sending socket has
/// `CAN_RAW_RECV_OWN_MSGS` off and can-transport never enables it), so without
/// this the trace would show SDO *responses* but not our *requests*. Handing
/// this wrapper to anything that transmits (manual send, the SDO client) makes
/// all analyzer-originated traffic visible on one path.
///
/// Semantics note: a `tx` row means "accepted by the driver/adapter", not
/// "ACKed on the wire" — a true wire-confirmed echo needs can-transport
/// support (gs_usb echo frames / SocketCAN RECV_OWN_MSGS + MSG_CONFIRM).
struct TxMirror {
    inner: Arc<dyn CanBus>,
    state: Arc<StdMutex<AnalyzerState>>,
    t0: Instant,
}

#[async_trait]
impl CanBus for TxMirror {
    async fn send(&self, frame: CanFrame) -> Result<(), CanIoError> {
        self.inner.send(frame).await?;
        let host_us = self.t0.elapsed().as_micros() as u64;
        let (data, len): (&[u8], u8) = match frame.kind() {
            FrameKind::Remote => (&[], frame.dlc() as u8),
            _ => (frame.data(), frame.data().len() as u8),
        };
        let mut st = self.state.lock().unwrap();
        // TX rows are host-clock events; hw-stamped RX frames are rebased onto
        // this same host axis, so no alignment is needed here.
        let t_us = st.display_time(host_us, None);
        st.push(frame.id(), frame.kind(), data, len, t_us, Dir::Tx);
        Ok(())
    }

    async fn subscribe(&self, filter: CanFilter) -> Result<Box<dyn CanRx>, CanIoError> {
        self.inner.subscribe(filter).await
    }

    fn capabilities(&self) -> CanCapabilities {
        self.inner.capabilities()
    }

    // Forward explicitly — the trait default would mask the inner backend.
    async fn bus_state(&self) -> Result<Option<can_transport::CanBusState>, CanIoError> {
        self.inner.bus_state().await
    }
}

// ─────────────────────────────── session ───────────────────────────────

/// A running analyzer session: owns its bus and the two drain tasks.
pub struct CanAnalyzer {
    bus: Arc<dyn CanBus>,
    /// Session time origin (shared with the drain loops and the mirror);
    /// used by queries to judge per-ID staleness.
    t0: Instant,
    /// The bus wrapped in [`TxMirror`] — every transmit path (manual send,
    /// SDO client) goes through this so the trace shows our own frames.
    mirror: Arc<TxMirror>,
    state: Arc<StdMutex<AnalyzerState>>,
    status: Arc<AnalyzerStatus>,
    std_task: JoinHandle<()>,
    ext_task: JoinHandle<()>,
    /// Serializes SDO-tab operations (one transfer at a time, like comeow's
    /// single executor task). Cloned out of the session together with the
    /// mirror so commands never hold the `AppState.analyzer` guard across
    /// the await.
    sdo_lock: Arc<tokio::sync::Mutex<()>>,
    /// Frames carry device hardware timestamps (requested + supported).
    hw_ts: bool,
}

impl CanAnalyzer {
    /// Open `spec` (e.g. `"can0"`, `"gs_usb"`) as a fresh bus and start
    /// capturing. `hw_timestamp` requests device-clock stamping (gs_usb only).
    pub async fn start(spec: &str, hw_timestamp: bool) -> Result<Self> {
        let (bus, hw_ts) = crate::backend::open_bus(spec, hw_timestamp).await?;
        // Two subscriptions: a single CanFilter is standard-XOR-extended.
        let rx_std = bus
            .subscribe(CanFilter::pass_all_standard())
            .await
            .map_err(|e| anyhow!("subscribe standard: {e}"))?;
        let rx_ext = bus
            .subscribe(CanFilter::pass_all_extended())
            .await
            .map_err(|e| anyhow!("subscribe extended: {e}"))?;
        // Set the time origin only after *both* subscriptions exist so the
        // relative timestamps start clean (frames buffer in the 256-deep queues
        // until the drain tasks below pick them up).
        let t0 = Instant::now();

        let state = Arc::new(StdMutex::new(AnalyzerState::new()));
        let status = Arc::new(AnalyzerStatus::default());

        let std_task = tokio::spawn(drain_loop(rx_std, state.clone(), status.clone(), t0));
        let ext_task = tokio::spawn(drain_loop(rx_ext, state.clone(), status.clone(), t0));

        let mirror = Arc::new(TxMirror {
            inner: bus.clone(),
            state: state.clone(),
            t0,
        });

        log::info!("CAN analyzer capturing on {spec:?} ({:?})", bus.capabilities());
        Ok(Self {
            bus,
            t0,
            mirror,
            state,
            status,
            std_task,
            ext_task,
            sdo_lock: Arc::new(tokio::sync::Mutex::new(())),
            hw_ts,
        })
    }

    /// The raw bus, for on-demand health queries (`bus_state`). Clone out and
    /// drop the `AppState.analyzer` guard before awaiting.
    pub fn bus_handle(&self) -> Arc<dyn CanBus> {
        self.bus.clone()
    }

    /// The analyzer's TX-mirrored bus + the SDO serialization lock, cloned out
    /// so the caller can drop the `AppState.analyzer` guard before awaiting a
    /// (possibly seconds-long, with retries) SDO transfer. Because the SDO
    /// client sends through the mirror, its requests appear in the trace.
    pub fn sdo_handles(&self) -> (Arc<dyn CanBus>, Arc<tokio::sync::Mutex<()>>) {
        (self.mirror.clone() as Arc<dyn CanBus>, self.sdo_lock.clone())
    }

    /// Cursor-based trace slice: frames with `seq > after_seq`, up to `max`, that
    /// pass `filter`. Copies raw records out under the lock, then formats after
    /// releasing it, so the kHz drain tasks are never starved by the poll.
    pub fn get_trace(&self, after_seq: u64, max: u32, filter: &FilterSpec) -> TraceReplyDto {
        let max = max.min(MAX_BATCH) as usize;
        let (mut raw, next_seq, gap, status) = {
            let st = self.state.lock().unwrap();
            let gap = st.first_seq > after_seq.saturating_add(1);
            let mut out: Vec<TraceRecord> = Vec::new();
            let mut last_seen = after_seq;
            for rec in st.ring.iter() {
                if rec.seq <= after_seq {
                    continue;
                }
                last_seen = rec.seq;
                if filter.matches(rec.id) {
                    out.push(*rec);
                    if out.len() >= max {
                        break;
                    }
                }
            }
            (out, last_seen, gap, self.status_dto(&st))
        };
        let frames = raw.drain(..).map(trace_dto).collect();
        TraceReplyDto {
            frames,
            next_seq,
            gap,
            status,
        }
    }

    /// The whole (small) per-ID table that passes `filter`. Cloned out under the
    /// lock, formatted after.
    pub fn get_aggregates(&self, filter: &FilterSpec) -> AggReplyDto {
        let now_us = self.t0.elapsed().as_micros() as u64;
        let (rows, status) = {
            let st = self.state.lock().unwrap();
            let rows: Vec<(AggKey, AggEntry)> = st
                .agg
                .iter()
                .filter(|((raw, ext), _)| {
                    let id = if *ext {
                        CanId::Extended(*raw)
                    } else {
                        CanId::Standard(*raw as u16)
                    };
                    filter.matches(id)
                })
                .map(|(k, e)| (*k, *e))
                .collect();
            (rows, self.status_dto(&st))
        };
        let rows = rows.into_iter().map(|(k, e)| agg_dto(k, e, now_us)).collect();
        AggReplyDto { rows, status }
    }

    pub fn get_status(&self) -> AnalyzerStatusDto {
        let st = self.state.lock().unwrap();
        self.status_dto(&st)
    }

    fn status_dto(&self, st: &AnalyzerState) -> AnalyzerStatusDto {
        let caps = self.bus.capabilities();
        AnalyzerStatusDto {
            capturing: true,
            total: st.total,
            our_dropped: self.status.our_dropped.load(Ordering::Relaxed),
            distinct_ids: st.agg.len() as u32,
            agg_overflow: st.agg_overflow,
            ring_len: st.ring.len() as u32,
            next_seq: st.next_seq,
            fd: caps.fd,
            max_dlen: caps.max_dlen as u32,
            hw_ts: self.hw_ts,
        }
    }

    /// Empty the ring + aggregates + counters. Returns the (monotonic) cursor the
    /// frontend should adopt so it doesn't treat post-clear frames as a gap.
    pub fn clear(&self) -> u64 {
        let mut st = self.state.lock().unwrap();
        st.clear();
        self.status.our_dropped.store(0, Ordering::Relaxed);
        // Return "last assigned seq" as the cursor so the next captured frame
        // (seq == next_seq) is still delivered (it is > next_seq - 1).
        st.next_seq.saturating_sub(1)
    }

    /// Transmit a frame. Goes through the [`TxMirror`], so the frame shows up
    /// in the trace as a `tx` row (neither backend echoes our own sends).
    pub async fn send(&self, spec: SendSpec) -> Result<()> {
        let id = if spec.extended {
            CanId::new_extended(spec.id).map_err(|e| anyhow!("bad extended id: {e}"))?
        } else {
            if spec.id > CanId::STANDARD_MAX as u32 {
                return Err(anyhow!("standard id 0x{:X} exceeds 0x7FF", spec.id));
            }
            CanId::new_standard(spec.id as u16).map_err(|e| anyhow!("bad standard id: {e}"))?
        };
        let frame = if spec.rtr {
            CanFrame::new_remote(id, spec.dlc.min(8)).map_err(|e| anyhow!("build RTR frame: {e}"))?
        } else if spec.fd {
            CanFrame::new_fd(id, &spec.data, spec.brs).map_err(|e| anyhow!("build FD frame: {e}"))?
        } else {
            CanFrame::new_data(id, &spec.data).map_err(|e| anyhow!("build data frame: {e}"))?
        };

        self.mirror
            .send(frame)
            .await
            .map_err(|e| anyhow!("send: {e}"))?;
        Ok(())
    }

    /// Stop capturing and release the bus.
    pub async fn stop(self) {
        // Abort at the recv() await points; the sync critical sections never span
        // an await, so the shared state mutex can't be left poisoned.
        self.std_task.abort();
        self.ext_task.abort();
        let _ = self.std_task.await;
        let _ = self.ext_task.await;
        // Drain any in-flight SDO transfer (bounded by its timeout × attempts):
        // the transfer holds a clone of our bus Arc, and on gs_usb the USB device
        // stays exclusively claimed until every clone drops — an immediate
        // restart would otherwise fail to open the adapter.
        let _ = self.sdo_lock.lock().await;
        log::info!("CAN analyzer stopped");
        // `bus` (Arc<dyn CanBus>) drops here → the backend reader task stops.
    }
}

async fn drain_loop(
    mut rx: Box<dyn CanRx>,
    state: Arc<StdMutex<AnalyzerState>>,
    status: Arc<AnalyzerStatus>,
    t0: Instant,
) {
    loop {
        match rx.recv().await {
            Ok(frame) => {
                let host_us = t0.elapsed().as_micros() as u64;
                let (data, len): (&[u8], u8) = match frame.kind() {
                    FrameKind::Remote => (&[], frame.dlc() as u8),
                    _ => (frame.data(), frame.data().len() as u8),
                };
                let mut st = state.lock().unwrap();
                // Prefer the device's hardware timestamp when present.
                let t_us = st.display_time(host_us, frame.timestamp_us());
                st.push(frame.id(), frame.kind(), data, len, t_us, Dir::Rx);
            }
            // Recoverable: our queue overflowed. Keep capturing — this is exactly
            // when the user needs the trace to stay alive. Only Disconnected ends it.
            Err(CanIoError::Lagged { dropped }) => {
                status.our_dropped.fetch_add(dropped, Ordering::Relaxed);
            }
            Err(CanIoError::Disconnected) => break,
            Err(e) => {
                log::warn!("analyzer rx: {e}");
            }
        }
    }
}

// ─────────────────────────── formatting helpers ───────────────────────────

fn kind_str(k: FrameKind) -> &'static str {
    match k {
        FrameKind::Data => "data",
        FrameKind::Fd { brs: true } => "fd_brs",
        FrameKind::Fd { brs: false } => "fd",
        FrameKind::Remote => "remote",
    }
}

fn hex(data: &[u8]) -> String {
    let mut s = String::with_capacity(data.len() * 3);
    for (i, b) in data.iter().enumerate() {
        if i > 0 {
            s.push(' ');
        }
        s.push_str(&format!("{b:02x}"));
    }
    s
}

fn trace_dto(rec: TraceRecord) -> TraceFrameDto {
    // Remote frames carry no data (only a requested DLC); show it as empty
    // rather than the zero-padded ring buffer.
    let data = if matches!(rec.kind, FrameKind::Remote) {
        String::new()
    } else {
        hex(&rec.data[..rec.len as usize])
    };
    TraceFrameDto {
        seq: rec.seq,
        t_us: rec.t_us,
        id: rec.id.raw(),
        extended: rec.id.is_extended(),
        kind: kind_str(rec.kind).to_string(),
        dlc: rec.len,
        data,
        dir: rec.dir.as_str().to_string(),
    }
}

fn agg_dto(key: AggKey, e: AggEntry, now_us: u64) -> AggRowDto {
    let (raw, extended) = key;
    let last_data = if matches!(e.last_kind, FrameKind::Remote) {
        String::new()
    } else {
        hex(&e.last_data[..e.last_len as usize])
    };
    // An ID that went silent shows 0 Hz instead of freezing at its last rate.
    let rate_hz = if now_us.saturating_sub(e.last_us) > RATE_STALE_US {
        0.0
    } else {
        e.rate_hz
    };
    AggRowDto {
        id: raw,
        extended,
        count: e.count,
        rate_hz,
        last_dlc: e.last_len,
        last_kind: kind_str(e.last_kind).to_string(),
        last_data,
        first_us: e.first_us,
        last_us: e.last_us,
    }
}
