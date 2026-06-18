import { memo, useCallback, useEffect, useRef, useState } from "react";
import {
  App as AntdApp,
  Button,
  Card,
  Checkbox,
  Col,
  Empty,
  InputNumber,
  Row,
  Slider,
  Space,
  Statistic,
  Table,
  Tag,
  Typography,
} from "antd";
import ReactECharts from "echarts-for-react";
import { api, errMsg } from "../api";
import { useI18n } from "../i18n";
import { nid2hex } from "../format";
import type { Hopea3Motor, Hopea3State } from "../types";

const POLL_MS = 50; // 20 Hz UI poll (control/odom run at 500 Hz in Rust)
const MAX_TRAJ_POINTS = 3000;
const MANUAL_MS = 33; // ~30 Hz manual-input (keyboard/gamepad) loop
const PAD_DEADZONE = 0.12;

// WASD = XY translate, QE = yaw. Mapped to ROS: +vx fwd, +vy left, +wz CCW.
const KEY_MAP: Record<string, "fwd" | "back" | "left" | "right" | "ccw" | "cw"> = {
  w: "fwd", s: "back", a: "left", d: "right", q: "ccw", e: "cw",
};

export function Hopea3Panel({ connected }: { connected: boolean }) {
  const { message } = AntdApp.useApp();
  const { t } = useI18n();

  const [running, setRunning] = useState(false);
  const [starting, setStarting] = useState(false);
  const [initProg, setInitProg] = useState<{ current: number; total: number; attempt: number } | null>(null);
  const [state, setState] = useState<Hopea3State | null>(null);

  // Command sliders (local; pushed to backend on change).
  const [vx, setVx] = useState(0);
  const [vy, setVy] = useState(0);
  const [wz, setWz] = useState(0);
  // Limits + torque (applied on button).
  const [maxLinear, setMaxLinear] = useState(3);
  const [maxAngular, setMaxAngular] = useState(3);
  const [torque, setTorque] = useState<[number, number, number]>([800, 800, 800]);
  const [kd, setKd] = useState<[number, number, number]>([0.1, 0.1, 0.1]);

  // Manual drive (keyboard / gamepad). Full deflection = these speeds.
  const [keyboardEnabled, setKeyboardEnabled] = useState(true);
  const [manualLinear, setManualLinear] = useState(1.0);
  const [manualAngular, setManualAngular] = useState(1.5);
  const [padName, setPadName] = useState<string | null>(null);
  const keysDown = useRef<Set<string>>(new Set());
  const manualWasActive = useRef(false);

  // Trajectory ring buffer (world frame).
  const traj = useRef<{ x: number; y: number }[]>([]);
  const [trajVersion, setTrajVersion] = useState(0);

  // Poll backend state while running.
  useEffect(() => {
    if (!running) return;
    let alive = true;
    const tick = async () => {
      try {
        const s = await api.hopea3GetState();
        if (!alive) return;
        setState(s);
        if (s.running) {
          const buf = traj.current;
          const last = buf[buf.length - 1];
          if (!last || Math.hypot(s.pose_x - last.x, s.pose_y - last.y) > 1e-4) {
            buf.push({ x: s.pose_x, y: s.pose_y });
            if (buf.length > MAX_TRAJ_POINTS) buf.shift();
            setTrajVersion((v) => v + 1);
          }
        }
      } catch {
        /* transient */
      }
    };
    tick();
    const h = window.setInterval(tick, POLL_MS);
    return () => {
      alive = false;
      window.clearInterval(h);
    };
  }, [running]);

  // While starting, poll init progress so the user sees which motor is going.
  useEffect(() => {
    if (!starting) {
      setInitProg(null);
      return;
    }
    let alive = true;
    const tick = async () => {
      try {
        const p = await api.hopea3InitProgress();
        if (alive && p.active) setInitProg({ current: p.current, total: p.total, attempt: p.attempt });
      } catch {
        /* transient */
      }
    };
    tick();
    const h = window.setInterval(tick, 150);
    return () => { alive = false; window.clearInterval(h); };
  }, [starting]);

  const start = useCallback(async () => {
    setStarting(true);
    try {
      await api.hopea3Start();
      traj.current = [];
      setTrajVersion((v) => v + 1);
      setRunning(true);
      message.success(t("hopeRunning"));
    } catch (e) {
      message.error(`${t("hopeStartFailed")}: ${errMsg(e)}`);
    } finally {
      setStarting(false);
    }
  }, [message, t]);

  const stop = useCallback(async () => {
    try {
      await api.hopea3Stop();
    } catch (e) {
      message.error(errMsg(e));
    }
    setRunning(false);
    setVx(0);
    setVy(0);
    setWz(0);
    setState(null);
  }, [message]);

  // If the bus disconnects under us, drop back to the stopped view.
  useEffect(() => {
    if (!connected && running) {
      setRunning(false);
      setState(null);
    }
  }, [connected, running]);

  // Gamepad connect/disconnect → show its name (polling happens in the loop).
  useEffect(() => {
    const onConnect = (e: GamepadEvent) => setPadName(e.gamepad.id);
    const onDisconnect = () => {
      const pads = navigator.getGamepads?.() ?? [];
      const still = Array.from(pads).find((p) => p);
      setPadName(still ? still.id : null);
    };
    window.addEventListener("gamepadconnected", onConnect);
    window.addEventListener("gamepaddisconnected", onDisconnect);
    return () => {
      window.removeEventListener("gamepadconnected", onConnect);
      window.removeEventListener("gamepaddisconnected", onDisconnect);
    };
  }, []);

  // Keyboard key tracking (WASD/QE), only while running and not typing in a field.
  useEffect(() => {
    if (!running || !keyboardEnabled) {
      keysDown.current.clear();
      return;
    }
    const typing = () => {
      const tag = (document.activeElement?.tagName ?? "").toLowerCase();
      return tag === "input" || tag === "textarea";
    };
    const onDown = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase();
      if (!(k in KEY_MAP) || typing()) return;
      e.preventDefault();
      keysDown.current.add(k);
    };
    const onUp = (e: KeyboardEvent) => keysDown.current.delete(e.key.toLowerCase());
    const onBlur = () => keysDown.current.clear();
    window.addEventListener("keydown", onDown);
    window.addEventListener("keyup", onUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onDown);
      window.removeEventListener("keyup", onUp);
      window.removeEventListener("blur", onBlur);
      keysDown.current.clear();
    };
  }, [running, keyboardEnabled]);

  // Manual-input loop: gamepad takes priority over keyboard; releasing all
  // input sends one zero then yields the command back to the sliders.
  useEffect(() => {
    if (!running) return;
    const h = window.setInterval(() => {
      const gp = readGamepad(manualLinear, manualAngular);
      const kb = keyboardEnabled ? readKeyboard(keysDown.current, manualLinear, manualAngular) : null;
      const drive = gp ?? kb;
      if (drive) {
        api.hopea3SetCmd(drive.vx, drive.vy, drive.wz).catch(() => {});
        setVx(round2(drive.vx));
        setVy(round2(drive.vy));
        setWz(round2(drive.wz));
        manualWasActive.current = true;
      } else if (manualWasActive.current) {
        api.hopea3SetCmd(0, 0, 0).catch(() => {});
        setVx(0);
        setVy(0);
        setWz(0);
        manualWasActive.current = false;
      }
    }, MANUAL_MS);
    return () => window.clearInterval(h);
  }, [running, keyboardEnabled, manualLinear, manualAngular]);

  const clearErrors = useCallback(async () => {
    try {
      await api.hopea3ClearErrors();
      message.success(t("hopeCleared"));
    } catch (e) {
      message.error(errMsg(e));
    }
  }, [message, t]);

  const pushCmd = useCallback((nvx: number, nvy: number, nwz: number) => {
    api.hopea3SetCmd(nvx, nvy, nwz).catch(() => {});
  }, []);

  const onVx = (v: number | null) => { const n = v ?? 0; setVx(n); pushCmd(n, vy, wz); };
  const onVy = (v: number | null) => { const n = v ?? 0; setVy(n); pushCmd(vx, n, wz); };
  const onWz = (v: number | null) => { const n = v ?? 0; setWz(n); pushCmd(vx, vy, n); };
  const zeroMotion = () => { setVx(0); setVy(0); setWz(0); pushCmd(0, 0, 0); };

  const applyLimits = async () => {
    try {
      await api.hopea3SetLimits(maxLinear, maxAngular);
    } catch (e) {
      message.error(errMsg(e));
    }
  };
  const applyTorque = async (next: [number, number, number]) => {
    setTorque(next);
    try {
      await api.hopea3SetMaxTorque(next);
    } catch (e) {
      message.error(errMsg(e));
    }
  };
  const applyKd = async (next: [number, number, number]) => {
    setKd(next);
    try {
      await api.hopea3SetKd(next);
    } catch (e) {
      message.error(errMsg(e));
    }
  };

  if (!connected) {
    return (
      <div style={{ paddingTop: 80 }}>
        <Empty description={t("hopeConnectFirst")} />
      </div>
    );
  }

  return (
    <Space direction="vertical" size={16} style={{ width: "100%" }}>
      <Card>
        <Space>
          {!running ? (
            <Button type="primary" loading={starting} onClick={start}>
              {starting
                ? initProg
                  ? `${t("hopeStarting")} ${initProg.current}/${initProg.total}${initProg.attempt > 1 ? ` (#${initProg.attempt})` : ""}`
                  : t("hopeStarting")
                : t("hopeStart")}
            </Button>
          ) : (
            <Button danger onClick={stop}>
              {t("hopeStop")}
            </Button>
          )}
          {!running && (
            <Button onClick={clearErrors}>{t("hopeClearErrors")}</Button>
          )}
          <Tag color={running ? "green" : "default"}>
            {running ? t("hopeRunning") : t("hopeStopped")}
          </Tag>
        </Space>
      </Card>

      {running && (
        <>
          <Row gutter={16}>
            <Col xs={24} lg={10}>
              <Card title={t("hopeCmdTwist")} size="small">
                <CmdSlider label={t("hopeVx")} value={vx} min={-maxLinear} max={maxLinear} step={0.05} onChange={onVx} />
                <CmdSlider label={t("hopeVy")} value={vy} min={-maxLinear} max={maxLinear} step={0.05} onChange={onVy} />
                <CmdSlider label={t("hopeWz")} value={wz} min={-maxAngular} max={maxAngular} step={0.05} onChange={onWz} />
                <Button block onClick={zeroMotion}>{t("hopeStopMotion")}</Button>
              </Card>

              <Card title={t("hopeManual")} size="small" style={{ marginTop: 16 }}>
                <Checkbox checked={keyboardEnabled} onChange={(e) => setKeyboardEnabled(e.target.checked)}>
                  {t("hopeKeyboard")}
                </Checkbox>
                <Typography.Paragraph type="secondary" style={{ fontSize: 12, margin: "6px 0" }}>
                  {t("hopeKeyHint")}
                </Typography.Paragraph>
                <Space style={{ marginBottom: 8 }}>
                  <Typography.Text type="secondary">{t("hopeGamepad")}:</Typography.Text>
                  <Tag color={padName ? "green" : "default"}>{padName ?? t("hopeGamepadNone")}</Tag>
                </Space>
                <Space wrap align="end">
                  <Labeled label={t("hopeManualLinear")}>
                    <InputNumber min={0} step={0.1} value={manualLinear} onChange={(v) => setManualLinear(v ?? 0)} />
                  </Labeled>
                  <Labeled label={t("hopeManualAngular")}>
                    <InputNumber min={0} step={0.1} value={manualAngular} onChange={(v) => setManualAngular(v ?? 0)} />
                  </Labeled>
                </Space>
              </Card>

              <Card title={t("hopeLimits")} size="small" style={{ marginTop: 16 }}>
                <Space wrap align="end">
                  <Labeled label={t("hopeMaxLinear")}>
                    <InputNumber min={0} step={0.1} value={maxLinear} onChange={(v) => setMaxLinear(v ?? 0)} />
                  </Labeled>
                  <Labeled label={t("hopeMaxAngular")}>
                    <InputNumber min={0} step={0.1} value={maxAngular} onChange={(v) => setMaxAngular(v ?? 0)} />
                  </Labeled>
                  <Button onClick={applyLimits}>{t("apply")}</Button>
                </Space>
                <div style={{ marginTop: 12 }}>
                  <Typography.Text type="secondary">{t("hopeMaxTorque")}</Typography.Text>
                  <Space wrap style={{ marginTop: 6 }}>
                    {[0, 1, 2].map((i) => (
                      <InputNumber
                        key={i}
                        addonBefore={i + 1}
                        min={0}
                        max={1000}
                        value={torque[i]}
                        onChange={(v) => {
                          const next = [...torque] as [number, number, number];
                          next[i] = v ?? 0;
                          applyTorque(next);
                        }}
                        style={{ width: 130 }}
                      />
                    ))}
                  </Space>
                </div>
                <div style={{ marginTop: 12 }}>
                  <Typography.Text type="secondary">{t("hopeKd")}</Typography.Text>
                  <Space wrap style={{ marginTop: 6 }}>
                    {[0, 1, 2].map((i) => (
                      <InputNumber
                        key={i}
                        addonBefore={i + 1}
                        min={0}
                        step={0.05}
                        value={kd[i]}
                        onChange={(v) => {
                          const next = [...kd] as [number, number, number];
                          next[i] = v ?? 0;
                          applyKd(next);
                        }}
                        style={{ width: 130 }}
                      />
                    ))}
                  </Space>
                </div>
              </Card>

              <Card title={t("hopeMeasTwist")} size="small" style={{ marginTop: 16 }}>
                <Row gutter={8}>
                  <Col span={8}><Statistic title="vx (m/s)" value={fmt(state?.meas_vx)} /></Col>
                  <Col span={8}><Statistic title="vy (m/s)" value={fmt(state?.meas_vy)} /></Col>
                  <Col span={8}><Statistic title="ωz (rad/s)" value={fmt(state?.meas_wz)} /></Col>
                </Row>
              </Card>
            </Col>

            <Col xs={24} lg={14}>
              <Card
                title={t("hopeOdom")}
                size="small"
                extra={<Button size="small" onClick={() => { traj.current = []; setTrajVersion((v) => v + 1); api.hopea3ResetOdom().catch(() => {}); }}>{t("hopeResetOdom")}</Button>}
              >
                <TrajectoryChart
                  points={traj.current}
                  version={trajVersion}
                  poseX={state?.pose_x ?? 0}
                  poseY={state?.pose_y ?? 0}
                  poseTheta={state?.pose_theta ?? 0}
                  headingLabel={t("hopeHeading")}
                  trajLabel={t("hopeTrajectory")}
                />
                <Typography.Text type="secondary">
                  {t("hopePose")}: x={fmt(state?.pose_x)} m, y={fmt(state?.pose_y)} m, θ={fmt(state ? (state.pose_theta * 180) / Math.PI : null)}°
                </Typography.Text>
              </Card>
            </Col>
          </Row>

          <Card title={t("hopeMotorsHdr")} size="small">
            <MotorTable motors={state?.motors ?? []} t={t} />
          </Card>
        </>
      )}
    </Space>
  );
}

