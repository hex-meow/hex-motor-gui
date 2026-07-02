import { useCallback, useEffect, useRef, useState } from "react";
import {
  App as AntdApp,
  Button,
  InputNumber,
  Space,
  Switch,
  Table,
  Tag,
  Typography,
} from "antd";
import { api, errMsg } from "../api";
import { useI18n } from "../i18n";
import { nid2hex } from "../format";
import type { Hopea3Motor, Hopea3State } from "../types";
import { BasePoseViewer } from "./BasePoseViewer";
import "./ZenohPanel.css";
import "./Hopea3Panel.css";

const POLL_MS = 50; // 20 Hz UI poll (control/odom run at 500 Hz in Rust)
const MANUAL_MS = 33; // ~30 Hz manual-input (keyboard/gamepad) loop
const PAD_DEADZONE = 0.12;

// WASD = XY translate, QE = yaw. Signs match the on-screen drive pad.
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

  // Limits + torque (applied on button).
  const [maxLinear, setMaxLinear] = useState(3);
  const [maxAngular, setMaxAngular] = useState(3);
  const [accLin, setAccLin] = useState(2);
  const [accAng, setAccAng] = useState(6);
  const [torque, setTorque] = useState<[number, number, number]>([800, 800, 800]);
  const [kd, setKd] = useState<[number, number, number]>([1.0, 1.0, 1.0]);

  // Manual drive (keyboard / gamepad). Full deflection = these speeds.
  const [keyboardEnabled, setKeyboardEnabled] = useState(true);
  const [manualLinear, setManualLinear] = useState(1.0);
  const [manualAngular, setManualAngular] = useState(1.5);
  const keysDown = useRef<Set<string>>(new Set());
  const manualWasActive = useRef(false);

  const [odomViewVersion, setOdomViewVersion] = useState(0);

  // Poll backend state while running.
  useEffect(() => {
    if (!running) return;
    let alive = true;
    const tick = async () => {
      try {
        const s = await api.hopea3GetState();
        if (!alive) return;
        setState(s);
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
      setOdomViewVersion((v) => v + 1);
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
    setState(null);
  }, [message]);

  // If the bus disconnects under us, drop back to the stopped view.
  useEffect(() => {
    if (!connected && running) {
      setRunning(false);
      setState(null);
    }
  }, [connected, running]);

  const cmd = useCallback((nvx: number, nvy: number, nwz: number) => {
    api.hopea3SetCmd(nvx, nvy, nwz).catch(() => {});
  }, []);
  const stopMotion = useCallback(() => cmd(0, 0, 0), [cmd]);

  const hold = (nvx: number, nvy: number, nwz: number) => ({
    onPointerDown: () => cmd(nvx, nvy, nwz),
    onPointerUp: stopMotion,
    onPointerCancel: stopMotion,
    onPointerLeave: stopMotion,
  });

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
  // input sends one zero then yields the command back to the pointer controls.
  useEffect(() => {
    if (!running) return;
    const h = window.setInterval(() => {
      const gp = readGamepad(manualLinear, manualAngular);
      const kb = keyboardEnabled ? readKeyboard(keysDown.current, manualLinear, manualAngular) : null;
      const drive = gp ?? kb;
      if (drive) {
        cmd(drive.vx, drive.vy, drive.wz);
        manualWasActive.current = true;
      } else if (manualWasActive.current) {
        stopMotion();
        manualWasActive.current = false;
      }
    }, MANUAL_MS);
    return () => window.clearInterval(h);
  }, [running, keyboardEnabled, manualLinear, manualAngular, cmd, stopMotion]);

  const clearErrors = useCallback(async () => {
    try {
      await api.hopea3ClearErrors();
      message.success(t("hopeCleared"));
    } catch (e) {
      message.error(errMsg(e));
    }
  }, [message, t]);

  const [reinitNid, setReinitNid] = useState<number | null>(null);
  const reinitMotor = useCallback(async (nid: number) => {
    setReinitNid(nid);
    try {
      await api.hopea3ReinitMotor(nid);
      message.success(t("hopeCleared"));
    } catch (e) {
      message.error(errMsg(e));
    } finally {
      setReinitNid(null);
    }
  }, [message, t]);

  const applyLimits = async () => {
    try {
      await api.hopea3SetLimits(maxLinear, maxAngular);
      await api.hopea3SetAccelLimits(accLin, accAng);
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

  const canDrive = connected && running;
  const startLabel = starting
    ? initProg
      ? `${t("hopeStarting")} ${initProg.current}/${initProg.total}${initProg.attempt > 1 ? ` (#${initProg.attempt})` : ""}`
      : t("hopeStarting")
    : t("hopeStart");

  return (
    <div className="hope-panel zenoh-panel">
      <header className="zenoh-panel__header">
        <div>
          <Typography.Title level={3} className="zenoh-panel__title">
            {t("toolHopeA3")}
          </Typography.Title>
          <Typography.Text type="secondary">{t("toolHopeA3Desc")}</Typography.Text>
        </div>
      </header>

      <section className="hope-start-panel zenoh-connect-panel">
        <div className="hope-start-panel__copy">
          <Typography.Text strong>{t("hopeStart")}</Typography.Text>
          <Typography.Text type="secondary">
            {connected ? t("hopeStartHint") : t("hopeNeedConnect")}
          </Typography.Text>
        </div>
        <div className="zenoh-connect-panel__actions">
          {!running ? (
            <Button type="primary" loading={starting} disabled={!connected} onClick={start}>
              {startLabel}
            </Button>
          ) : (
            <Button danger onClick={stop}>
              {t("hopeStop")}
            </Button>
          )}
          <Button disabled={!connected || running} onClick={clearErrors}>{t("hopeClearErrors")}</Button>
        </div>
        {starting && initProg && (
          <div className="hope-start-panel__progress">
            <Tag color="orange">{initProg.current}/{initProg.total}{initProg.attempt > 1 ? ` #${initProg.attempt}` : ""}</Tag>
          </div>
        )}
      </section>

      <div className="zenoh-dashboard hope-dashboard">
        <section className="zenoh-card hope-drive">
          <div className="zenoh-card__heading">
            <div>
              <h2>{t("zDriveTitle")}</h2>
              <Typography.Text type="secondary">{t("zDriveHint")}</Typography.Text>
            </div>
            <div className="zenoh-active-toggle">
              <Typography.Text type="secondary">{t("zActiveShort")}</Typography.Text>
              <Switch checked={canDrive} disabled />
            </div>
          </div>

          <div className="zenoh-pad" aria-label={t("zMove")}>
            <span />
            <Button disabled={!canDrive} {...hold(manualLinear, 0, 0)}>▲</Button>
            <span />
            <Button disabled={!canDrive} {...hold(0, -manualLinear, 0)}>◀</Button>
            <Button danger disabled={!canDrive} onClick={stopMotion}>{t("zStop")}</Button>
            <Button disabled={!canDrive} {...hold(0, manualLinear, 0)}>▶</Button>
            <Button disabled={!canDrive} {...hold(0, 0, -manualAngular)}>↺</Button>
            <Button disabled={!canDrive} {...hold(-manualLinear, 0, 0)}>▼</Button>
            <Button disabled={!canDrive} {...hold(0, 0, manualAngular)}>↻</Button>
          </div>

          <div className="zenoh-speed-grid">
            <label className="zenoh-field">
              <span>{t("zSpeedLin")}</span>
              <InputNumber disabled={!canDrive} min={0} max={maxLinear} step={0.1} value={manualLinear} onChange={(v) => setManualLinear(v ?? 0)} />
            </label>
            <label className="zenoh-field">
              <span>{t("zSpeedAng")}</span>
              <InputNumber disabled={!canDrive} min={0} max={maxAngular} step={0.1} value={manualAngular} onChange={(v) => setManualAngular(v ?? 0)} />
            </label>
          </div>

          <div className="zenoh-keyboard-control">
            <div className="zenoh-keyboard-control__top">
              <Typography.Text type="secondary">{t("zKeyboard")}</Typography.Text>
              <Switch size="small" disabled={!canDrive} checked={keyboardEnabled} onChange={setKeyboardEnabled} />
            </div>
            <div className="zenoh-key-hints" aria-label={t("zKeyboard")}>
              <kbd>W</kbd>
              <kbd>A</kbd>
              <kbd>S</kbd>
              <kbd>D</kbd>
              <kbd>Q</kbd>
              <kbd>E</kbd>
            </div>
            <Typography.Text type="secondary" className="zenoh-keyboard-control__hint">
              {t("zKeyHint")}
            </Typography.Text>
          </div>
        </section>

        <section className="zenoh-odom hope-odom">
          <div className="zenoh-card__heading zenoh-odom__heading">
            <div>
              <h2>{t("hopeOdom")}</h2>
              <Typography.Text type="secondary">{t("hopePose")}</Typography.Text>
            </div>
            <Button size="small" disabled={!canDrive} onClick={() => { setOdomViewVersion((v) => v + 1); api.hopea3ResetOdom().catch(() => {}); }}>
              {t("hopeResetOdom")}
            </Button>
          </div>
          <BasePoseViewer
            key={odomViewVersion}
            connected={running}
            poseX={state?.pose_x ?? 0}
            poseY={state?.pose_y ?? 0}
            theta={state?.pose_theta ?? 0}
            vx={state?.meas_vx ?? 0}
            vy={state?.meas_vy ?? 0}
            wz={state?.meas_wz ?? 0}
          />
        </section>

        <section className="zenoh-card zenoh-telemetry hope-telemetry">
          <div className="zenoh-card__heading">
            <div>
              <h2>{t("zTelemetry")}</h2>
              <Typography.Text type="secondary">{t("hopeMeasTwist")}</Typography.Text>
            </div>
          </div>
          <MetricGroup
            title={t("hopePose")}
            items={[
              ["x", `${fmt(state?.pose_x)} m`],
              ["y", `${fmt(state?.pose_y)} m`],
              ["theta", `${fmt(state?.pose_theta)} rad`],
            ]}
          />
          <MetricGroup
            title={t("hopeMeasTwist")}
            items={[
              ["vx", `${fmt(state?.meas_vx)} m/s`],
              ["vy", `${fmt(state?.meas_vy)} m/s`],
              ["wz", `${fmt(state?.meas_wz)} rad/s`],
            ]}
          />
        </section>
      </div>

      <section className="hope-lower-grid">
        <div className="zenoh-card hope-limits">
          <div className="zenoh-card__heading">
            <div>
              <h2>{t("hopeLimits")}</h2>
              <Typography.Text type="secondary">{t("hopeMaxTorque")}</Typography.Text>
            </div>
            <Button disabled={!canDrive} onClick={applyLimits}>{t("apply")}</Button>
          </div>
          <div className="hope-limit-grid">
            <Labeled label={t("hopeMaxLinear")}>
              <InputNumber disabled={!canDrive} min={0} step={0.1} value={maxLinear} onChange={(v) => setMaxLinear(v ?? 0)} />
            </Labeled>
            <Labeled label={t("hopeMaxAngular")}>
              <InputNumber disabled={!canDrive} min={0} step={0.1} value={maxAngular} onChange={(v) => setMaxAngular(v ?? 0)} />
            </Labeled>
            <Labeled label={t("hopeAccLinear")}>
              <InputNumber disabled={!canDrive} min={0} step={0.5} value={accLin} onChange={(v) => setAccLin(v ?? 0)} />
            </Labeled>
            <Labeled label={t("hopeAccAngular")}>
              <InputNumber disabled={!canDrive} min={0} step={0.5} value={accAng} onChange={(v) => setAccAng(v ?? 0)} />
            </Labeled>
          </div>
          <Typography.Text type="secondary">{t("hopeMaxTorque")}</Typography.Text>
          <div className="hope-triplet">
            {[0, 1, 2].map((i) => (
              <InputNumber
                key={i}
                disabled={!canDrive}
                addonBefore={i + 1}
                min={0}
                max={1000}
                value={torque[i]}
                onChange={(v) => {
                  const next = [...torque] as [number, number, number];
                  next[i] = v ?? 0;
                  applyTorque(next);
                }}
              />
            ))}
          </div>
          <Typography.Text type="secondary">{t("hopeKd")}</Typography.Text>
          <div className="hope-triplet">
            {[0, 1, 2].map((i) => (
              <InputNumber
                key={i}
                disabled={!canDrive}
                addonBefore={i + 1}
                min={0}
                step={0.05}
                value={kd[i]}
                onChange={(v) => {
                  const next = [...kd] as [number, number, number];
                  next[i] = v ?? 0;
                  applyKd(next);
                }}
              />
            ))}
          </div>
        </div>

        <div className="zenoh-card hope-motors">
          <div className="zenoh-card__heading">
            <div>
              <h2>{t("hopeMotorsHdr")}</h2>
              <Typography.Text type="secondary">{state?.motors?.length ?? 0} motors</Typography.Text>
            </div>
          </div>
          <MotorTable motors={state?.motors ?? []} t={t} onReinit={reinitMotor} busyNid={reinitNid} disabled={!canDrive} />
        </div>
      </section>
    </div>
  );
}

function Labeled({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="hope-labeled">
      <div><Typography.Text type="secondary">{label}</Typography.Text></div>
      {children}
    </div>
  );
}

function MotorTable({
  motors, t, onReinit, busyNid, disabled,
}: {
  motors: Hopea3Motor[];
  t: (k: any) => string;
  onReinit: (nid: number) => void;
  busyNid: number | null;
  disabled: boolean;
}) {
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
        {
          title: "",
          render: (_, m) => (
            <Button
              size="small"
              danger={!!m.error}
              disabled={disabled}
              loading={busyNid === m.node_id}
              onClick={() => onReinit(m.node_id)}
            >
              {t("reinitialize")}
            </Button>
          ),
        },
      ]}
    />
  );
}

function MetricGroup({ title, items }: { title: string; items: Array<[string, string]> }) {
  return (
    <div className="zenoh-metric-group">
      <Typography.Text strong>{title}</Typography.Text>
      <div className="zenoh-metric-grid">
        {items.map(([label, value]) => (
          <div className="zenoh-metric" key={label}>
            <span>{label}</span>
            <strong>{value}</strong>
          </div>
        ))}
      </div>
    </div>
  );
}

function fmt(v: number | null | undefined, digits = 3): string {
  if (v == null || Number.isNaN(v)) return "—";
  return v.toFixed(digits);
}

interface Twist { vx: number; vy: number; wz: number }

// Read keyboard state → twist, or null if no movement key is held. (x,y)
// magnitude is normalised so diagonals aren't faster than straight lines.
function readKeyboard(keys: Set<string>, linear: number, angular: number): Twist | null {
  let fx = 0, fy = 0, fz = 0;
  for (const k of keys) {
    switch (KEY_MAP[k]) {
      case "fwd": fx += 1; break;
      case "back": fx -= 1; break;
      case "left": fy -= 1; break;
      case "right": fy += 1; break;
      case "ccw": fz -= 1; break;
      case "cw": fz += 1; break;
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
