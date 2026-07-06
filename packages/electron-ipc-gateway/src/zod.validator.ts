import { ZodError } from "zod";
import { $ZodError } from "zod/v4/core";
import {
  ParseableSchema,
  ValidationError,
  Validator,
} from "@spinejs/gateway-core";

/**
 * zod-backed `Validator` adapter. Carries the zod dependency so the gateway core stays
 * dep-free. Normalizes a zod error into the transport-agnostic `ValidationError` the
 * pipeline understands (mapped to `INVALID_INPUT` by the error mapper).
 *
 * Catches both surfaces shipped by zod 3.25+: classic v3 (`ZodError`) and `zod/v4`
 * (`$ZodError`). The v4 check matches by trait (`Symbol.hasInstance` on `$ZodError`),
 * so it also catches errors thrown by a duplicate zod v4 copy in the consumer's tree.
 */
export class ZodValidator implements Validator {
  validate<T>(schema: ParseableSchema<T>, input: unknown): T {
    try {
      return schema.parse(input);
    } catch (err) {
      if (err instanceof ZodError || err instanceof $ZodError) {
        const detail = err.issues
          .map(
            (issue) =>
              `${issue.path.map(String).join(".") || "(root)"}: ${
                issue.message
              }`
          )
          .join("; ");
        throw new ValidationError(detail);
      }
      throw err;
    }
  }
}
