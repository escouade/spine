---
sidebar_position: 4
---

# Validation

You validate handler input by attaching a schema to a route. The pipeline runs it before your handler, and the callback's `input` is **inferred** from that schema — one source of truth, checked at compile time and at runtime. Under the hood this goes through a pluggable `Validator` port (see [how it works](#how-it-works) below), but day to day you only touch schemas.

## Using schemas in routes

Pass a schema in the route options (`{ input }` for IPC, `{ params }`/`{ query }`/`{ body }` for HTTP). If validation fails, the handler is **never called** — the response is an error envelope instead.

```typescript
import { z } from "zod";
import { Controller } from "@spinejs/gateway-core";
import { handle } from "@spinejs/electron-ipc-gateway";

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
});

@Controller({ inject: [AuthService] })
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  // `input` is inferred as { email: string; password: string } and already validated.
  login = handle("auth:login", { input: loginSchema }, (input) =>
    this.authService.login(input.email, input.password)
  );
}
```

If the caller sends `{ email: 'not-an-email', password: '123' }`, the handler is never called. The response is `{ ok: false, code: 'INVALID_INPUT' }` (whatever code your `ErrorMapper` assigns to a `ValidationError`).

## Routes without a schema

Omit the schema and the raw input from the transport is passed through untouched:

```typescript
ping = handle("ping", {}, () => "pong");
```

Fine for routes that take no input, or when you want to handle the raw input yourself.

## How it works

Validation goes through the `Validator` port, so the gateway core carries no runtime dependency on any validation library — you wire in your chosen adapter (zod, joi, class-validator…) at the transport layer.

### The `Validator` port

```typescript
interface Validator {
  validate<T>(schema: ParseableSchema<T>, input: unknown): T;
}
```

- **`schema`** — any object with a `parse(input: unknown): T` method (the `ParseableSchema<T>` structural type).
- **`input`** — the raw input from the transport.

It returns the parsed, typed `T` on success, or **throws `ValidationError`** on failure.

### `ParseableSchema<T>`

```typescript
interface ParseableSchema<T> {
  parse(input: unknown): T;
}
```

Any schema library exposing a `parse` method satisfies this structural interface — most notably **zod**. Because it is structural (duck typing), your controllers import zod schemas directly while the gateway library never depends on zod.

### The Zod adapter

The reference `ZodValidator` normalizes a `ZodError` into a `ValidationError`:

```typescript
import { ZodError } from "zod";
import {
  ParseableSchema,
  ValidationError,
  Validator,
} from "@spinejs/gateway-core";

export class ZodValidator implements Validator {
  validate<T>(schema: ParseableSchema<T>, input: unknown): T {
    try {
      return schema.parse(input);
    } catch (err) {
      if (err instanceof ZodError) {
        const detail = err.issues
          .map(
            (issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`
          )
          .join("; ");
        throw new ValidationError(detail);
      }
      throw err;
    }
  }
}
```

The gateway pipeline catches the `ValidationError` and the `ErrorMapper` converts it to the transport's error code (e.g. `'INVALID_INPUT'`).

### Wiring the validator

The validator is injected into the gateway via a factory provider in the transport module. Both `HttpGatewayModule` and `ElectronIpcGatewayModule` default to `ZodValidator`, so you only wire this by hand when you build the gateway yourself:

```typescript
import { InjectionToken, Module } from "@spinejs/core";
import { Validator } from "@spinejs/gateway-core";
import { ElectronIpcGateway } from "@spinejs/electron-ipc-gateway";
import { ZodValidator } from "./zod.validator";

const validatorToken = new InjectionToken<Validator>("validator");

@Module({
  providers: [
    { provide: validatorToken, factory: () => new ZodValidator() },
    {
      provide: ElectronIpcGateway,
      inject: [validatorToken /* errorMapper, contextFactory, logger */],
      factory: (validator, errorMapper, contextFactory, logger) =>
        new ElectronIpcGateway(validator, errorMapper, contextFactory, logger),
    },
  ],
  exports: [ElectronIpcGateway],
})
export class ElectronIpcGatewayModule {}
```

## `ValidationError`

`ValidationError` is re-exported from `@spinejs/gateway-core`. Import it in your `Validator` implementation and in your `ErrorMapper`:

```typescript
import { ValidationError } from "@spinejs/gateway-core";

// In ErrorMapper.toCode():
if (err instanceof ValidationError) return "INVALID_INPUT";
```

The message carried by `ValidationError` is not forwarded to the transport consumer (the `ErrorMapper` only returns the code string). Log it server-side if you need the detail.
