import { Container, normalizeProvider } from "../container";
import { Logger } from "../logger";
import { Timer } from "../utils";
import { ModuleRef } from "./module-ref";
import { ModuleNode, ModuleConstructor } from "./module-node";
import {
  DynamicModule,
  ModuleEntry,
  getModuleMetadata,
} from "./module-decorator";
import { hasOnInit } from "./module";

/**
 * Hidden, non-enumerable slot where each module instance receives its own `Container` just before
 * `onInit` (see `buildAndInitModule`). Framework-internal back-channel — never a public token, never
 * in the DI graph. Keyed by `Symbol.for` so a downstream package (e.g. `@spinejs/gateway-core`) can read
 * the same slot by re-deriving the key, without `@spinejs/core` exporting anything for it.
 */
const OWN_CONTAINER_SLOT = Symbol.for("spinejs:module-own-container");

/** Human-readable name of a module identity (class or DynamicModule object), for error messages. */
function identityName(identity: object): string {
  return typeof identity === "function"
    ? identity.name
    : (identity as DynamicModule).module.name;
}

/**
 * Loads the module graph into live instances: builds one `ModuleNode` per identity (phase 1), checks
 * the graph is acyclic, then instantiates + `onInit()`s every module (phase 2). `App` delegates here
 * and only keeps the process/app lifecycle.
 */
export class ModuleLoader {
  // One ModuleNode per identity (class for single modules, DynamicModule object for `fresh`).
  private readonly nodes: Map<object, ModuleNode> = new Map();
  // Final registry: a ref lands here only once fully resolved (built + onInit()), in init order.
  // Filled incrementally during resolve() — so it holds the partial set even if resolve() throws,
  // which is what App.stop() needs to tear down the modules that DID initialize.
  private readonly resolvedModules: Map<object, ModuleRef> = new Map();
  // In-flight resolution promise, memoized by module identity. Set BEFORE any await
  // → a shared module is resolved only once, even if several branches import it
  // concurrently (diamond).
  private readonly resolvePromises: Map<object, Promise<ModuleRef>> = new Map();
  // Keyed by module identity (object) to time each module's onInit() independently.
  private readonly timer = new Timer<object>();

  constructor(
    private readonly logger: Logger,
    private readonly globalContainer: Container,
    private readonly rootEntries: ModuleEntry[]
  ) {}

  /** Loaded modules in init order. Live (and possibly partial if load() failed mid-way). */
  get modules(): ReadonlyMap<object, ModuleRef> {
    return this.resolvedModules;
  }

  /**
   * Two distinct phases:
   *  1) buildNodes — synchronously builds each module's ModuleNode and stores one entry per identity
   *     in the nodes map. A class imported from several places shares a single entry that accumulates
   *     every dynamic-module's extra providers. No resolution here, no container touched.
   *  2) resolveModules — instantiates/inits by reading the already-finalized nodes (pure get) and
   *     registering their providers into containers.
   * Splitting the phases guarantees a module's full provider set is known before phase 2 starts
   * feeding it to a container — where the first registration of a token wins (Container.add).
   * Returns the modules in init order (deps before dependents) for App to run onStart/onStop.
   */
  async load(): Promise<Map<object, ModuleRef>> {
    this.buildNodes();
    this.detectCycles();
    await this.resolveModules();
    return this.resolvedModules;
  }

  /** Phase 1: builds each module's ModuleNode and stores one entry per identity in the map. */
  private buildNodes(): void {
    // identity -> imports already walked for it. Decoupled from the build: buildNode runs on every
    // occurrence (so a DynamicModule's extras always accumulate), while the walk only recurses into
    // imports not yet seen — terminates on cycles AND covers imports added by a later dynamic
    // occurrence (the old `visited` early-return missed those: see #3).
    const walked = new Map<object, Set<object>>();
    const visit = (entry: ModuleEntry): void => {
      const node = this.buildNode(entry);
      let seen = walked.get(node.identity);
      if (!seen) walked.set(node.identity, (seen = new Set()));
      for (const imported of node.imports ?? []) {
        const id = this.identityOf(imported);
        if (seen.has(id)) {
          // Already recursed into this identity; still accumulate DynamicModule extras (providers /
          // imports / exports). The comment on buildNodes says "buildNode runs on every occurrence".
          this.buildNode(imported);
          continue;
        }
        seen.add(id);
        visit(imported);
      }
    };
    for (const entry of this.rootEntries) visit(entry);
  }

