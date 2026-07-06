// @spinejs/throttle/http — the HTTP preset (AD-1): the `'ip'` key source (socket address via
// `@hono/node-server`, `trustProxy` option, IPv4-mapped normalization before the IPv6 /56 mask) and
// the sole outcome→headers translator (draft-6 `RateLimit-*` + `Retry-After` through the AD-8
// response-headers bag). Optional peers: `@spinejs/http-gateway` + `@hono/node-server`.
// Content lands with Story 1.9.
export {};