function CmdSlider({
  label, value, min, max, step, onChange,
}: { label: string; value: number; min: number; max: number; step: number; onChange: (v: number | null) => void }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <Typography.Text type="secondary">{label}</Typography.Text>
      <Row gutter={8} align="middle">
        <Col flex="auto">
          <Slider min={min} max={max} step={step} value={value} onChange={onChange} />
        </Col>
        <Col>
          <InputNumber min={min} max={max} step={step} value={value} onChange={onChange} style={{ width: 90 }} />
        </Col>
      </Row>
    </div>
  );
}

function Labeled({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div><Typography.Text type="secondary" style={{ fontSize: 12 }}>{label}</Typography.Text></div>
      {children}
    </div>
  );
}

function MotorTable({ motors, t }: { motors: Hopea3Motor[]; t: (k: any) => string }) {
  return (
    <Table<Hopea3Motor>
      dataSource={motors}
      rowKey={(m) => m.node_id}
      pagination={false}
      size="small"
      columns={[
        { title: "ID", dataIndex: "node_id", render: (n) => nid2hex(n) },
        {
          title: t("online"),
          render: (_, m) => (
            <Space size={4}>
              <Tag color={m.online ? "green" : "red"}>{m.online ? "on" : "off"}</Tag>
              {m.error ? <Tag color="red">{m.error}</Tag> : m.enabled ? <Tag color="blue">en</Tag> : null}
            </Space>
          ),
        },
        { title: t("hopeTarget"), render: (_, m) => fmt(m.target_rev_per_s) },
        { title: t("hopeMeasVel"), render: (_, m) => fmt(m.velocity_rev_per_s) },
        { title: t("torque"), render: (_, m) => fmt(m.torque_nm) },
        { title: "‰", dataIndex: "max_torque_permille" },
        { title: t("driverTemp"), render: (_, m) => fmt(m.driver_temp_c, 1) },
        { title: t("motorTemp"), render: (_, m) => fmt(m.motor_temp_c, 1) },
      ]}
    />
  );
}