  /**
   * Static cycle detection (classic colored DFS) on the graph built in phase 1 — before any
   * resolution, so it is independent of resolution order and memoization. White = unvisited,
   * gray = on the current path (recursion stack), black = fully explored. An edge to a gray node
   * is a back-edge → cycle. Running it here guarantees phase 2 resolves a DAG (no deadlock).
   */
  private detectCycles(): void {
    const WHITE = 0;
    const GRAY = 1;
    const BLACK = 2;
    const color = new Map<object, number>();
    const stack: object[] = []; // current path, only to render the cycle in the error message

    const dfs = (identity: object): void => {
      color.set(identity, GRAY);
      stack.push(identity);
      const node = this.nodes.get(identity);
      for (const imported of node?.imports ?? []) {
        const id = this.identityOf(imported);
        const c = color.get(id) ?? WHITE;
        if (c === GRAY) {
          const path = [...stack.slice(stack.indexOf(id)), id]
            .map(identityName)
            .join(" -> ");
          throw new Error(`Circular dependency between modules: ${path}`);
        }
        if (c === WHITE) dfs(id);
      }
      stack.pop();
      color.set(identity, BLACK);
    };

    for (const entry of this.rootEntries) {
      const id = this.identityOf(entry);
      if ((color.get(id) ?? WHITE) === WHITE) dfs(id);
    }
  }

  private async resolveModules(): Promise<void> {
    this.logger.debug("Resolve modules", ModuleLoader.name);
    // Kick off every root; deeper modules register their own memoized promise as resolution
    // cascades down imports.
    for (const entry of this.rootEntries)
      void this.resolveModule(this.getNode(entry));

    // Drain: keep awaiting until no new in-flight resolution appears (deep modules are created
    // while awaiting their parents). Unlike Promise.all — which rejects on the FIRST failure and
    // leaves siblings running — this lets every module settle before init() decides, so a
    // successfully-initialized module can't escape the registry (and thus onStop) on a partial boot.
    let results: PromiseSettledResult<ModuleRef>[] = [];
    let count = -1;
    while (this.resolvePromises.size !== count) {
      count = this.resolvePromises.size;
      results = await Promise.allSettled(this.resolvePromises.values());
    }

    // Dedup by reference: one failure propagates through every awaiter (e.g. a cycle rejects both
    // ends with the same Error object), so the same reason can appear several times.
    const errors = [
      ...new Set(
        results.flatMap((r) => (r.status === "rejected" ? [r.reason] : []))
      ),
    ];
    if (errors.length) {
      throw errors.length === 1
        ? errors[0]
        : new AggregateError(
            errors,
            `${errors.length} modules failed to initialize`
          );
    }
  }

  /**
   * Dedup/cache key for a module entry: the class (single-instance) or the DynamicModule object
   * itself when `fresh` (one instance per `configure()` call). Mirrors buildNode.
   */
  private identityOf(entry: ModuleEntry): object {
    if (entry instanceof ModuleNode) return entry.identity;
    if (typeof entry === "function") return entry;
    return entry.fresh ? entry : entry.module;
  }

  /**
   * Phase 2 (pure get): retrieves the ModuleNode already built in phase 1. Builds nothing and merges
   * nothing — the invariant is that `buildNodes` cached everything first.
   */
  private getNode(entry: ModuleEntry): ModuleNode {
    const key = this.identityOf(entry);
    const node = this.nodes.get(key);
    if (!node) {
      const name =
        key instanceof Function ? key.name : this.moduleKeyOf(entry).name;
      throw new Error(
        `Module ${name} missing from cache: buildNodes() must run before resolveModules().`
      );
    }
    return node;
  }

  /** Original class behind an entry (for error messages / class-token lookups). */
  private moduleKeyOf(entry: ModuleEntry): ModuleConstructor {
    if (entry instanceof ModuleNode) return entry.moduleKey;
    return (
      typeof entry === "function" ? entry : entry.module
    ) as ModuleConstructor;
  }

