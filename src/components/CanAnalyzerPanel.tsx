// CAN Analyzer — a passive bus sniffer + manual sender for debugging.
//
// Full-screen tool with its OWN bus connection (independent of the motor
// connect()). Two views: a live "trace" (one row per frame, virtualized, fixed
// cap) and "grouped by ID" (per-ID count / rate, sortable). A CANopen decode
// toggle, two filter kinds (node / id+mask), a status strip, and a manual-send
// widget. The kHz firehose is drained into refs by useCanTrace; only a 10 Hz
// tick re-renders.

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  App as AntdApp,
  Button,
  Card,
  Checkbox,
  Col,
  Input,
  InputNumber,
  Row,
  Segmented,
  Select,
  Space,
  Statistic,
  Switch,
  Table,
  Tabs,
  Tag,
  Tooltip,
  Typography,
} from "antd";
import { api, errMsg } from "../api";
import { nid2hex, parseNid } from "../format";
import { useI18n } from "../i18n";
import { decodeCanopen, kindColor } from "../canopen";
import { useCanTrace, ACTIVE_WINDOW_MS, type CanMode } from "../useCanTrace";
import type { CanAggRow, CanFilterSpec, CanSendSpec, CanTraceFrame } from "../types";

const ROW_H = 22;
const VIEW_H = 440;

type FilterType = "all" | "node" | "mask";

// SocketCAN (can0) only exists on Linux; elsewhere the gs_usb/candleLight
// userspace backend is the default. gs_usb0 = first adapter, channel 0.
const DEFAULT_IFACE = navigator.userAgent.includes("Linux") ? "can0" : "gs_usb0";

const idHex = (id: number, extended: boolean) =>
  "0x" + id.toString(16).toUpperCase().padStart(extended ? 8 : 3, "0");

const hexOk = (s: string) => /^\s*(0x)?[0-9a-fA-F]+\s*$/i.test(s);

/** Strict hex parse (CAN ids / masks are conventionally hex, bare or 0x-prefixed).
 *  Throws on trailing garbage instead of silently truncating like parseInt. */
function parseHexId(s: string): number {
  if (!hexOk(s)) throw new Error(`bad hex '${s}'`);
  return parseInt(s.trim().replace(/^0x/i, ""), 16);
}

/** CiA-309 integer, comeow semantics: bare digits = DECIMAL, 0x… = hex.
 *  Used by the SDO tab so index/sub/node all read the same way as comeow. */
const cia309Ok = (s: string) => /^\s*(0x[0-9a-fA-F]+|[0-9]+)\s*$/i.test(s);
function parseCia309Int(s: string): number {
  const t = s.trim();
  if (/^0x[0-9a-fA-F]+$/i.test(t)) return parseInt(t.slice(2), 16);
  if (/^[0-9]+$/.test(t)) return parseInt(t, 10);
  throw new Error(`bad number '${s}' (decimal or 0x-hex)`);
}

function parseHexBytes(s: string): number[] {
  const parts = s.trim().split(/[\s,]+/).filter(Boolean);
  return parts.map((p) => {
    const b = parseInt(p, 16);
    if (!Number.isInteger(b) || b < 0 || b > 255) throw new Error(`bad byte '${p}'`);
    return b;
  });
}

