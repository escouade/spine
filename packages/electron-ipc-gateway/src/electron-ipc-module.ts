import {
  gatewayFeatureFactory,
  gatewayModuleDecorator,
} from "@spinejs/gateway-core";
import { ElectronIpcGateway } from "./electron-ipc.gateway";
import { ElectronIpcGatewayModule } from "./electron-ipc-gateway.module";

/**
 * IPC sugar to register controllers on the gateway, bound to `ElectronIpcGateway` +
 * `ElectronIpcGatewayModule`. Both reduce to the same synthesized `onInit` calling `gateway.register`.
 *
 * Requires `ElectronIpcGatewayModule.configure({ ... })` to be imported somewhere in the
 * module graph so the gateway's adapter ports are wired before route registration.
 *
 * Factory (primitive), mirrors the repo's `configure()` idiom — no named class:
 *   imports: [ ipcFeature({ controllers: [PingController] }) ]
 *
 * Decorator (sugar), NestJS-style, keeps a named module class:
 *   @IpcModule({ controllers: [PingController] })
 *   export class PingModule {}
 */
export const ipcFeature = gatewayFeatureFactory(
  ElectronIpcGateway,
  ElectronIpcGatewayModule
);
export const IpcModule = gatewayModuleDecorator(
  ElectronIpcGateway,
  ElectronIpcGatewayModule
);