  /**
   * Phase 1 (build): normalizes an entry (`@Module` class, `DynamicModule`, or explicit `ModuleNode`)
   * into a single ModuleNode per class (memoized), accumulating a dynamic module's extra
   * providers/imports/exports. Called only by `buildNodes`.
   */
  private buildNode(entry: ModuleEntry): ModuleNode {
    if (entry instanceof ModuleNode) {
      const cached = this.nodes.get(entry.identity);
      if (cached) return cached;
      this.nodes.set(entry.identity, entry);
      return entry;
    }

    const dynamic = typeof entry !== "function";
    const cls = (
      dynamic ? (entry as DynamicModule).module : entry
    ) as ModuleConstructor;
    // `fresh` → identity is the DynamicModule object itself (one instance per configure() call),
    // so it is never merged with the bare class or with another config of the same class.
    const fresh = dynamic && (entry as DynamicModule).fresh === true;
    const identity: object = fresh ? entry : cls;

    let node = this.nodes.get(identity);
    if (!node) {
      const meta = getModuleMetadata(cls) ?? {};
      node = new ModuleNode(
        {
          module: cls,
          inject: meta.inject ? [...meta.inject] : undefined,
          imports: meta.imports ? [...meta.imports] : undefined,
          providers: meta.providers ? [...meta.providers] : undefined,
          exports: meta.exports ? [...meta.exports] : undefined,
        },
        identity,
        fresh
      );
      this.nodes.set(identity, node);
    }

    if (dynamic) {
      const d = entry as DynamicModule;
      if (d.providers?.length) node.addProviders(d.providers);
      if (d.imports?.length) node.addImports(d.imports);
      if (d.exports?.length) node.addExports(d.exports);
    }

    return node;
  }

  /**
   * Resolves a module: memoizes the promise (dedup of concurrent branches) then delegates the
   * build + init to `buildAndInitModule`. The promise is set before any await, so a diamond triggers
   * only a single resolution.
   */
  private resolveModule(node: ModuleNode): Promise<ModuleRef> {
    const existing = this.resolvePromises.get(node.identity);
    if (existing) return existing;

    const promise = this.buildAndInitModule(node);
    this.resolvePromises.set(node.identity, promise);
    return promise;
  }

  /**
   * Resolves **all imports first (init included)**, then builds the module: its injected dependencies
   * are therefore already initialized at `new` time. Finally inits the module itself. The graph is
   * already a DAG (detectCycles ran in phase 1), so no cycle check here.
   */
  private async buildAndInitModule(node: ModuleNode): Promise<ModuleRef> {
    const ModuleConstructor = node.module;
    this.logger.debug(
      `Resolve module ${ModuleConstructor.name}.`,
      ModuleLoader.name
    );

    const ref = new ModuleRef(this.logger, node, this.globalContainer);

    // Phase 2: imports are already built ModuleNodes (pure get). The graph is a DAG —
    // detectCycles() ran in phase 1 — so resolution never deadlocks on a memoized promise.
    const importedNodes = (node.imports ?? []).map((entry) =>
      this.getNode(entry)
    );

    // Imports resolved (built + initialized) in parallel: a slow sibling does not serialize
    // the others, but all are ready before we build this importer.
    const importedRefs = await Promise.all(
      importedNodes.map((importedNode) => this.resolveModule(importedNode))
    );

    for (const importedRef of importedRefs) {
      ref.imports.push(importedRef);

      // Single module: injectable by its class (e.g. to subscribe to its events). A `fresh` module
      // has multiple instances, so binding the class token would be ambiguous — it is reached only
      // through its exported tokens (delegation below).
      if (!importedRef.node.fresh) {
        ref.container.add({
          provide: importedRef.node.moduleKey,
          value: importedRef.instance,
        });
      }

      // Expose the import's exported providers to the importer's container (delegation).
      for (const token of importedRef.node.exports ?? []) {
        if (!ref.container.has(token)) {
          ref.container.add({
            provide: token,
            delegate: () => importedRef.resolve(token),
          });
        }
      }
    }

    for (const provider of node.providers ?? [])
      ref.container.add(normalizeProvider(provider));
    for (const exportToken of node.exports ?? []) ref.exports.add(exportToken);

    const args = (node.inject ?? []).map((token) => ref.resolve(token));
    ref.instance = new ModuleConstructor(...args);

    // Internal back-channel: stamp the module's own Container onto a hidden, non-enumerable slot
    // BEFORE onInit. This is NOT a public API and NOT part of the DI graph — it is the framework's
    // private way to let a *synthesized* module (e.g. the gateway feature module) resolve tokens it
    // can only discover at instance time (per-route guard classes living in controller fields).
    // The key is a `Symbol.for(...)` so a downstream package re-derives it without core exporting
    // anything; user code never sees it. See `OWN_CONTAINER_SLOT`.
    Object.defineProperty(ref.instance, OWN_CONTAINER_SLOT, {
      value: ref.container,
      enumerable: false,
      configurable: true,
    });

    if (hasOnInit(ref.instance)) {
      this.timer.start(node.identity);
      await ref.instance.onInit();
      const ms = this.timer.getTime(node.identity);
      this.logger.debug(
        `Module ${ModuleConstructor.name} init in ${ms} ms`,
        ModuleLoader.name
      );
    }

    // Final registry: fully resolved ref.
    this.resolvedModules.set(node.identity, ref);

    return ref;
  }
}
