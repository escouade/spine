import type { ModuleEntry } from "@spinejs/core";
import { HttpGatewayModule, HttpModule } from "@spinejs/http-gateway";
import { AppContextFactory } from "./app-context";
import { AppErrorMapper, appStatusMapper } from "./app-error.mapper";
import { UsersController } from "./users.controller";
import { UsersStore } from "./users.store";

/**
 * Feature module that registers the controllers on the HTTP gateway. `@HttpModule` (decorator form)
 * keeps a named, exportable class — the equivalent factory form is `httpFeature({ ... })`. It needs
 * `HttpGatewayModule.configure({ ... })` somewhere in the graph to supply the gateway's ports.
 */
@HttpModule({
  controllers: [UsersController],
  providers: [UsersStore],
})
export class UsersModule {}

export const modules: ModuleEntry[] = [
  HttpGatewayModule.configure({
    imports: [],
    contextFactory: { value: new AppContextFactory() },
    errorMapper: { value: new AppErrorMapper() },
    statusMapper: { value: appStatusMapper },
    // port: 3000, // uncomment to auto-listen on a real port (App#start() calls gateway.listen())
  }),
  UsersModule,
];
