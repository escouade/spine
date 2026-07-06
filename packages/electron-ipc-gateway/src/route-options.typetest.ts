import { handle } from "./ipc-routes";

/**
 * Compile-time contract (checked by `tsc --noEmit`, never executed): the `throttle` route option is
 * NOT part of electron-ipc-gateway's own `IpcRouteSchemas` — it exists only through the
 * `declare module` augmentation shipped by `@spinejs/throttle` (AD-1: the transport carries no
 * battery vocabulary). If this package ever declared it, the assertion below would fail the typecheck.
 */
export const throttleOptionRequiresTheBattery = () =>
  // @ts-expect-error — without @spinejs/throttle installed, `throttle` is an unknown IPC route option
  handle("cmd:x", { throttle: false }, () => 0);