export function CanAnalyzerPanel() {
  const { message } = AntdApp.useApp();
  const { t } = useI18n();

  const [iface, setIface] = useState(DEFAULT_IFACE);
  const [hwTs, setHwTs] = useState(true);
  const [running, setRunning] = useState(false);
  const [connecting, setConnecting] = useState(false);

  const [mode, setMode] = useState<CanMode>("trace");
  const [interpret, setInterpret] = useState(true);
  const [paused, setPaused] = useState(false);

  const [filterType, setFilterType] = useState<FilterType>("all");
  const [node, setNode] = useState(1);
  const [includeNodeless, setIncludeNodeless] = useState(true);
  const [maskIdStr, setMaskIdStr] = useState("0x180");
  const [maskStr, setMaskStr] = useState("0x780");
  const [maskExt, setMaskExt] = useState(false);

  // Keep the last VALID mask so a mid-edit empty/partial field doesn't silently
  // flip the filter to "all" and flood the trace.
  const lastMaskRef = useRef<CanFilterSpec>({ kind: "all" });
  const filter: CanFilterSpec = useMemo(() => {
    if (filterType === "node") return { kind: "node", node, include_nodeless: includeNodeless };
    if (filterType === "mask") {
      try {
        const f: CanFilterSpec = { kind: "mask", id: parseHexId(maskIdStr), mask: parseHexId(maskStr), extended: maskExt };
        lastMaskRef.current = f;
        return f;
      } catch {
        return lastMaskRef.current;
      }
    }
    return { kind: "all" };
  }, [filterType, node, includeNodeless, maskIdStr, maskStr, maskExt]);

  const { bufRef, groupedRef, statusRef, rateRef, gapRef, evictedRef, lastActivityRef, healthRef, version, clear } =
    useCanTrace(running, mode, filter, paused);

  // Stop capture on unmount (tool switch also calls disconnect() as a safety net).
  useEffect(() => {
    return () => {
      api.analyzerStop().catch(() => {});
    };
  }, []);

  const connect = async () => {
    setConnecting(true);
    try {
      await api.analyzerStart(iface.trim(), hwTs);
      setRunning(true);
    } catch (e) {
      message.error(`${t("canConnectFailed")}: ${errMsg(e)}`);
    } finally {
      setConnecting(false);
    }
  };

  const disconnect = async () => {
    try {
      await api.analyzerStop();
    } catch {
      /* ignore */
    }
    setRunning(false);
  };

  const status = statusRef.current;
  // Active = a frame arrived within ACTIVE_WINDOW_MS (re-evaluated each render
  // tick), so a slow heartbeat keeps it green instead of flickering idle.
  const active = running && performance.now() - lastActivityRef.current < ACTIVE_WINDOW_MS;
  void version; // re-render trigger

  return (
    <Space direction="vertical" size={12} style={{ width: "100%" }}>
      {/* connection */}
      <Card size="small">
        <Space wrap>
          <Typography.Text strong>{t("canBus")}</Typography.Text>
          <Tooltip title={t("canConnectHint")}>
            <Input
              value={iface}
              onChange={(e) => setIface(e.target.value)}
              style={{ width: 160 }}
              disabled={running}
              placeholder="can0 / gs_usb"
            />
          </Tooltip>
          <Tooltip title={t("canHwTsHint")}>
            <Checkbox checked={hwTs} disabled={running} onChange={(e) => setHwTs(e.target.checked)}>
              {t("canHwTs")}
            </Checkbox>
          </Tooltip>
          {running ? (
            <Button danger onClick={disconnect}>
              {t("disconnect")}
            </Button>
          ) : (
            <Button type="primary" loading={connecting} onClick={connect}>
              {t("connect")}
            </Button>
          )}
        </Space>
      </Card>

      {/* status strip */}
      <StatusStrip
        running={running}
        active={active}
        rate={rateRef.current}
        total={status?.total ?? 0}
        distinct={status?.distinct_ids ?? 0}
        guiDrops={status?.our_dropped ?? 0}
        aggOverflow={status?.agg_overflow ?? 0}
        hwTs={status?.hw_ts ?? false}
        health={healthRef.current}
      />

      <Row gutter={12}>
        <Col flex="auto">
          {/* controls */}
          <Card size="small" style={{ marginBottom: 12 }}>
            <Space wrap size={12}>
              <Segmented
                value={mode}
                onChange={(v) => setMode(v as CanMode)}
                options={[
                  { label: t("canModeTrace"), value: "trace" },
                  { label: t("canModeGrouped"), value: "grouped" },
                ]}
              />
              <Space size={4}>
                <Switch checked={interpret} onChange={setInterpret} size="small" />
                <Typography.Text>{t("canInterpret")}</Typography.Text>
              </Space>
              <Select<FilterType>
                value={filterType}
                onChange={setFilterType}
                style={{ width: 130 }}
                options={[
                  { label: t("canFilterAll"), value: "all" },
                  { label: t("canFilterNode"), value: "node" },
                  { label: t("canFilterMask"), value: "mask" },
                ]}
              />
              {filterType === "node" && (
                <>
                  <InputNumber
                    min={0}
                    max={127}
                    value={node}
                    onChange={(v) => setNode(v ?? 1)}
                    addonBefore={t("canNode")}
                    style={{ width: 130 }}
                  />
                  <Checkbox checked={includeNodeless} onChange={(e) => setIncludeNodeless(e.target.checked)}>
                    {t("canIncludeNodeless")}
                  </Checkbox>
                </>
              )}
              {filterType === "mask" && (
                <>
                  <Input
                    value={maskIdStr}
                    onChange={(e) => setMaskIdStr(e.target.value)}
                    addonBefore={t("canId")}
                    status={hexOk(maskIdStr) ? undefined : "error"}
                    style={{ width: 150 }}
                  />
                  <Input
                    value={maskStr}
                    onChange={(e) => setMaskStr(e.target.value)}
                    addonBefore={t("canMask")}
                    status={hexOk(maskStr) ? undefined : "error"}
                    style={{ width: 150 }}
                  />
                  <Checkbox checked={maskExt} onChange={(e) => setMaskExt(e.target.checked)}>
                    {t("canExt")}
                  </Checkbox>
                </>
              )}
              {mode === "trace" && (
                <>
                  <Button size="small" onClick={() => setPaused((p) => !p)}>
                    {paused ? t("canResume") : t("canPause")}
                  </Button>
                  <Tag color={paused ? "orange" : "green"}>{paused ? t("canFrozen") : t("canLive")}</Tag>
                </>
              )}
              <Button size="small" onClick={clear}>
                {t("canClear")}
              </Button>
            </Space>
          </Card>

          {gapRef.current && mode === "trace" && (
            <Alert type="warning" banner showIcon message={t("canGap")} style={{ marginBottom: 12 }} />
          )}
          {(status?.agg_overflow ?? 0) > 0 && (
            <Alert type="warning" banner showIcon message={t("canAggOverflow")} style={{ marginBottom: 12 }} />
          )}

          {!running ? (
            <Card size="small">
              <Typography.Text type="secondary">{t("canNotCapturing")}</Typography.Text>
            </Card>
          ) : mode === "trace" ? (
            <TraceList
              frames={bufRef.current}
              interpret={interpret}
              paused={paused}
              version={version}
              evictedRef={evictedRef}
            />
          ) : (
            <GroupedTable rows={groupedRef.current} interpret={interpret} />
          )}
        </Col>

        {/* manual send / SDO client — 二选一 */}
        <Col flex="340px">
          <Card size="small" styles={{ body: { paddingTop: 0 } }}>
            <Tabs
              size="small"
              items={[
                {
                  key: "send",
                  label: t("canTabSend"),
                  children: (
                    <SendWidget running={running} fd={status?.fd ?? false} maxDlen={status?.max_dlen ?? 8} />
                  ),
                },
                {
                  key: "sdo",
                  label: "SDO",
                  children: <SdoWidget running={running} />,
                },
              ]}
            />
          </Card>
        </Col>
      </Row>
    </Space>
  );
}

