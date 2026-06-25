import { useCallback, useEffect, useState } from "react";
import { App as AntdApp, Button, Card, Empty, Layout, Space, theme, Tooltip, Typography } from "antd";
import { TranslationOutlined } from "@ant-design/icons";
import { api, errMsg } from "./api";
import { useI18n } from "./i18n";
import { ConnectBar } from "./components/ConnectBar";
import { Sidebar } from "./components/Sidebar";
import { MotorDetail } from "./components/MotorDetail";
import { ChangeIdTool } from "./components/ChangeIdTool";
import { ZeroTool } from "./components/ZeroTool";
import { Hopea3Panel } from "./components/Hopea3Panel";
import { SmartKnobPanel } from "./components/SmartKnobPanel";
import { ZenohPanel } from "./components/ZenohPanel";
import { TutorialModal } from "./components/Tutorial";
import type { MotorInfo } from "./types";

type Tool = "control" | "changeId" | "zero" | "hopea3" | "smartknob" | "zenoh";

const DEVICE_POLL_MS = 700;

export default function App() {
  const { message } = AntdApp.useApp();
  const { t } = useI18n();
  // null = landing page (pick a tool before anything else).
  const [tool, setTool] = useState<Tool | null>(null);
  const [connected, setConnected] = useState(false);
  const [devices, setDevices] = useState<MotorInfo[]>([]);
  const [selectedNid, setSelectedNid] = useState<number | null>(null);
  // nid -> csv path (presence means logging is on for that motor)
  const [logging, setLogging] = useState<Record<number, string>>({});

  // Poll the device list while connected.
  useEffect(() => {
    if (!connected) {
      setDevices([]);
      return;
    }
    let alive = true;
    const tick = async () => {
      try {
        const list = await api.listDevices();
        if (alive) setDevices(list);
      } catch {
        /* ignore transient */
      }
    };
    tick();
    const h = window.setInterval(tick, DEVICE_POLL_MS);
    return () => {
      alive = false;
      window.clearInterval(h);
    };
  }, [connected]);

  // Auto-select the first motor once one appears (control mode only).
  useEffect(() => {
    if (tool === "control" && selectedNid == null && devices.length > 0) {
      setSelectedNid(devices[0].node_id);
    }
  }, [devices, selectedNid, tool]);

  const onConnChange = useCallback((c: boolean) => {
    setConnected(c);
    if (!c) {
      setSelectedNid(null);
      setLogging({});
    }
  }, []);

  const switchTool = useCallback(async () => {
    try {
      await api.disconnect();
    } catch {
      /* ignore */
    }
    setConnected(false);
    setSelectedNid(null);
    setLogging({});
    setDevices([]);
    setTool(null);
  }, []);

  const onToggleLog = useCallback(
    async (nid: number, on: boolean) => {
      try {
        if (on) {
          const path = await api.startLog(nid);
          setLogging((m) => ({ ...m, [nid]: path }));
          message.success(t("startedLog"));
        } else {
          await api.stopLog(nid);
          setLogging((m) => {
            const next = { ...m };
            delete next[nid];
            return next;
          });
          message.info(t("stoppedLog"));
        }
      } catch (e) {
        message.error(`${t("logFailed")}: ${errMsg(e)}`);
      }
    },
    [message, t]
  );

  if (tool == null) return <ToolPicker onPick={setTool} />;

  const selected = devices.find((d) => d.node_id === selectedNid) ?? null;
  const toolLabel =
    tool === "control" ? t("toolControl")
    : tool === "changeId" ? t("toolChangeId")
    : tool === "zero" ? t("toolZero")
    : tool === "zenoh" ? t("toolBaseZenoh")
    : tool === "smartknob" ? t("toolSmartKnob")
    : t("toolHopeA3");
  const needsHeartbeat = tool === "control" || tool === "hopea3" || tool === "smartknob";
  // hopea3 / smartknob / zenoh 都是整屏面板;zenoh 走 Zenoh 不用 CAN 总线。
  const showSidebar = tool !== "hopea3" && tool !== "smartknob" && tool !== "zenoh";
  const showConnectBar = tool !== "zenoh";

  return (
    <Layout style={{ height: "100vh" }}>
      <Layout.Header
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          paddingInline: 16,
          gap: 16,
        }}
      >
        <Space size={12}>
          <Typography.Title level={4} style={{ margin: 0, color: "#e6e8eb" }}>
            {t("appTitle")}
          </Typography.Title>
          <Typography.Text type="secondary">{toolLabel}</Typography.Text>
          <Button size="small" onClick={switchTool}>
            {t("switchTool")}
          </Button>
        </Space>
        {showConnectBar && (
          <ConnectBar
            connected={connected}
            onChange={onConnChange}
            broadcastHeartbeat={needsHeartbeat}
          />
        )}
      </Layout.Header>
      <Layout>
        {showSidebar && (
          <Layout.Sider width={280} theme="dark" style={{ borderRight: "1px solid #262b35" }}>
            <Sidebar
              devices={devices}
              selectedNid={selectedNid}
              onSelect={setSelectedNid}
              connected={connected}
              tool={tool as "control" | "changeId" | "zero"}
            />
          </Layout.Sider>
        )}
        <Layout.Content style={{ padding: 16, overflow: "auto" }}>
          {tool === "hopea3" ? (
            <Hopea3Panel connected={connected} />
          ) : tool === "smartknob" ? (
            <SmartKnobPanel connected={connected} devices={devices} />
          ) : tool === "zenoh" ? (
            <ZenohPanel />
          ) : tool === "changeId" ? (
            <ChangeIdTool devices={devices} selectedNid={selectedNid} connected={connected} />
          ) : tool === "zero" ? (
            <ZeroTool devices={devices} selectedNid={selectedNid} connected={connected} />
          ) : selected ? (
            <MotorDetail
              key={selected.node_id}
              info={selected}
              connected={connected}
              logging={logging[selected.node_id] != null}
              logPath={logging[selected.node_id] ?? null}
              onToggleLog={(on) => onToggleLog(selected.node_id, on)}
            />
          ) : (
            <div style={{ paddingTop: 80 }}>
              <Empty description={connected ? t("selectMotor") : t("connectFirst")} />
            </div>
          )}
        </Layout.Content>
      </Layout>
    </Layout>
  );
}