const TrajectoryChart = memo(function TrajectoryChart({
  points, version, poseX, poseY, poseTheta, headingLabel, trajLabel,
}: {
  points: { x: number; y: number }[];
  version: number;
  poseX: number;
  poseY: number;
  poseTheta: number;
  headingLabel: string;
  trajLabel: string;
}) {
  // Top-down view in ROS convention rotated so the robot's forward (+X) points
  // UP and left (+Y) points LEFT (like RViz), which reads more naturally than
  // ECharts' default right=+X. Screen mapping: sx = -rosY, sy = rosX.
  const toScreen = (rx: number, ry: number): [number, number] => [-ry, rx];
  const traj = points.map((p) => toScreen(p.x, p.y));
  const [rsx, rsy] = toScreen(poseX, poseY);

  // Equal-aspect square window around the path + current pose.
  let minX = rsx, maxX = rsx, minY = rsy, maxY = rsy;
  for (const [x, y] of traj) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const half = Math.max((maxX - minX) / 2, (maxY - minY) / 2, 0.5) * 1.15;

  // Single heading arrow representing the robot: a short stick from the current
  // position pointing along the heading, arrowhead only at the tip. Heading
  // vector (cosθ,sinθ) in ROS maps to (-sinθ,cosθ) on screen.
  const arrowLen = half * 0.28;
  const tip = [rsx + arrowLen * -Math.sin(poseTheta), rsy + arrowLen * Math.cos(poseTheta)];

  const fmtAxis = (v: number) => v.toFixed(2);
  const axisLine = { lineStyle: { color: "#3a414d" } };
  const splitLine = { lineStyle: { color: "#222831" } };

  const option = {
    animation: false,
    grid: { left: 8, right: 16, top: 28, bottom: 8, containLabel: true },
    xAxis: {
      type: "value", name: "← +Y (m)", nameLocation: "center", nameGap: 26,
      min: cx - half, max: cx + half,
      axisLine, splitLine,
      axisLabel: { color: "#8a93a3", formatter: fmtAxis },
    },
    yAxis: {
      type: "value", name: "+X ↑ (m)", nameLocation: "end", nameGap: 8,
      min: cy - half, max: cy + half,
      axisLine, splitLine,
      axisLabel: { color: "#8a93a3", formatter: fmtAxis },
    },
    tooltip: {
      trigger: "item",
      formatter: (p: any) => `${fmtAxis(p.value[1])}, ${fmtAxis(-p.value[0])} m`,
    },
    series: [
      {
        name: trajLabel,
        type: "line",
        showSymbol: false,
        lineStyle: { width: 2, color: "#4f8cff" },
        data: traj,
      },
      {
        name: headingLabel,
        type: "line",
        symbol: ["none", "arrow"],
        symbolSize: 16,
        lineStyle: { width: 4, color: "#f39c12" },
        itemStyle: { color: "#f39c12" },
        data: [[rsx, rsy], tip],
      },
    ],
  };

  return (
    <ReactECharts
      key={version}
      option={option}
      notMerge
      style={{ width: "100%", aspectRatio: "1 / 1", minHeight: 320 }}
    />
  );
});

