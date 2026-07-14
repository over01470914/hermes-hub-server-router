import assert from 'node:assert/strict'

import {
  InMemoryPairingStore,
  MAX_LIVE_PAIRING_REQUESTS,
  PAIRING_RECORD_SCHEMA_VERSION,
  PairingCapacityError,
  type PairingRequestRecord,
} from './pairingStore.js'

function record(
  requestId: string,
  expiresAt: number,
  overrides: Partial<PairingRequestRecord> = {},
): PairingRequestRecord {
  return {
    schemaVersion: PAIRING_RECORD_SCHEMA_VERSION,
    requestId,
    user: 'smoke-user',
    deviceName: 'smoke-device',
    deviceId: `device_${requestId}`,
    deviceNonce: `nonce_${requestId}`,
    devicePublicKey: `public_${requestId}`,
    routerUrl: 'https://router.example',
    capabilities: ['sessions:list', 'messages:read', 'chat:run'],
    createdAt: 100,
    expiresAt,
    ...overrides,
  }
}

let now = 1_000
let persisted: PairingRequestRecord[] = []
const revoked = record('pair_revoked_tombstone', 900, {
  approvedAt: 200,
  hermesAgentId: 'agent_revoked',
  gatewayId: 'gw_revoked',
  gatewayTokenHash: 'revoked-token-hash',
  gatewayCredentialState: 'revoked',
  gatewayCredentialRevokedAt: 300,
})
const active = record('pair_active_credential', 900, {
  approvedAt: 200,
  claimedAt: 250,
  hermesAgentId: 'agent_active',
  gatewayId: 'gw_active',
  gatewayTokenHash: 'active-token-hash',
  gatewayCredentialState: 'active',
  gatewayCredentialActivatedAt: 250,
})
const pruningStore = new InMemoryPairingStore(
  'capacity-smoke-secret',
  'https://router.example',
  () => now,
  [
    record('pair_expired_pending', 900),
    record('pair_expired_provisional', 900, {
      approvedAt: 200,
      hermesAgentId: 'agent_provisional',
      gatewayId: 'gw_provisional',
      gatewayTokenHash: 'provisional-token-hash',
      gatewayCredentialState: 'provisional',
    }),
    revoked,
    active,
  ],
  records => { persisted = records },
)

const replacement = pruningStore.create({ deviceId: 'device_replacement' })
assert.ok(replacement.requestId.startsWith('pair_'))
assert.equal(persisted.some(item => item.requestId === 'pair_expired_pending'), false)
assert.equal(persisted.some(item => item.requestId === 'pair_expired_provisional'), false)
assert.equal(persisted.some(item => item.requestId === revoked.requestId), true, 'revoked tombstones must survive pruning')
assert.equal(persisted.some(item => item.requestId === active.requestId), true, 'active credentials must survive pruning')

const liveRecords = Array.from(
  { length: MAX_LIVE_PAIRING_REQUESTS },
  (_, index) => record(`pair_live_${index}`, now + 600),
)
let capacityPersisted: PairingRequestRecord[] = []
const capacityStore = new InMemoryPairingStore(
  'capacity-smoke-secret',
  'https://router.example',
  () => now,
  liveRecords,
  records => { capacityPersisted = records },
)
assert.throws(
  () => capacityStore.create({ deviceId: 'device_over_capacity' }),
  (error: unknown) => (
    error instanceof PairingCapacityError &&
    error.statusCode === 503 &&
    error.code === 'pairing_capacity_reached' &&
    error.retryAfterSeconds === 600
  ),
)
assert.equal(capacityPersisted.length, 0, 'a full live store must not be rewritten or partially mutated')

now += 601
const afterExpiry = capacityStore.create({ deviceId: 'device_after_expiry' })
assert.ok(afterExpiry.requestId.startsWith('pair_'))
assert.equal(capacityPersisted.length, 1, 'expired pending requests must be pruned before admitting a replacement')

const expiredForRollback = record('pair_expired_rollback', now - 1)
const failingStore = new InMemoryPairingStore(
  'capacity-smoke-secret',
  'https://router.example',
  () => now,
  [expiredForRollback],
  () => { throw new Error('simulated persistence failure') },
)
assert.throws(() => failingStore.create({ deviceId: 'device_failed_write' }), /simulated persistence failure/)
assert.equal(
  failingStore.get(expiredForRollback.requestId)?.status,
  'expired',
  'failed persistence must restore the complete pre-prune snapshot',
)

console.log(JSON.stringify({
  ok: true,
  checks: [
    'expired pending and provisional requests are pruned before create',
    'revoked tombstones and active credentials are never pruned',
    `live pending requests are capped at ${MAX_LIVE_PAIRING_REQUESTS}`,
    'persistence failures roll back pruning and insertion together',
  ],
}, null, 2))
