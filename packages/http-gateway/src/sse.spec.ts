import { describe, expect, it, vi } from "vitest";
import { Controller, getRoutes } from "@spinejs/gateway-core";
import type {
  GatewayContext,
  Guard,
  GuardConstructor,
} from "@spinejs/gateway-core";
import { HttpGateway } from "./http.gateway";
import type { HttpRoute } from "./http.gateway";
import { sse } from "./http-routes";
import { SseHub } from "./sse-hub";
import { ZodValidator } from "./zod.validator";
import { DefaultHttpErrorMapper } from "./default-error.mapper";
import type { HttpAddress, HttpBaseContext, HttpRaw } from "./http-base.types";

class DenyGuard implements Guard<GatewayContext> {
  canActivate(): boolean {
    return false;
  }
}

@Controller({})
class StreamController {
  constructor(private readonly hub: SseHub<string>) {}
  stream = sse("/stream", {}, () => this.hub.subscribe("k"));
}

@Controller({})
class GuardedController {
  constructor(private readonly hub: SseHub<string>) {}
  stream = sse("/guarded", { guards: [DenyGuard] }, () =>
    this.hub.subscribe("k")
  );
}

const contextFactory = {
  create: (c: HttpRaw): HttpBaseContext => ({ honoCtx: c }),
};

function gatewayFor(routes: HttpRoute[]): HttpGateway {
  const gw = new HttpGateway(
    new ZodValidator(),
    new DefaultHttpErrorMapper(),
    contextFactory
  );
  gw.register(routes);
  return gw;
}

async function readUntilEvent(res: Response): Promise<string> {
  const body = res.body;
  if (!body) throw new Error("no response body");
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  try {
    for (let i = 0; i < 100; i++) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
      if (text.includes("event:")) break;
    }
  } finally {
    await reader.cancel();
  }
  return text;
}

describe("sse() route over the HTTP transport", () => {
  it("responds with text/event-stream and fans a published event to the subscriber", async () => {
    const hub = new SseHub<string>();
    const routes = getRoutes<HttpBaseContext, HttpAddress>(
      new StreamController(hub),
      new Map<GuardConstructor, Guard<GatewayContext>>()
    );
    const gw = gatewayFor(routes);

    const res = await gw.app.request("/stream");
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    await vi.waitUntil(() => hub.subscriberCount("k") === 1, { timeout: 1000 });
    hub.publish("k", { event: "job.updated", data: { id: 1 } });

    const text = await readUntilEvent(res);
    expect(text).toContain("event: job.updated");
    expect(text).toContain('data: {"id":1}');
  });

  it("runs guards before streaming; a denied guard returns a 401 JSON envelope, no stream", async () => {
    const hub = new SseHub<string>();
    const guardMap = new Map<GuardConstructor, Guard<GatewayContext>>([
      [DenyGuard, new DenyGuard()],
    ]);
    const routes = getRoutes<HttpBaseContext, HttpAddress>(
      new GuardedController(hub),
      guardMap
    );
    const gw = gatewayFor(routes);

    const res = await gw.app.request("/guarded");
    expect(res.status).toBe(401);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual({ ok: false, code: "UNAUTHORIZED" });
  });
});