/** Chip color per controller state, matching CAN fault-confinement severity. */
function stateColor(s: string): string {
  switch (s) {
    case "error_active":
      return "green";
    case "error_warning":
      return "gold";
    case "error_passive":
      return "orange";
    case "bus_off":
      return "red";
    default:
      return "default"; // stopped / sleeping
  }
}

function StatusStrip({
  running,
  active,
  rate,
  total,
  distinct,
  guiDrops,
  aggOverflow,
  hwTs,
  health,
}: {
  running: boolean;
  active: boolean;
  rate: number;
  total: number;
  distinct: number;
  guiDrops: number;
  aggOverflow: number;
  hwTs: boolean;
  health: import("../types").CanBusHealth | null;
}) {
  const { t } = useI18n();
  void aggOverflow;
  const stateKey = health?.supported && health.state ? health.state : null;
  return (
    <Card size="small">
      <Space wrap size={24}>
        <Space size={6}>
          <Tag color={running ? (active ? "green" : "default") : "red"}>
            {running ? (active ? t("canActive") : t("canIdle")) : t("canStopped")}
          </Tag>
          {running && hwTs && (
            <Tooltip title={t("canHwTsActiveHint")}>
              <Tag color="geekblue">HW ts</Tag>
            </Tooltip>
          )}
          {stateKey && (
            <Tooltip title={t("canCtrlStateHint")}>
              <Tag color={stateColor(stateKey)}>
                {stateKey === "error_active"
                  ? t("canStateErrorActive")
                  : stateKey === "error_warning"
                    ? t("canStateErrorWarning")
                    : stateKey === "error_passive"
                      ? t("canStateErrorPassive")
                      : stateKey === "bus_off"
                        ? t("canStateBusOff")
                        : stateKey === "stopped"
                          ? t("canStateStopped")
                          : t("canStateSleeping")}
              </Tag>
            </Tooltip>
          )}
        </Space>
        <Statistic title={t("canRxRate")} value={running ? Math.round(rate) : 0} suffix="fps" valueStyle={{ fontSize: 18 }} />
        <Statistic title={t("canTotal")} value={total} valueStyle={{ fontSize: 18 }} />
        <Statistic title={t("canDistinct")} value={distinct} valueStyle={{ fontSize: 18 }} />
        <Statistic
          title={
            <Tooltip title={t("canGuiDropsHint")}>
              <span>{t("canGuiDrops")} ⓘ</span>
            </Tooltip>
          }
          value={guiDrops}
          valueStyle={{ fontSize: 18, color: guiDrops > 0 ? "#faad14" : undefined }}
        />
        <Statistic
          title={
            <Tooltip title={t("canErrHint")}>
              <span>{t("canErrCounters")} ⓘ</span>
            </Tooltip>
          }
          value={
            health?.supported && (health.tx_errors != null || health.rx_errors != null)
              ? `TX ${health.tx_errors ?? "—"} / RX ${health.rx_errors ?? "—"}`
              : "—"
          }
          valueStyle={{
            fontSize: 18,
            color:
              (health?.tx_errors ?? 0) > 0 || (health?.rx_errors ?? 0) > 0 ? "#faad14" : undefined,
          }}
        />
      </Space>
    </Card>
  );
}

