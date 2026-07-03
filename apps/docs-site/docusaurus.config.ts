import type { Config } from "@docusaurus/types";
import type * as Preset from "@docusaurus/preset-classic";
import { themes as prismThemes } from "prism-react-renderer";

const config: Config = {
  title: "SpineJS",
  tagline: "Modules, DI, and lifecycle for Node processes",
  url: "https://dev-studio-ai.github.io",
  baseUrl: "/spine/",
  onBrokenLinks: "throw",
  favicon: "img/favicon.ico",
  markdown: {
    hooks: {
      onBrokenMarkdownLinks: "warn",
    },
  },

  i18n: {
    defaultLocale: "en",
    locales: ["en", "fr"],
    localeConfigs: {
      en: { label: "English" },
      fr: { label: "Français" },
    },
  },

  themes: [
    [
      "@easyops-cn/docusaurus-search-local",
      {
        hashed: true,
        docsRouteBasePath: "/docs",
        indexBlog: false,
        highlightSearchTermsOnTargetPage: true,
      },
    ],
  ],

  presets: [
    [
      "classic",
      {
        docs: {
          sidebarPath: "./sidebars.ts",
          routeBasePath: "/docs",
          editUrl:
            "https://github.com/dev-studio-ai/spine/tree/main/apps/docs-site/",
        },
        blog: false,
        theme: { customCss: "./src/css/custom.css" },
      } satisfies Preset.Options,
    ],
  ],

  themeConfig: {
    image: "img/logo.svg",
    colorMode: { defaultMode: "dark", disableSwitch: false },
    navbar: {
      title: "SpineJS",
      logo: { alt: "SpineJS logo", src: "img/logo.svg" },
      items: [
        {
          type: "docSidebar",
          sidebarId: "mainSidebar",
          position: "left",
          label: "Docs",
        },
        {
          href: "https://github.com/dev-studio-ai/spine",
          label: "GitHub",
          position: "right",
        },
        { type: "localeDropdown", position: "right" },
      ],
    },
    footer: {
      style: "dark",
      links: [
        {
          title: "Docs",
          items: [
            { label: "Introduction", to: "/docs/intro" },
            { label: "Core", to: "/docs/core/overview" },
            { label: "Gateway", to: "/docs/gateway/overview" },
          ],
        },
        {
          title: "Packages",
          items: [
            { label: "Extensions", to: "/docs/extensions/config" },
            { label: "Electron", to: "/docs/electron/electron-module" },
            { label: "Transports", to: "/docs/transports/electron-ipc" },
          ],
        },
        {
          title: "More",
          items: [
            { label: "GitHub", href: "https://github.com/dev-studio-ai/spine" },
          ],
        },
      ],
      copyright: `Copyright © ${new Date().getFullYear()} Dev Studio. Built with Docusaurus.`,
    },
    prism: {
      theme: prismThemes.oneDark,
      darkTheme: prismThemes.oneDark,
      additionalLanguages: ["typescript", "bash"],
    },
  } satisfies Preset.ThemeConfig,
};

export default config;
