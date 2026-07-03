# Example — HTTP routes over `@spinejs/http-gateway`

Runnable example of `@spinejs/http-gateway`: a `UsersController` exposing every HTTP verb and every
param source the Hono binding supports.

- `GET /users` — query string (`?role=admin`), validated by a zod schema.
- `GET /users/:id` — path param, merged into `input` (GET/DELETE have no body, so the gateway
  merges `c.req.param()` + `c.req.query()` into one object for the validator).
- `POST /users` — JSON body, validated by a zod schema.
- `PUT /users/:id` — JSON body **and** a path param. Body methods (`POST`/`PUT`/`PATCH`) only get
  `c.req.json()` as `input` — path params aren't merged in — so `:id` is read straight off
  `ctx.honoCtx.req.param("id")`.
- `DELETE /users/:id` — path param.

It also shows:

- `HttpGatewayModule.configure({ errorMapper, statusMapper })` with an app-specific `AppErrorMapper`
  that adds a `NOT_FOUND` code (404) on top of the package's default `BAD_REQUEST`/`UNAUTHORIZED`/
  `INTERNAL_ERROR`.
- `HttpGatewayModule.configure({ gateway })` to inject a pre-built `HttpGateway`, so the spec keeps a
  reference and drives it directly via Hono's `app.request(path, init)` — no network socket, and no
  reaching into the booted `App` for the instance.
- `HttpGatewayModule.configure({ port })` to auto-listen on a real port outside of tests (see
  `app.module.ts` — commented out here since the spec talks to the gateway in-process).

## Run

```bash
npx nx test example-http-routes
```
