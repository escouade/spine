import {
  Container,
  DynamicModule,
  InjectionToken,
  Module,
  ModuleConstructor,
  ModuleEntry,
  ModuleMetadata,
  OnInit,
  ProviderConstructor,
} from "@spinejs/core";
import type {
  Guard,
  GatewayContext,
  GuardConstructor,
  LoadedRoute,
} from "./gateway.types";
import { getReferencedGuards, getRoutes } from "./route";

/**
 * Hidden slot where `@spinejs/core`'s module loader stamps each module's own `Container`, just before
 * `onInit`. Framework-internal back-channel (not a public token, not in the DI graph) — re-derived
 * here via the same `Symbol.for` key so the feature module can resolve per-route guard classes it
 * only discovers at instance time. MUST match the key in core's `module-loader`.
 */
const OWN_CONTAINER_SLOT = Symbol.for("spinejs:module-own-container");

/** Minimal structural view of a gateway: all the feature module needs is to register routes. */
interface GatewayRegistrar {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  register(routes: LoadedRoute<GatewayContext, any>[]): void;
}

/** Token resolving to a transport gateway (its concrete registrar, by class or InjectionToken). */
type GatewayToken =
  | ProviderConstructor<GatewayRegistrar>
  | InjectionToken<GatewayRegistrar>;

/** Feature module config: standard module metadata plus the controllers to auto-register. */
export interface FeatureModuleConfig extends ModuleMetadata {
  controllers: ProviderConstructor[];
}

/** Base a feature module extends — `class {}` for the factory, the user class for the decorator. */
type ModuleBase = ModuleConstructor;

/**
 * Core mechanic shared by both sugar forms. Builds a module **class** whose synthesized `onInit`
 * resolves the gateway + controllers (constructor-injected, fixed order `[gateway, ...controllers,
 * ...userInject]`), resolves every referenced guard from the module's **own container** (class-level
 * `@UseGuards` + per-route `guards`, discovered from the controller instances), builds a guard map,
 * calls `getRoutes(ctrl, guardMap)` for each controller, and passes the pre-resolved descriptors to
 * `gateway.register()`. The user's own `onInit` (if any) runs **after** registration.
 *
 * Guards are resolved lazily here (not constructor-injected) because per-route guard classes live in
 * controller fields — unknown until the controller is instantiated. The container is reached through
 * the framework's hidden `OWN_CONTAINER_SLOT`; unregistered guard classes are added on demand, so an
 * `@Injectable` guard's own deps resolve from this container (its imports' exports + providers).
 */
function defineFeatureModuleClass(
  token: GatewayToken,
  transport: ModuleEntry,
  config: FeatureModuleConfig,
  Base: ModuleBase
): ModuleConstructor {
  const {
    controllers,
    providers = [],
    imports = [],
    inject = [],
    exports,
  } = config;

  class FeatureModule extends Base implements OnInit {
    private readonly __gateway: GatewayRegistrar;
    private readonly __controllers: object[];

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(...args: any[]) {
      const [gateway, ...rest] = args as [GatewayRegistrar, ...object[]];
      const controllerInstances = rest.slice(0, controllers.length) as object[];
      const userDeps = rest.slice(controllers.length);
      super(...(userDeps as never[]));
      this.__gateway = gateway;
      this.__controllers = controllerInstances;
    }

    async onInit(): Promise<void> {
      const container = (this as Record<symbol, unknown>)[
        OWN_CONTAINER_SLOT
      ] as Container | undefined;
      if (!container) {
        throw new Error(
          "Gateway feature module: own Container not available — the core module loader must stamp it before onInit."
        );
      }
      const guardMap = new Map<GuardConstructor, Guard<GatewayContext>>();
      for (const ctrl of this.__controllers) {
        for (const cls of getReferencedGuards(ctrl)) {
          if (guardMap.has(cls)) continue;
          if (!container.has(cls)) container.add({ provide: cls });
          guardMap.set(cls, container.get<Guard<GatewayContext>>(cls));
        }
      }
      const allRoutes = this.__controllers.flatMap((ctrl) =>
        getRoutes(ctrl, guardMap)
      );
      this.__gateway.register(allRoutes);
      const parentInit = (Base.prototype as Partial<OnInit>).onInit;
      if (typeof parentInit === "function") await parentInit.call(this);
    }
  }

  Module({
    imports: [transport, ...imports],
    providers: [...controllers, ...providers],
    inject: [token, ...controllers, ...inject],
    exports,
  })(FeatureModule);

  return FeatureModule;
}

/**
 * Factory (primitive) — mirrors the repo's `Module.configure()` idiom. Returns a self-contained
 * `DynamicModule` that registers `controllers` on the gateway. No named class, no subclass magic.
 *
 *   imports: [ ipcFeature({ controllers: [PingController] }) ]
 */
export function gatewayFeatureFactory(
  token: GatewayToken,
  transport: ModuleEntry
) {
  return (config: FeatureModuleConfig): DynamicModule => {
    const Empty = class {} as ModuleBase;
    const module = defineFeatureModuleClass(token, transport, config, Empty);
    const label = config.controllers.map((c) => c.name).join(",");
    Object.defineProperty(module, "name", {
      value: `GatewayFeature(${label})`,
    });
    return { module };
  };
}

/**
 * Decorator (sugar) — NestJS-style ergonomics, keeps a named module class. Replaces the class with
 * a subclass carrying the registrar `onInit`; the user may still declare `providers`/`imports`/
 * `exports`/`inject` (for its own constructor) and its own `onInit`.
 *
 *   @IpcModule({ controllers: [PingController] })
 *   export class PingModule {}
 */
export function gatewayModuleDecorator(
  token: GatewayToken,
  transport: ModuleEntry
) {
  return (config: FeatureModuleConfig) =>
    <C extends new (...args: never[]) => object>(UserClass: C): C => {
      const module = defineFeatureModuleClass(
        token,
        transport,
        config,
        UserClass as unknown as ModuleBase
      );
      Object.defineProperty(module, "name", { value: UserClass.name });
      return module as unknown as C;
    };
}
