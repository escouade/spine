import { ZodError } from "zod";
import {
  ParseableSchema,
  ValidationError,
  Validator,
} from "@spinejs/gateway-core";

/**
 * zod-backed `Validator` adapter. Carries the zod dependency so the gateway core stays
 * dep-free. Normalizes a `ZodError` into the transport-agnostic `ValidationError` the
 * pipeline understands (mapped to `INVALID_INPUT` by the error mapper).
 */
export class ZodValidator implements Validator {
  validate<T>(schema: ParseableSchema<T>, input: unknown): T {
    try {
      return schema.parse(input);
    } catch (err) {
      if (err instanceof ZodError) {
        const detail = err.issues
          .map(
            (issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`
          )
          .join("; ");
        throw new ValidationError(detail);
      }
      throw err;
    }
  }
}
