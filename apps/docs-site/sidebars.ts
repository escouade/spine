import type { SidebarsConfig } from "@docusaurus/plugin-content-docs";

const sidebars: SidebarsConfig = {
  mainSidebar: [
    "intro",
    "getting-started",
    {
      type: "category",
      label: "Core",
      items: [
        "core/overview",
        "core/modules",
        "core/dependency-injection",
        "core/lifecycle",
        "core/logging",
      ],
    },
    {
      type: "category",
      label: "Building an API",
      items: [
        "gateway/overview",
        "gateway/controllers-handlers",
        "gateway/feature-modules",
        "gateway/validation",
        "gateway/guards",
        "gateway/interceptors",
      ],
    },
    {
      type: "category",
      label: "Transports",
      items: ["transports/http", "transports/electron-ipc"],
    },
    {
      type: "category",
      label: "Electron",
      items: ["electron/electron-module"],
    },
    {
      type: "category",
      label: "Extensions",
      items: [
        "extensions/config",
        "extensions/winston-logger",
        "extensions/cls",
      ],
    },
  ],
};

export default sidebars;
