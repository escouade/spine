import { Controller } from "@spinejs/gateway-core";
import { handle } from "@spinejs/electron-ipc-gateway";
import { AuditService } from "./audit.service";

/** Shape returned by the `whoami` handler. */
export interface WhoAmIResult {
  user: string;
  reqId: string;
}

/**
 * A singleton controller that never touches `ctx` for identity. It delegates to the singleton
 * `AuditService`, which reads the per-request user from CLS. The `await` forces interleaving so the
 * test exercises concurrent scopes.
 */
@Controller({ inject: [AuditService] })
export class WhoAmIController {
  constructor(private readonly audit: AuditService) {}

  whoami = handle("whoami", {}, async (): Promise<WhoAmIResult> => {
    await new Promise((r) => setTimeout(r, 5));
    return { user: this.audit.currentUser(), reqId: this.audit.currentReqId() };
  });
}
