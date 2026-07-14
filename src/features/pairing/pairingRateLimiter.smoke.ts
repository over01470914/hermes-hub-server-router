import assert from 'node:assert/strict'

import { PairingRateLimitError, PairingRateLimiter } from './pairingRateLimiter.js'

let now = 1_000
const limiter = new PairingRateLimiter(() => now, 2)
const rule = { maxAttempts: 2, windowMs: 10_000 }

limiter.assertAllowed('claim', 'client-a', rule)
limiter.assertAllowed('claim', 'client-a', rule)
assert.throws(
  () => limiter.assertAllowed('claim', 'client-a', rule),
  (error: unknown) => error instanceof PairingRateLimitError && error.statusCode === 429 && error.retryAfterSeconds === 10,
)
limiter.assertAllowed('claim', 'client-b', rule)
assert.throws(
  () => limiter.assertAllowed('claim', 'client-c', rule),
  (error: unknown) => error instanceof PairingRateLimitError,
  'tracked keys must remain bounded instead of evicting an active limiter bucket',
)

now = 11_001
limiter.assertAllowed('claim', 'client-c', rule)
limiter.assertAllowed('request', 'client-c', rule)

const globalLimiter = new PairingRateLimiter(() => now, 16)
const sourceRule = { maxAttempts: 10, windowMs: 30_000 }
const globalRule = { maxAttempts: 2, windowMs: 30_000 }
for (const source of ['client-a', 'client-b']) {
  globalLimiter.assertAllowed('request:source', source, sourceRule)
  globalLimiter.assertAllowed('request:global', 'router', globalRule)
}
globalLimiter.assertAllowed('request:source', 'client-c', sourceRule)
assert.throws(
  () => globalLimiter.assertAllowed('request:global', 'router', globalRule),
  (error: unknown) => error instanceof PairingRateLimitError && error.retryAfterSeconds === 30,
  'distinct sources must still share one bounded global allowance',
)

console.log(JSON.stringify({
  ok: true,
  checks: [
    'pairing attempts are bounded per source and window',
    'rate-limit errors carry retry metadata',
    'limiter state has a hard key bound',
    'expired buckets are pruned before admitting new sources',
    'distinct sources share the global Router allowance',
  ],
}, null, 2))
