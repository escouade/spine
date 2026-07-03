import { Module } from "@spinejs/core";
import { ClsService } from "./cls.service";

/**
 * Provides `ClsService` as a shared singleton and exports it. Import it once in the module graph;
 * any module that imports it can then inject `ClsService`. Opening a scope per request is the
 * caller's job (e.g. a gateway interceptor calling `cls.run()`), which keeps this module
 * transport-agnostic — it knows nothing about gateways, HTTP, or "requests".
 */
@Module({
  providers: [ClsService],
  exports: [ClsService],
})
export class ClsModule {}
