import { App } from "@spinejs/core";
import {
  HttpGateway,
  HttpGatewayModule,
  ZodValidator,
} from "@spinejs/http-gateway";
import { silentLogger } from "@spinejs/http-gateway/testing";
import { AppContextFactory } from "./app-context";
import { AppErrorMapper, appStatusMapper } from "./app-error.mapper";
import { UsersModule } from "./app.module";
import type { User } from "./users.store";

// Build the gateway here so the test can drive `gateway.app.request()` directly — DI registers the
// routes on this very instance (passed in via `configure({ gateway })`), no reaching into the App.
// `UsersModule` (the @HttpModule decorator form from app.module) registers the controller on it.
const gateway = new HttpGateway(
  new ZodValidator(),
  new AppErrorMapper(),
  new AppContextFactory(),
  [],
  appStatusMapper
);

describe("HTTP routes — method/query/path/body param extraction", () => {
  let app: App;

  beforeAll(async () => {
    app = new App(
      [
        HttpGatewayModule.configure({
          imports: [],
          gateway: { value: gateway },
        }),
        UsersModule,
      ],
      { logger: silentLogger, handleProcessExit: false }
    );
    await app.init();
  });

  afterAll(async () => {
    await app.stop();
  });

  it("GET /users lists every seeded user", async () => {
    const res = await gateway.app.request("/users");
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.data).toHaveLength(2);
  });

  it("GET /users?role=admin filters via the query string", async () => {
    const res = await gateway.app.request("/users?role=admin");
    const body = await res.json();
    expect(body.data).toEqual([
      expect.objectContaining({ name: "Ada Lovelace", role: "admin" }),
    ]);
  });

  it("POST /users creates a user from the JSON body (successStatus -> 201)", async () => {
    const res = await gateway.app.request("/users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Grace Hopper",
        email: "grace@example.com",
      }),
    });
    const body = await res.json();
    expect(res.status).toBe(201);
    const created: User = body.data;
    expect(created).toMatchObject({ name: "Grace Hopper", role: "member" });

    const getRes = await gateway.app.request(`/users/${created.id}`);
    expect((await getRes.json()).data).toEqual(created);
  });

  it("POST /users rejects an invalid body (BAD_REQUEST -> 400)", async () => {
    const res = await gateway.app.request("/users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "", email: "not-an-email" }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).ok).toBe(false);
  });

  it("PUT /users/:id updates a user via the structured path param", async () => {
    const list = await (await gateway.app.request("/users")).json();
    const [target]: User[] = list.data;

    const res = await gateway.app.request(`/users/${target.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role: "admin" }),
    });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.data).toMatchObject({ id: target.id, role: "admin" });
  });

  it("DELETE /users/:id is rejected without the admin header (AdminGuard -> 401)", async () => {
    const list = await (await gateway.app.request("/users")).json();
    const [target]: User[] = list.data;

    const res = await gateway.app.request(`/users/${target.id}`, {
      method: "DELETE",
    });
    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe("UNAUTHORIZED");

    // The guard rejected before the handler ran, so the user is still there.
    expect((await gateway.app.request(`/users/${target.id}`)).status).toBe(200);
  });

  it("DELETE /users/:id removes a user when the admin header passes the guard", async () => {
    const list = await (await gateway.app.request("/users")).json();
    const [target]: User[] = list.data;

    const res = await gateway.app.request(`/users/${target.id}`, {
      method: "DELETE",
      headers: { "x-admin": "true" },
    });
    expect((await res.json()).data).toEqual({ deleted: true });

    const getRes = await gateway.app.request(`/users/${target.id}`);
    expect(getRes.status).toBe(404);
  });

  it("GET /users/:id with an unknown id -> NOT_FOUND -> 404", async () => {
    const res = await gateway.app.request(
      "/users/00000000-0000-0000-0000-000000000000"
    );
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe("NOT_FOUND");
  });
});
