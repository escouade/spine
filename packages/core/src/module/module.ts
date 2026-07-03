/**
 * **Optional** lifecycle hooks, detected by method presence
 * (no inheritance required: a module is a plain class decorated with `@Module`).
 */
export interface OnInit {
  /** Called once this module is built (its imports already initialized). */
  onInit(): void | Promise<void>;
}

export interface OnStart {
  /** Called by `App.start()`, after every module is initialized (init order). */
  onStart(): void | Promise<void>;
}

export interface OnStop {
  /** Called on App shutdown (reverse init order). */
  onStop(): void | Promise<void>;
}

export function hasOnInit(x: unknown): x is OnInit {
  return typeof (x as Partial<OnInit> | null)?.onInit === "function";
}

export function hasOnStart(x: unknown): x is OnStart {
  return typeof (x as Partial<OnStart> | null)?.onStart === "function";
}

export function hasOnStop(x: unknown): x is OnStop {
  return typeof (x as Partial<OnStop> | null)?.onStop === "function";
}
