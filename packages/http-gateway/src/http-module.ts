import {
  gatewayFeatureFactory,
  gatewayModuleDecorator,
} from "@spinejs/gateway-core";
import { HttpGateway } from "./http.gateway";
import { HttpGatewayModule } from "./http-gateway.module";

/**
 * HTTP sugar to register controllers on the gateway, bound to `HttpGateway` + `HttpGatewayModule`.
 * Both reduce to the same synthesized `onInit` calling `gateway.register`.
 *
 * Requires `HttpGatewayModule.configure({ ... })` to be imported somewhere in the module graph.
 *
 * Factory (primitive):
 *   imports: [ httpFeature({ controllers: [UserController] }) ]
 *
 * Decorator (sugar):
 *   @HttpModule({ controllers: [UserController] })
 *   export class UserModule {}
 */
export const httpFeature = gatewayFeatureFactory(
  HttpGateway,
  HttpGatewayModule
);
export const HttpModule = gatewayModuleDecorator(
  HttpGateway,
  HttpGatewayModule
);
