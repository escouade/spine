import type { ModuleEntry } from "@spinejs/core";
import type { GatewayInterceptor } from "@spinejs/gateway-core";
import { ClsInterceptor, ClsModule, ClsService } from "@spinejs/cls";
import { MikroOrmModule, MikroOrmInterceptor } from "@spinejs/mikro-orm";
import { BetterSqliteDriver } from "@mikro-orm/better-sqlite";
import {
  ElectronIpcGatewayModule,
  ipcFeature,
} from "@spinejs/electron-ipc-gateway";
import type {
  ElectronIpcBaseContext,
  IpcRoute,
} from "@spinejs/electron-ipc-gateway";
import { AppContextFactory } from "./app-context";
import { SchemaModule } from "./schema.module";
import { UserSchema, UserRepository } from "./user.entity";
import { UserService } from "./user.service";
import { UsersController } from "./users.controller";

/**
 * Wiring, in dev order (transport → connection → repositories → service). The one load-bearing detail
 * is the interceptor order: `ClsInterceptor` opens the request scope, then `MikroOrmInterceptor` forks
 * a per-request `EntityManager` into that scope and flushes it once at request end. `ClsModule` is a
 * single (non-`fresh`) module, so the `ClsService` the interceptor opens, the one MikroORM reads as its
 * context store, and the one the ORM interceptor writes to are all the SAME instance — essential.
 */
export const modules: ModuleEntry[] = [
  // The transport. Its interceptor stack is the whole point: CLS outermost, the ORM unit-of-work inside.
  ElectronIpcGatewayModule.configure({
    imports: [ClsModule, MikroOrmModule],
    contextFactory: { value: new AppContextFactory() },
    interceptors: {
      inject: [ClsService, MikroOrmInterceptor],
      factory: (cls: ClsService, orm: MikroOrmInterceptor) => [
        new ClsInterceptor<ElectronIpcBaseContext>(cls), // 1. outermost: opens the CLS scope
        // 2. inside the scope: forks the EM + brackets the transaction. MikroOrmInterceptor is
        // transport-agnostic (a GatewayInterceptor<GatewayContext> — it only touches CLS, never the
        // ctx or route), so we assert it into this transport's typed interceptor slot.
        orm as unknown as GatewayInterceptor<
          ElectronIpcBaseContext,
          string,
          IpcRoute
        >,
      ],
    },
  }),

  // The connection, configured once at app level: constructed at build, connected on start, closed on
  // stop. An in-memory sqlite DB keeps the example self-contained.
  MikroOrmModule.configure({
    driver: BetterSqliteDriver,
    dbName: ":memory:",
    entities: [UserSchema],
  }),

  // Creates the schema on start (demo only; a real app uses migrations).
  SchemaModule,

  // The feature: register the repository, provide the service, mount the controller's routes.
  ipcFeature({
    controllers: [UsersController],
    providers: [UserService],
    imports: [MikroOrmModule.register([UserRepository])],
  }),
];
