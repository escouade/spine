import { Injectable } from "@spinejs/core";
import { DispatchContext } from "./dispatch-store";

/**
 * A deep singleton with NO `ctx` parameter. It reads the current request's data straight from the
 * typed `DispatchContext`, so it sees the right user even though it is shared across all concurrent
 * requests.
 */
@Injectable({ inject: [DispatchContext] })
export class AuditService {
  constructor(private readonly dispatchContext: DispatchContext) {}

  currentUser(): string {
    return this.dispatchContext.get("user") ?? "anonymous";
  }

  currentReqId(): string {
    return this.dispatchContext.get("reqId") ?? "none";
  }
}
