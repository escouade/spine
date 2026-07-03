import type { ReactNode } from "react";
import clsx from "clsx";
import Link from "@docusaurus/Link";
import Translate, { translate } from "@docusaurus/Translate";
import useDocusaurusContext from "@docusaurus/useDocusaurusContext";
import Layout from "@theme/Layout";
import CodeBlock from "@theme/CodeBlock";

import styles from "./index.module.css";

type Feature = { title: ReactNode; body: ReactNode };

const FEATURES: Feature[] = [
  {
    title: (
      <Translate id="home.feature.noReflect.title">
        No reflect-metadata
      </Translate>
    ),
    body: (
      <Translate id="home.feature.noReflect.body">
        Decorators store metadata as plain own-property symbols. No
        experimentalDecorators flag — plain esbuild/swc builds work, with no
        global polyfill and no surprise runtime weight.
      </Translate>
    ),
  },
  {
    title: (
      <Translate id="home.feature.transport.title">
        Transport-agnostic
      </Translate>
    ),
    body: (
      <Translate id="home.feature.transport.body">
        The Gateway pipeline decouples controllers from whatever carries the
        bytes — IPC, HTTP, WebSocket, or nothing at all.
      </Translate>
    ),
  },
  {
    title: (
      <Translate id="home.feature.lifecycle.title">
        Structured lifecycle
      </Translate>
    ),
    body: (
      <Translate id="home.feature.lifecycle.body">
        Every module flows through init → start → stop. Graceful shutdown,
        signal handling, and ordered teardown come for free.
      </Translate>
    ),
  },
  {
    title: (
      <Translate id="home.feature.familiar.title">Familiar patterns</Translate>
    ),
    body: (
      <Translate id="home.feature.familiar.body">
        Modules, dependency injection, guards, and validation — the patterns you
        already know, at a fraction of the runtime weight.
      </Translate>
    ),
  },
  {
    title: (
      <Translate id="home.feature.composable.title">
        Composable à la carte
      </Translate>
    ),
    body: (
      <Translate id="home.feature.composable.body">
        Layered packages: take the core, add a gateway, bind a transport. Pull
        in only the pieces your process actually needs.
      </Translate>
    ),
  },
  {
    title: (
      <Translate id="home.feature.longlived.title">
        Built for any Node process
      </Translate>
    ),
    body: (
      <Translate id="home.feature.longlived.body">
        Background workers, CLI tools, desktop app processes, serverless
        functions — anything that outgrows a flat index.ts.
      </Translate>
    ),
  },
];

const SNIPPET = `import { App, Module, OnInit } from '@spinejs/core';

@Module({ inject: [] })
class GreeterModule implements OnInit {
  async onInit() {
    console.log('Hello from SpineJS');
  }
}

const app = new App([GreeterModule]);
await app.init();
await app.start();`;

function Hero(): ReactNode {
  const { siteConfig } = useDocusaurusContext();
  return (
    <header className={styles.hero}>
      <div className={clsx("container", styles.heroInner)}>
        <div className={styles.heroText}>
          <h1 className={styles.heroTitle}>{siteConfig.title}</h1>
          <p className={styles.heroTagline}>
            <Translate id="home.hero.tagline">
              Modules, DI, and lifecycle for Node processes.
            </Translate>
          </p>
          <div className={styles.heroButtons}>
            <Link
              className="button button--primary button--lg"
              to="/docs/intro"
            >
              <Translate id="home.hero.getStarted">Get started</Translate>
            </Link>
            <Link
              className={clsx("button button--lg", styles.ghostButton)}
              to="https://github.com/dev-studio-ai/spine"
            >
              <Translate id="home.hero.github">View on GitHub</Translate>
            </Link>
          </div>
        </div>
        <div className={styles.heroCode}>
          <CodeBlock language="typescript">{SNIPPET}</CodeBlock>
        </div>
      </div>
    </header>
  );
}

function Features(): ReactNode {
  return (
    <section className={styles.features}>
      <div className="container">
        <div className={styles.featureGrid}>
          {FEATURES.map((f, i) => (
            <div key={i} className={styles.featureCard}>
              <h3 className={styles.featureTitle}>{f.title}</h3>
              <p className={styles.featureBody}>{f.body}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

export default function Home(): ReactNode {
  return (
    <Layout
      title={translate({
        id: "home.meta.title",
        message: "SpineJS — Modules, DI, and lifecycle for Node",
      })}
      description={translate({
        id: "home.meta.description",
        message:
          "Modules, dependency injection, and lifecycle for Node processes.",
      })}
    >
      <Hero />
      <main>
        <Features />
      </main>
    </Layout>
  );
}