function ToolPicker({ onPick }: { onPick: (t: Tool) => void }) {
  const { t, lang, toggle } = useI18n();
  const { token } = theme.useToken();
  const [tutorialOpen, setTutorialOpen] = useState(false);
  return (
    <div
      style={{
        height: "100vh",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 24,
        position: "relative",
        background: token.colorBgLayout,
        color: token.colorText,
      }}
    >
      <Tooltip title={lang === "en" ? "切换到中文" : "Switch to English"}>
        <Button
          icon={<TranslationOutlined />}
          onClick={toggle}
          style={{ position: "absolute", top: 16, right: 16 }}
        >
          {lang === "en" ? "中文" : "English"}
        </Button>
      </Tooltip>

      <Typography.Title level={2} style={{ margin: 0 }}>
        {t("appTitle")}
      </Typography.Title>
      <Typography.Text type="secondary">{t("pickTool")}</Typography.Text>

      <div style={{ width: "100%", maxWidth: 920 }}>
        <Typography.Text strong style={{ display: "block", marginBottom: 8 }}>
          {t("catDirectControl")}
        </Typography.Text>
        <Space size={16} wrap style={{ justifyContent: "center", width: "100%" }}>
          <ToolCard title={t("toolControl")} desc={t("toolControlDesc")} onClick={() => onPick("control")} />
          <ToolCard title={t("toolChangeId")} desc={t("toolChangeIdDesc")} onClick={() => onPick("changeId")} />
          <ToolCard title={t("toolZero")} desc={t("toolZeroDesc")} onClick={() => onPick("zero")} />
        </Space>

        <Typography.Text strong style={{ display: "block", margin: "24px 0 8px" }}>
          {t("catRobotApp")}
        </Typography.Text>
        <Space size={16} wrap style={{ justifyContent: "center", width: "100%" }}>
          <ToolCard title={t("toolBaseZenoh")} desc={t("toolBaseZenohDesc")} onClick={() => onPick("zenoh")} />
          <ToolCard title={t("toolHopeA3")} desc={t("toolHopeA3Desc")} onClick={() => onPick("hopea3")} />
          <ToolCard title={t("toolSmartKnob")} desc={t("toolSmartKnobDesc")} onClick={() => onPick("smartknob")} />
          <ToolCard title={t("toolTutorial")} desc={t("toolTutorialDesc")} onClick={() => setTutorialOpen(true)} />
        </Space>
      </div>

      <TutorialModal open={tutorialOpen} onClose={() => setTutorialOpen(false)} />
    </div>
  );
}

function ToolCard({ title, desc, onClick }: { title: string; desc: string; onClick: () => void }) {
  return (
    <Card hoverable style={{ width: 280, height: 180 }} onClick={onClick}>
      <Typography.Title level={4}>{title}</Typography.Title>
      <Typography.Paragraph type="secondary">{desc}</Typography.Paragraph>
    </Card>
  );
}