function TraceList({
  frames,
  interpret,
  paused,
  version,
  evictedRef,
}: {
  frames: CanTraceFrame[];
  interpret: boolean;
  paused: boolean;
  version: number;
  evictedRef: React.MutableRefObject<number>;
}) {
  const { t } = useI18n();
  const scrollRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);
  const lastEvictedRef = useRef(0);
  const [scrollTop, setScrollTop] = useState(0);
  const total = frames.length;

  // Each tick: pin to bottom if the user is there, otherwise compensate for
  // rows evicted from the front so the frames under inspection stay put.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (!paused && atBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    } else {
      const delta = evictedRef.current - lastEvictedRef.current;
      if (delta > 0) {
        const next = Math.max(0, el.scrollTop - delta * ROW_H);
        el.scrollTop = next;
        setScrollTop(next);
      }
    }
    lastEvictedRef.current = evictedRef.current;
  });

  const onScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < ROW_H * 2;
    setScrollTop(el.scrollTop);
  };

  const start = Math.max(0, Math.floor(scrollTop / ROW_H) - 6);
  const end = Math.min(total, Math.ceil((scrollTop + VIEW_H) / ROW_H) + 6);
  const visible = frames.slice(start, end);
  void version;

  return (
    <Card size="small" styles={{ body: { padding: 0 } }}>
      <div style={{ display: "flex", padding: "4px 10px", borderBottom: "1px solid #303030", fontSize: 12, color: "#888", fontFamily: "monospace" }}>
        <span style={{ width: 64 }}>{t("canColSeq")}</span>
        <span style={{ width: 84 }}>{t("canColTime")}</span>
        <Tooltip title={t("canDirHint")}>
          <span style={{ width: 34, cursor: "help", textDecoration: "underline dotted" }}>
            {t("canColDir")}
          </span>
        </Tooltip>
        <span style={{ width: 130 }}>{t("canColId")}</span>
        <span style={{ width: 88 }}>{t("canColKind")}</span>
        <span style={{ width: 34 }}>{t("canColDlc")}</span>
        <span style={{ flex: 1 }}>{t("canColData")}</span>
      </div>
      <div ref={scrollRef} onScroll={onScroll} style={{ height: VIEW_H, overflow: "auto", fontFamily: "monospace", fontSize: 12.5 }}>
        <div style={{ height: total * ROW_H, position: "relative" }}>
          {visible.map((f, i) => (
            <TraceRow key={f.seq} f={f} interpret={interpret} top={(start + i) * ROW_H} />
          ))}
        </div>
      </div>
    </Card>
  );
}

