import type { DispatchTarget, Envelope } from "@spinejs/gateway-core";
import { ClsService } from "./cls.service";
import { ClsInterceptor } from "./cls.interceptor";

interface AppContext {
  event: unknown;
  user: string;
}

const target: DispatchTarget<AppContext> = {
  guards: [],
  invoke: () => undefined,
};

const okEnvelope = async (): Promise<Envelope<unknown>> => ({
  ok: true,
  data: undefined,
});

describe("ClsInterceptor", () => {
  it("seeds the scope by spreading the context by default", async () => {
    const cls = new ClsService();
    const interceptor = new ClsInterceptor<AppContext>(cls);
    let seenUser: string | undefined;

    await interceptor.intercept(
      target,
      { event: {}, user: "alice" },
      undefined,
      async () => {
        seenUser = cls.get<string>("user");
        return okEnvelope();
      }
    );

    expect(seenUser).toBe("alice");
  });

  it("uses a custom seed when provided", async () => {
    const cls = new ClsService();
    const interceptor = new ClsInterceptor<AppContext>(cls, (ctx) => ({
      user: ctx.user,
      reqId: "fixed",
    }));
    let seenReqId: string | undefined;

    await interceptor.intercept(
      target,
      { event: {}, user: "bob" },
      undefined,
      async () => {
        seenReqId = cls.get<string>("reqId");
        return okEnvelope();
      }
    );

    expect(seenReqId).toBe("fixed");
  });

  it("does not leak the scope outside intercept", async () => {
    const cls = new ClsService();
    const interceptor = new ClsInterceptor<AppContext>(cls);

    await interceptor.intercept(
      target,
      { event: {}, user: "alice" },
      undefined,
      () => okEnvelope()
    );

    expect(cls.active).toBe(false);
  });
});
