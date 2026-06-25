// Arm(Zenoh)工具:发现/取控 + 3D 数字孪生 + 关节状态 + GRAVITY_COMP/设重力/预设位姿。
// 镜像 ZenohPanel 的连接/取控流;控制部分换成机械臂特有。
import { useCallback, useEffect, useState } from "react";
import { App as AntdApp, Button, Card, Input, InputNumber, Select, Space, Table, Tag, Tooltip, Typography } from "antd";
import { api, errMsg } from "../api";
import type { ArmInfo, ZenohArmState } from "../types";
import { ArmViewer } from "./ArmViewer";

const POLL_MS = 33; // ~30fps for the twin

// 编译期预设位姿(rad)。TODO:之后可加“轨迹”(多点 chunk / 依次 goto)。
const PRESETS: { name: string; q: number[] }[] = [
  { name: "Home", q: [0, 0, 0, 0, 0, 0] },
  { name: "Ready", q: [0, -0.6, 1.2, 0, 0.6, 0] },
  { name: "Reach", q: [0, 0.8, 0.5, 0, 0.3, 0] },
  { name: "Tuck", q: [0, 1.4, 2.4, 0, 0.6, 0] },
];

export function ArmPanel() {
  const { message } = AntdApp.useApp();
  const [endpoint, setEndpoint] = useState("");
  const [connected, setConnected] = useState(false);
  const [arms, setArms] = useState<ArmInfo[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [st, setSt] = useState<ZenohArmState | null>(null);
  const [gx, setGx] = useState(0);
  const [gy, setGy] = useState(0);
  const [gz, setGz] = useState(-9.81);
  const [busy, setBusy] = useState(false);
  const [previewQ, setPreviewQ] = useState<number[] | null>(null); // 预设悬浮预览
  const [kp, setKp] = useState(20); // host 侧增益(控制器忠实执行);调低=移动柔和便于观察
  const [kd, setKd] = useState(1.5);

  useEffect(() => {
    if (!connected) { setSt(null); return; }
    let alive = true;
    const tick = async () => { try { const s = await api.armGetState(); if (alive) setSt(s); } catch { /* transient */ } };
    tick();
    const h = window.setInterval(tick, POLL_MS);
    return () => { alive = false; window.clearInterval(h); };
  }, [connected]);
  useEffect(() => () => { api.armDisconnect().catch(() => {}); }, []);

  const connect = useCallback(async () => {
    setBusy(true);
    try {
      await api.armConnect(endpoint.trim());
      setConnected(true);
      let list = await api.armDiscover();
      if (!list.length) { await new Promise((r) => setTimeout(r, 900)); list = await api.armDiscover(); }
      setArms(list); setSelected(list[0]?.prefix ?? null);
      if (!list.length) message.warning("没发现机械臂(arm_controller 起了吗?)");
    } catch (e) { message.error(errMsg(e)); }
    finally { setBusy(false); }
  }, [endpoint, message]);

  const disconnect = useCallback(async () => {
    try { await api.armDisconnect(); } catch { /* ignore */ }
    setConnected(false); setArms([]); setSelected(null); setSt(null);
  }, []);
  const acquire = useCallback(async () => {
    const a = arms.find((x) => x.prefix === selected);
    if (!a) return;
    try { await api.armAcquire(a.prefix, a.model); message.success("已取得控制权"); } catch (e) { message.error(errMsg(e)); }
  }, [arms, selected, message]);
  const release = useCallback(async () => { try { await api.armRelease(); } catch (e) { message.error(errMsg(e)); } }, [message]);
  const setMode = useCallback(async (m: number) => { try { await api.armSetMode(m); } catch (e) { message.error(errMsg(e)); } }, [message]);
  const setGravity = useCallback(async () => { try { await api.armSetGravity([gx, gy, gz]); } catch (e) { message.error(errMsg(e)); } }, [gx, gy, gz, message]);
  const goTo = useCallback(async (q: number[]) => { try { await api.armGoto(q, kp, kd); } catch (e) { message.error(errMsg(e)); } }, [kp, kd, message]);

  const controlling = !!st?.controlling;
  const dof = st?.dof || 6;
  const grav = (st?.gravity ?? [gx, gy, gz]) as [number, number, number];
  const names = st?.joint_names ?? Array.from({ length: dof }, (_, i) => `joint_${i + 1}`);
  const rows = names.map((n, i) => ({
    key: i, name: n,
    q: st?.q[i] ?? 0, dq: st?.dq[i] ?? 0, tau: st?.tau[i] ?? 0,
    lim: st?.pos_min?.[i] != null && st?.pos_max?.[i] != null ? `[${st.pos_min[i].toFixed(2)}, ${st.pos_max[i].toFixed(2)}]` : "",
  }));

  return (
    <Space direction="vertical" size={16} style={{ width: "100%", maxWidth: 1000 }}>
      <Typography.Title level={4} style={{ margin: 0 }}>Arm (Zenoh)</Typography.Title>

      <Card size="small">
        <Space wrap>
          <Typography.Text>Endpoint</Typography.Text>
          <Input style={{ width: 240 }} value={endpoint} disabled={connected} placeholder="留空=组播扫描,或 tcp/IP:7447" onChange={(e) => setEndpoint(e.target.value)} />
          {connected ? <Button onClick={disconnect}>断开</Button> : <Button type="primary" loading={busy} onClick={connect}>连接</Button>}
          {connected && (
            <Select style={{ width: 340 }} value={selected ?? undefined} onChange={setSelected}
              options={arms.map((a) => ({ value: a.prefix, label: `${a.model} — ${a.prefix}${a.has_ee ? ` +EE(${a.ee_model || "?"})` : ""}` }))} />
          )}
          {connected && (controlling
            ? <Button danger onClick={release}>释放</Button>
            : <Button type="primary" disabled={!selected} onClick={acquire}>取控</Button>)}
        </Space>
      </Card>

      <Card size="small">
        <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
          <div style={{ flex: "1 1 480px", minWidth: 380 }}>
            <ArmViewer q={st?.q ?? []} gravity={grav} jointNames={st?.joint_names ?? []} previewQ={previewQ} />
          </div>
          <div style={{ flex: "1 1 320px", minWidth: 300 }}>
            <Space direction="vertical" size={12} style={{ width: "100%" }}>
              <Space wrap>
                {controlling ? <Tag color="green">控制中</Tag> : st && st.holder !== 0 ? <Tag color="orange">被占 #{st.holder}</Tag> : <Tag>未取控</Tag>}
                <Tag color="blue">{st?.mode ?? "—"}</Tag>
                {st?.has_ee ? <Tag color="purple">EE: {st.ee_model || "?"}</Tag> : <Tag>无 EE</Tag>}
              </Space>

              <Typography.Text strong>模式</Typography.Text>
              <Space wrap>
                <Button disabled={!controlling} onClick={() => setMode(4)}>GRAVITY_COMP</Button>
                <Button disabled={!controlling} onClick={() => setMode(3)}>PASSIVE</Button>
                <Button danger disabled={!controlling} onClick={() => setMode(1)}>DISABLE</Button>
              </Space>

              <Typography.Text strong>重力向量 (m/s²)</Typography.Text>
              <Space wrap>
                <InputNumber style={{ width: 96 }} value={gx} step={0.5} prefix="x" onChange={(v) => setGx(v ?? 0)} />
                <InputNumber style={{ width: 96 }} value={gy} step={0.5} prefix="y" onChange={(v) => setGy(v ?? 0)} />
                <InputNumber style={{ width: 96 }} value={gz} step={0.5} prefix="z" onChange={(v) => setGz(v ?? 0)} />
                <Button disabled={!controlling} onClick={setGravity}>设</Button>
              </Space>
              <Typography.Text type="secondary">测试用 z=-2.9(30%)更安全;斜装时填 base 系真实重力</Typography.Text>

              <Typography.Text strong>增益 kp/kd(host 侧给,控制器忠实执行;调低 kp 移动柔和便于观察)</Typography.Text>
              <Space wrap>
                <InputNumber style={{ width: 120 }} value={kp} min={0} step={1} prefix="kp" onChange={(v) => setKp(v ?? 0)} />
                <InputNumber style={{ width: 120 }} value={kd} min={0} step={0.5} prefix="kd" onChange={(v) => setKd(v ?? 0)} />
              </Space>

              <Typography.Text strong>预设位姿(悬浮预览幽灵臂,点击移动)</Typography.Text>
              <Space wrap>
                {PRESETS.map((p) => (
                  <Tooltip key={p.name} title={`q = [${p.q.map((v) => v.toFixed(2)).join(", ")}] rad`}>
                    <Button
                      disabled={!controlling}
                      onMouseEnter={() => setPreviewQ(p.q)}
                      onMouseLeave={() => setPreviewQ(null)}
                      onClick={() => goTo(p.q)}
                    >{p.name}</Button>
                  </Tooltip>
                ))}
              </Space>
            </Space>
          </div>
        </div>
      </Card>

      <Card size="small" title="关节状态">
        <Table size="small" pagination={false} dataSource={rows}
          columns={[
            { title: "关节", dataIndex: "name" },
            { title: "q (rad)", dataIndex: "q", render: (v: number) => v.toFixed(3) },
            { title: "dq (rad/s)", dataIndex: "dq", render: (v: number) => v.toFixed(3) },
            { title: "τ (Nm)", dataIndex: "tau", render: (v: number) => v.toFixed(2) },
            { title: "限位 (rad)", dataIndex: "lim" },
          ]} />
      </Card>
    </Space>
  );
}