function fmt(v: number | null | undefined, digits = 3): string {
  if (v == null || Number.isNaN(v)) return "—";
  return v.toFixed(digits);
}

const round2 = (x: number) => Math.round(x * 100) / 100;

interface Twist { vx: number; vy: number; wz: number }

// Read keyboard state → twist, or null if no movement key is held. (x,y)
// magnitude is normalised so diagonals aren't faster than straight lines.
function readKeyboard(keys: Set<string>, linear: number, angular: number): Twist | null {
  let fx = 0, fy = 0, fz = 0;
  for (const k of keys) {
    switch (KEY_MAP[k]) {
      case "fwd": fx += 1; break;
      case "back": fx -= 1; break;
      case "left": fy += 1; break;
      case "right": fy -= 1; break;
      case "ccw": fz += 1; break;
      case "cw": fz -= 1; break;
    }
  }
  if (fx === 0 && fy === 0 && fz === 0) return null;
  const len = Math.hypot(fx, fy);
  const scale = len > 0 ? linear / len : 0;
  return { vx: fx * scale, vy: fy * scale, wz: fz * angular };
}

// Read the first connected gamepad → twist, or null if nothing past deadzone.
// Left stick = translate (up=fwd, left=+vy), right-stick X = yaw (left=CCW).
function readGamepad(linear: number, angular: number): Twist | null {
  const pads = navigator.getGamepads?.() ?? [];
  const pad = Array.from(pads).find((p) => p);
  if (!pad) return null;
  const ax = (i: number) => {
    const v = pad.axes[i] ?? 0;
    return Math.abs(v) < PAD_DEADZONE ? 0 : v;
  };
  let vx = -ax(1); // stick up (negative) = forward
  let vy = -ax(0); // stick left (negative) = +vy (left)
  const wz = -ax(2) * angular; // right stick left (negative) = CCW
  const len = Math.hypot(vx, vy);
  if (len === 0 && wz === 0) return null;
  if (len > 1) { vx /= len; vy /= len; } // clamp stick magnitude to 1
  return { vx: vx * linear, vy: vy * linear, wz };
}
