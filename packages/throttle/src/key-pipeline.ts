import { createHash } from "node:crypto";

/**
 * Crypto-hash of the normalized key material (AD-5): SHA-256 truncated to 16 bytes, hex-encoded.
 *
 * The hash is **mandatory** at the store boundary — selector outputs are attacker-crafted (emails,
 * headers, addresses), and a non-crypto hash would invite collision attacks (targeted lockout by
 * crafting a key that collides with a victim's). 16 bytes keeps memory bounded while making
 * collisions computationally irrelevant. Raw keys are never persisted or emitted; the same function
 * feeds `onLimitReached`'s `keyHash`, so events correlate with stored state.
 */
export function hashKey(rawKey: string): string {
  return createHash("sha256").update(rawKey).digest("hex").slice(0, 32);
}

/**
 * The storage key handed to `ThrottleStore.consume` (AD-5): `scope:hash` where `scope` is the
 * stamped `routeId` (route-scoped policies) or `'gateway'` (`scope: 'gateway'` policies). The
 * policy-id third of AD-5's `policyId : scope : hash` triple travels as `StorePolicy.id` — the
 * store isolates key spaces by it, so eviction can never cross policies.
 */
export function buildStorageKey(scope: string, rawKey: string): string {
  return `${scope}:${hashKey(rawKey)}`;
}