function TraceRow({ f, interpret, top }: { f: CanTraceFrame; interpret: boolean; top: number }) {
  const dec = interpret ? decodeCanopen(f.id, f.extended, hexToBytes(f.data)) : null;
  return (
    <div
      style={{
        position: "absolute",
        top,
        height: ROW_H,
        left: 0,
        right: 0,
        display: "flex",
        alignItems: "center",
        padding: "0 10px",
        whiteSpace: "nowrap",
        background: f.dir === "tx" ? "rgba(79,140,255,0.10)" : undefined,
      }}
    >
      <span style={{ width: 64, color: "#666" }}>{f.seq}</span>
      <span style={{ width: 84, color: "#999" }}>{(f.t_us / 1000).toFixed(1)}</span>
      <span style={{ width: 34 }}>
        {f.dir === "tx" ? <Tag color="blue" style={{ marginInlineEnd: 0 }}>TX</Tag> : <span style={{ color: "#555" }}>rx</span>}
      </span>
      <span style={{ width: 130 }}>
        {dec ? (
          <Tag color={kindColor(dec.kind)} style={{ marginInlineEnd: 0 }}>{dec.label}</Tag>
        ) : (
          <span>{idHex(f.id, f.extended)}</span>
        )}
      </span>
      <span style={{ width: 88, color: "#aaa" }}>{dec?.detail ?? f.kind}</span>
      <span style={{ width: 34, color: "#999" }}>{f.dlc}</span>
      <span style={{ flex: 1, color: "#ddd" }}>{f.data}</span>
    </div>
  );
}

function hexToBytes(s: string): number[] {
  if (!s) return [];
  return s.split(" ").filter(Boolean).map((x) => parseInt(x, 16));
}

function GroupedTable({ rows, interpret }: { rows: CanAggRow[]; interpret: boolean }) {
  const { t } = useI18n();
  const columns = [
    {
      title: t("canColId"),
      key: "id",
      sorter: (a: CanAggRow, b: CanAggRow) => a.id - b.id,
      render: (_: unknown, r: CanAggRow) => {
        if (!interpret) return <span style={{ fontFamily: "monospace" }}>{idHex(r.id, r.extended)}</span>;
        const dec = decodeCanopen(r.id, r.extended, []);
        return (
          <Space size={4}>
            <Tag color={kindColor(dec.kind)} style={{ marginInlineEnd: 0 }}>{dec.label}</Tag>
            <span style={{ fontFamily: "monospace", color: "#888" }}>{idHex(r.id, r.extended)}</span>
          </Space>
        );
      },
    },
    {
      title: t("canColCount"),
      dataIndex: "count",
      key: "count",
      width: 110,
      sorter: (a: CanAggRow, b: CanAggRow) => a.count - b.count,
      defaultSortOrder: "descend" as const,
    },
    {
      title: t("canColRate"),
      key: "rate",
      width: 110,
      sorter: (a: CanAggRow, b: CanAggRow) => a.rate_hz - b.rate_hz,
      render: (_: unknown, r: CanAggRow) => `${r.rate_hz.toFixed(1)} Hz`,
    },
    { title: t("canColDlc"), dataIndex: "last_dlc", key: "dlc", width: 60 },
    {
      title: t("canColData"),
      dataIndex: "last_data",
      key: "data",
      render: (v: string) => <span style={{ fontFamily: "monospace", fontSize: 12.5 }}>{v}</span>,
    },
  ];
  return (
    <Table<CanAggRow>
      size="small"
      rowKey={(r) => `${r.extended ? "e" : "s"}:${r.id}`}
      columns={columns}
      dataSource={rows}
      pagination={false}
      scroll={{ y: VIEW_H }}
    />
  );
}

