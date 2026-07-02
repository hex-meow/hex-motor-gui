import { useState } from "react";
import ReactDOM from "react-dom/client";
import { App as AntdApp, ConfigProvider, theme } from "antd";
import enUS from "antd/locale/en_US";
import zhCN from "antd/locale/zh_CN";
import "antd/dist/reset.css";
import App from "./App";
import { I18nProvider, type Lang } from "./i18n";

function Root() {
  const [lang, setLang] = useState<Lang>("en");
  return (
    <I18nProvider lang={lang} setLang={setLang}>
      <ConfigProvider
        locale={lang === "zh" ? zhCN : enUS}
        theme={{
          algorithm: theme.darkAlgorithm,
          token: { colorPrimary: "#E75B2B" },
        }}
      >
        <AntdApp>
          <App />
        </AntdApp>
      </ConfigProvider>
    </I18nProvider>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(<Root />);
