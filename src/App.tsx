import { useCallback, useEffect, useState, type ReactNode } from "react";
import { App as AntdApp, Button, Empty, Layout, Space, Tooltip, Typography } from "antd";
import { api, errMsg } from "./api";
import { useI18n } from "./i18n";
import { ConnectBar } from "./components/ConnectBar";
import { Sidebar } from "./components/Sidebar";
import { MotorDetail } from "./components/MotorDetail";
import { ImuPanel } from "./components/ImuPanel";
import { ChangeIdTool } from "./components/ChangeIdTool";
import { ZeroTool } from "./components/ZeroTool";
import { Hopea3Panel } from "./components/Hopea3Panel";
import { SmartKnobPanel } from "./components/SmartKnobPanel";
import { ZenohPanel } from "./components/ZenohPanel";
import { ArmPanel } from "./components/ArmPanel";
import { CanAnalyzerPanel } from "./components/CanAnalyzerPanel";
import { TutorialModal } from "./components/Tutorial";
import type { MotorInfo } from "./types";
import "./App.css";

type Tool = "control" | "changeId" | "zero" | "hopea3" | "smartknob" | "zenoh" | "arm" | "canalyzer";

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
    : tool === "arm" ? "Arm (Zenoh)"
    : tool === "smartknob" ? t("toolSmartKnob")
    : tool === "canalyzer" ? t("toolCanalyzer")
    : t("toolHopeA3");
  const needsHeartbeat = tool === "control" || tool === "hopea3" || tool === "smartknob";
  // hopea3 / smartknob / zenoh / arm / canalyzer 都是整屏面板;zenoh/arm 走 Zenoh,
  // canalyzer 自带总线连接,都不使用顶栏的电机 ConnectBar。
  const showSidebar =
    tool !== "hopea3" && tool !== "smartknob" && tool !== "zenoh" && tool !== "arm" && tool !== "canalyzer";
  const showConnectBar = tool !== "zenoh" && tool !== "arm" && tool !== "canalyzer";

  return (
    <Layout className="app-shell" style={{ height: "100vh" }}>
      <Layout.Header
        className="app-header"
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
          ) : tool === "arm" ? (
            <ArmPanel />
          ) : tool === "canalyzer" ? (
            <CanAnalyzerPanel />
          ) : tool === "changeId" ? (
            <ChangeIdTool devices={devices} selectedNid={selectedNid} connected={connected} />
          ) : tool === "zero" ? (
            <ZeroTool devices={devices} selectedNid={selectedNid} connected={connected} />
          ) : selected && selected.device_type === "imu" ? (
            <ImuPanel key={selected.node_id} info={selected} connected={connected} />
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
  const [tutorialOpen, setTutorialOpen] = useState(false);
  return (
    <div className="tool-picker">
      <div className="tool-picker__actions">
        <Tooltip title={lang === "en" ? "切换到中文" : "Switch to English"}>
          <Button className="tool-picker__language" onClick={toggle}>
            {lang === "en" ? "A中" : "En"}
          </Button>
        </Tooltip>
      </div>

      <div className="tool-picker__inner">
        <header className="tool-picker__hero">
          <p className="tool-picker__eyebrow">{t("toolPickerEyebrow")}</p>
          <h1>{t("toolPickerTitle")}</h1>
          <p>{t("toolPickerLead")}</p>
        </header>

        <ToolSection title={t("catMotorControl")} hint={t("catMotorControlHint")}>
          <ToolCard
            title={t("toolControl")}
            desc={t("toolControlDesc")}
            tag={t("tagLiveControl")}
            accent="blue"
            onClick={() => onPick("control")}
          />
          <ToolCard
            title={t("toolSmartKnob")}
            desc={t("toolSmartKnobDesc")}
            tag={t("tagHaptics")}
            accent="lime"
            onClick={() => onPick("smartknob")}
          />
        </ToolSection>

        <ToolSection title={t("catRobotApp")} hint={t("catRobotAppHint")}>
          <ToolCard
            title={t("toolBaseZenoh")}
            desc={t("toolBaseZenohDesc")}
            tag={t("tagRobotApi")}
            accent="purple"
            onClick={() => onPick("zenoh")}
          />
          <ToolCard
            title={t("toolArmZenoh")}
            desc={t("toolArmZenohDesc")}
            tag={t("tagManipulator")}
            accent="pink"
            onClick={() => onPick("arm")}
          />
          <ToolCard
            title={t("toolHopeA3")}
            desc={t("toolHopeA3Desc")}
            tag={t("tagMobileBase")}
            accent="orange"
            onClick={() => onPick("hopea3")}
          />
        </ToolSection>

        <ToolSection title={t("catTools")} hint={t("catToolsHint")}>
          <ToolCard
            title={t("toolChangeId")}
            desc={t("toolChangeIdDesc")}
            tag={t("tagFactorySetup")}
            accent="amber"
            onClick={() => onPick("changeId")}
          />
          <ToolCard
            title={t("toolZero")}
            desc={t("toolZeroDesc")}
            tag={t("tagCalibration")}
            accent="green"
            onClick={() => onPick("zero")}
          />
          <ToolCard
            title={t("toolCanalyzer")}
            desc={t("toolCanalyzerDesc")}
            tag={t("tagDebug")}
            accent="cyan"
            onClick={() => onPick("canalyzer")}
          />
          <ToolCard
            title={t("toolTutorial")}
            desc={t("toolTutorialDesc")}
            tag={t("tagQuickStart")}
            accent="slate"
            onClick={() => setTutorialOpen(true)}
          />
        </ToolSection>
      </div>

      <TutorialModal open={tutorialOpen} onClose={() => setTutorialOpen(false)} />
    </div>
  );
}

function ToolSection({ title, hint, children }: { title: string; hint: string; children: ReactNode }) {
  return (
    <section className="tool-section">
      <div className="tool-section__heading">
        <h2>{title}</h2>
        <span>{hint}</span>
      </div>
      <div className="tool-section__grid">{children}</div>
    </section>
  );
}

function ToolCard({
  title,
  desc,
  tag,
  accent,
  onClick,
}: {
  title: string;
  desc: string;
  tag: string;
  accent: "blue" | "amber" | "green" | "cyan" | "purple" | "pink" | "orange" | "lime" | "slate";
  onClick: () => void;
}) {
  return (
    <button className={`tool-card tool-card--${accent}`} type="button" onClick={onClick}>
      <span className="tool-card__title">{title}</span>
      <span className="tool-card__desc">{desc}</span>
      <span className="tool-card__tag">{tag}</span>
    </button>
  );
}