function SendWidget({ running, fd, maxDlen }: { running: boolean; fd: boolean; maxDlen: number }) {
  const { message } = AntdApp.useApp();
  const { t } = useI18n();
  const [idStr, setIdStr] = useState("0x123");
  const [ext, setExt] = useState(false);
  const [isFd, setIsFd] = useState(false);
  const [brs, setBrs] = useState(false);
  const [rtr, setRtr] = useState(false);
  const [dataStr, setDataStr] = useState("11 22 33");
  const [rtrDlc, setRtrDlc] = useState(0);
  const [periodMs, setPeriodMs] = useState(100);
  const [repeating, setRepeating] = useState(false);
  const busyRef = useRef(false);
  const timerRef = useRef<number | null>(null);

  // Mirror the live inputs into a ref so the repeat interval (whose closure is
  // captured once at toggle time) always transmits the CURRENT field values.
  const liveRef = useRef({ idStr, ext, isFd, brs, rtr, dataStr, rtrDlc, fd });
  liveRef.current = { idStr, ext, isFd, brs, rtr, dataStr, rtrDlc, fd };

  const buildSpec = (): CanSendSpec => {
    const s = liveRef.current;
    return {
      id: parseHexId(s.idStr),
      extended: s.ext,
      fd: s.isFd && s.fd,
      brs: s.brs && s.isFd && s.fd,
      rtr: s.rtr,
      dlc: s.rtr ? s.rtrDlc : 0,
      data: s.rtr ? [] : parseHexBytes(s.dataStr),
    };
  };

  const sendOnce = async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    try {
      await api.analyzerSend(buildSpec());
    } catch (e) {
      message.error(`${t("canSendFailed")}: ${errMsg(e)}`);
      stopRepeat();
    } finally {
      busyRef.current = false;
    }
  };

  const stopRepeat = () => {
    if (timerRef.current != null) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
    setRepeating(false);
  };

  const toggleRepeat = () => {
    if (repeating) {
      stopRepeat();
    } else {
      try {
        buildSpec(); // validate before starting
      } catch (e) {
        message.error(`${t("canSendFailed")}: ${errMsg(e)}`);
        return;
      }
      setRepeating(true);
      timerRef.current = window.setInterval(sendOnce, Math.max(1, periodMs));
    }
  };

  useEffect(() => () => stopRepeat(), []);
  // Stop repeating if we disconnect.
  useEffect(() => {
    if (!running) stopRepeat();
  }, [running]);

  const maxBytes = isFd && fd ? maxDlen : 8;
  return (
    <Space direction="vertical" size={8} style={{ width: "100%" }}>
        <Input addonBefore={t("canId")} value={idStr} onChange={(e) => setIdStr(e.target.value)} />
        <Space wrap>
          <Checkbox checked={ext} onChange={(e) => setExt(e.target.checked)}>{t("canExt")}</Checkbox>
          <Checkbox checked={isFd} disabled={!fd || rtr} onChange={(e) => setIsFd(e.target.checked)}>FD</Checkbox>
          <Checkbox checked={brs} disabled={!isFd || !fd} onChange={(e) => setBrs(e.target.checked)}>BRS</Checkbox>
          <Checkbox checked={rtr} disabled={isFd} onChange={(e) => setRtr(e.target.checked)}>RTR</Checkbox>
        </Space>
        {rtr ? (
          <InputNumber
            min={0}
            max={8}
            value={rtrDlc}
            onChange={(v) => setRtrDlc(v ?? 0)}
            addonBefore={t("canRtrDlc")}
            style={{ width: "100%" }}
          />
        ) : (
          <Input.TextArea
            value={dataStr}
            onChange={(e) => setDataStr(e.target.value)}
            autoSize={{ minRows: 1, maxRows: 3 }}
            placeholder={t("canDataHint")}
          />
        )}
        {!rtr && (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {t("canMaxBytes")}: {maxBytes}
          </Typography.Text>
        )}
        <Button type="primary" block disabled={!running} onClick={sendOnce}>
          {t("canSendBtn")}
        </Button>
        <Space>
          <InputNumber
            min={1}
            value={periodMs}
            onChange={(v) => setPeriodMs(v ?? 100)}
            addonAfter="ms"
            style={{ width: 120 }}
            disabled={repeating}
          />
          <Button danger={repeating} disabled={!running} onClick={toggleRepeat}>
            {repeating ? t("canStop") : t("canRepeat")}
          </Button>
        </Space>
    </Space>
  );
}

// ───────────────────────── SDO tab (comeow engine) ─────────────────────────

/** CiA-309 datatype tokens, same set as comeow. "raw" = read without a type. */
const SDO_TYPES = [
  "raw", "b", "u8", "u16", "u32", "u64", "x8", "x16", "x32", "x64",
  "i8", "i16", "i32", "i64", "r32", "r64", "vs", "hex",
];

interface SdoLogLine {
  id: number;
  text: string;
  ok: boolean;
}

