import { App, Button, Empty, List, Space, Tag, Tooltip, Typography } from "antd";
import { TranslationOutlined } from "@ant-design/icons";
import { api, errMsg } from "../api";
import { nid2hex } from "../format";
import { useI18n } from "../i18n";
import { LifecycleTag, LogicTag, OnlineTag } from "../tags";
import type { MotorInfo } from "../types";

export function Sidebar({
  devices,
  selectedNid,
  onSelect,
  connected,
  tool,
}: {
  devices: MotorInfo[];
  selectedNid: number | null;
  onSelect: (nid: number) => void;
  connected: boolean;
  tool: "control" | "changeId" | "zero";
}) {
  const { message } = App.useApp();
  const { t, lang, toggle } = useI18n();

  const initAll = async () => {
    try {
      const results = await api.initializeAll();
      const failed = results.filter(([, e]) => e != null);
      if (failed.length === 0) message.success(t("initAllDone"));
      else message.warning(`${t("initAllPartial")} ${failed.map(([n]) => nid2hex(n)).join(", ")}`);
    } catch (e) {
      message.error(`${t("initFailed")}: ${errMsg(e)}`);
    }
  };

  const forgetOffline = async () => {
    try {
      await api.forgetOffline();
    } catch (e) {
      message.error(errMsg(e));
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div style={{ padding: 12, flex: 1, overflow: "auto" }}>
        <Space style={{ justifyContent: "space-between", width: "100%", marginBottom: 8 }}>
          <Typography.Text strong>
            {t("motors")} ({devices.length})
          </Typography.Text>
          {tool === "control" ? (
            <Button size="small" disabled={!connected || devices.length === 0} onClick={initAll}>
              {t("initAll")}
            </Button>
          ) : (
            <Button size="small" disabled={!connected} onClick={forgetOffline}>
              {t("forgetOffline")}
            </Button>
          )}
        </Space>

        {devices.length === 0 ? (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={connected ? t("discovering") : t("notConnected")}
          />
        ) : (
          <List
            dataSource={devices}
            rowKey={(d) => d.node_id}
            renderItem={(d) => {
              const selected = d.node_id === selectedNid;
              return (
                <List.Item
                  onClick={() => onSelect(d.node_id)}
                  style={{
                    cursor: "pointer",
                    padding: "8px 10px",
                    borderRadius: 8,
                    marginBottom: 6,
                    background: selected ? "rgba(79,140,255,0.18)" : "transparent",
                    border: selected ? "1px solid #4f8cff" : "1px solid transparent",
                  }}
                >
                  <div style={{ width: "100%" }}>
                    <Space style={{ justifyContent: "space-between", width: "100%" }}>
                      <Typography.Text strong>{d.friendly_name}</Typography.Text>
                      <Typography.Text code>{nid2hex(d.node_id)}</Typography.Text>
                    </Space>
                    <div style={{ marginTop: 4 }}>
                      <OnlineTag online={d.online} />
                      {d.device_type === "imu" ? (
                        <Tag color="geekblue">IMU</Tag>
                      ) : (
                        <>
                          <LifecycleTag lc={d.lifecycle} />
                          <LogicTag logic={d.logic} />
                        </>
                      )}
                    </div>
                  </div>
                </List.Item>
              );
            }}
          />
        )}
      </div>

      <div style={{ padding: 12, borderTop: "1px solid #262b35" }}>
        <Tooltip title={t("languageTip")}>
          <Button block icon={<TranslationOutlined />} onClick={toggle}>
            {lang === "en" ? "中文" : "English"}
          </Button>
        </Tooltip>
      </div>
    </div>
  );
}
