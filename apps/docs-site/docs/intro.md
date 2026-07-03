---
sidebar_position: 1
---

# Introduction

**SpineJS** is a lightweight, NestJS-flavored micro-framework for structuring Node processes. It brings the patterns you know from NestJS — modules, dependency injection, lifecycle hooks — without the weight of the full NestJS runtime or its HTTP-first assumptions.

It works equally well in background workers, CLI daemons, services, or any Node program that outgrows a flat `index.ts`.

The ecosystem is organized in layers that you compose à la carte — see the [package overview](#package-overview) below.

## Why SpineJS?

Node processes grow quickly. What starts as a flat script soon needs a config loader, logging, multiple cooperating services, and a clean shutdown path. NestJS solves these problems, but it pulls in reflect-metadata, a full HTTP stack, and several hundred kilobytes of runtime you may not need.

SpineJS answers the same architectural questions at a fraction of the weight:

- **No reflect-metadata.** Decorators store metadata as plain own-property symbols, safe under esbuild/swc without a global polyfill.
- **No transport lock-in.** The `Gateway` abstraction decouples your business controllers from whatever carries the bytes — IPC, HTTP, WebSocket, or nothing at all.
- **Structured lifecycle.** Every module participates in `init → start → stop`. Graceful shutdown, signal handling, and error propagation are handled for you.

## A taste

The smallest SpineJS app is a module with a lifecycle hook, booted by `App`:

```typescript
import { App, Module, OnInit } from "@spinejs/core";

@Module({ inject: [] })
export class GreeterModule implements OnInit {
  async onInit() {
    console.log("Hello from GreeterModule");
  }
}

const app = new App([GreeterModule]);
await app.init();
await app.start();
```

`SIGINT`/`SIGTERM` are handled for you: `onStop()` runs in reverse init order, the logger flushes, then the process exits — you never call `process.exit()` yourself.

:::tip Ready to build something real?
The [**Getting Started**](getting-started) guide takes you from an empty folder to a live HTTP API — service, controller, validation, and a running server — in five short steps.
:::

## Core concepts

| Concept          | What it does                                                                                                                              |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| **Module**       | Structural unit declared with `@Module({ inject: [...] })`; participates in the `init → start → stop` lifecycle.                          |
| **DI container** | Resolves constructor dependencies between modules via `InjectionToken`s — no decorators-on-everything, no reflect-metadata.               |
| **`App`**        | Orchestrates the module graph: builds it, runs lifecycle hooks in order, and handles process signals.                                     |
| **Gateway**      | Optional transport-agnostic request pipeline (guards → validation → handler → envelope) for processes that need to expose an API surface. |

## Where to go next

| Section                              | Covers                                                    |
| ------------------------------------ | --------------------------------------------------------- |
| [Getting Started](getting-started)   | Build a live HTTP API end-to-end in five steps            |
| [App Core](core/overview)            | `App`, modules, DI, lifecycle, built-in logger            |
| [Gateway](gateway/overview)          | Controllers, handlers, guards, validation, interceptors   |
| [Extensions](extensions/config)      | Typed config loading, Winston logger                      |
| [Electron](electron/electron-module) | Electron-specific lifecycle integration and IPC transport |

## Package overview

| Package                         | Role                                                                                                                           |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `@spinejs/core`                 | Module system, DI container, `App` orchestrator, lifecycle hooks, built-in logger                                              |
| `@spinejs/gateway-core`         | Building blocks to build a transport gateway: `DispatchPipeline`, ports, `@Controller`, field routes, `@UseGuards`, `Envelope` |
| `@spinejs/electron-ipc-gateway` | Electron IPC transport — composes the pipeline onto `ipcMain.handle`                                                           |
| `@spinejs/http-gateway`         | HTTP transport on Hono — composes the pipeline onto HTTP routes                                                                |
| `@spinejs/electron`             | `ElectronModule` (window + lifecycle) and `WindowService`                                                                      |
| `@spinejs/config`               | Typed, async-capable config loading                                                                                            |
| `@spinejs/winston-logger`       | Drop-in `Logger` implementation backed by Winston                                                                              |