function SdoWidget({ running }: { running: boolean }) {
  const { t } = useI18n();
  const [nodeStr, setNodeStr] = useState("0x10");
  const [indexStr, setIndexStr] = useState("0x1018");
  const [subStr, setSubStr] = useState("0x00");
  const [dtype, setDtype] = useState("raw");
  const [valueStr, setValueStr] = useState("");
  const [timeoutMs, setTimeoutMs] = useState(500);
  const [retries, setRetries] = useState(1);
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState<SdoLogLine[]>([]);
  const logIdRef = useRef(0);
  const logRef = useRef<HTMLDivElement>(null);

  // Keep the result console scrolled to the newest line.
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [log]);

  const append = (text: string, ok: boolean) =>
    setLog((l) => [...l.slice(-199), { id: ++logIdRef.current, text, ok }]);

  const run = async (op: "r" | "w") => {
    if (busy) return;
    setBusy(true);
    try {
      // comeow semantics on all three fields: bare digits = decimal, 0x = hex.
      const node = parseNid(nodeStr);
      const index = parseCia309Int(indexStr);
      const sub = parseCia309Int(subStr);
      if (index > 0xffff) throw new Error(`index > 0xFFFF: ${indexStr}`);
      if (sub > 0xff) throw new Error(`sub > 0xFF: ${subStr}`);
      const res =
        op === "r"
          ? await api.analyzerSdoRead(node, index, sub, dtype === "raw" ? null : dtype, timeoutMs, retries)
          : await api.analyzerSdoWrite(node, index, sub, dtype, valueStr, timeoutMs, retries);
      append(`${op} ${nid2hex(node)}  ${res}`, true);
    } catch (e) {
      append(`✗ ${errMsg(e)}`, false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Space direction="vertical" size={8} style={{ width: "100%" }}>
      <Space.Compact style={{ width: "100%" }}>
        <Input
          addonBefore={t("canNode")}
          value={nodeStr}
          onChange={(e) => setNodeStr(e.target.value)}
          status={cia309Ok(nodeStr) ? undefined : "error"}
        />
      </Space.Compact>
      <Tooltip title={t("canSdoRadixHint")}>
        <Space.Compact style={{ width: "100%" }}>
          <Input
            addonBefore={t("canSdoIndex")}
            value={indexStr}
            onChange={(e) => setIndexStr(e.target.value)}
            status={cia309Ok(indexStr) ? undefined : "error"}
            style={{ width: "62%" }}
          />
          <Input
            addonBefore={t("canSdoSub")}
            value={subStr}
            onChange={(e) => setSubStr(e.target.value)}
            status={cia309Ok(subStr) ? undefined : "error"}
            style={{ width: "38%" }}
          />
        </Space.Compact>
      </Tooltip>
      <Space.Compact style={{ width: "100%" }}>
        <Select
          value={dtype}
          onChange={setDtype}
          options={SDO_TYPES.map((v) => ({ value: v, label: v === "raw" ? t("canSdoTypeRaw") : v }))}
          style={{ width: "38%" }}
        />
        <Input
          value={valueStr}
          onChange={(e) => setValueStr(e.target.value)}
          placeholder={t("canSdoValue")}
          style={{ width: "62%" }}
        />
      </Space.Compact>
      <Space>
        <Button type="primary" loading={busy} disabled={!running} onClick={() => run("r")}>
          {t("canSdoRead")}
        </Button>
        <Tooltip title={dtype === "raw" ? t("canSdoNeedType") : undefined}>
          <Button danger loading={busy} disabled={!running || dtype === "raw"} onClick={() => run("w")}>
            {t("canSdoWrite")}
          </Button>
        </Tooltip>
        <Button size="small" onClick={() => setLog([])}>
          {t("canClear")}
        </Button>
      </Space>
      <Space>
        <InputNumber
          min={10}
          value={timeoutMs}
          onChange={(v) => setTimeoutMs(v ?? 500)}
          addonAfter="ms"
          style={{ width: 130 }}
        />
        <InputNumber
          min={0}
          max={10}
          value={retries}
          onChange={(v) => setRetries(v ?? 1)}
          addonBefore={t("canSdoRetries")}
          style={{ width: 130 }}
        />
      </Space>
      <div
        ref={logRef}
        style={{
          height: 170,
          overflow: "auto",
          fontFamily: "monospace",
          fontSize: 12,
          background: "rgba(0,0,0,0.25)",
          borderRadius: 6,
          padding: "6px 8px",
        }}
      >
        {log.length === 0 ? (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {t("canSdoLogEmpty")}
          </Typography.Text>
        ) : (
          log.map((l) => (
            <div key={l.id} style={{ color: l.ok ? "#ddd" : "#ff7875", whiteSpace: "pre-wrap" }}>
              {l.text}
            </div>
          ))
        )}
      </div>
    </Space>
  );
}
