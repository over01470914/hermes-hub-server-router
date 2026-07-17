import assert from 'node:assert/strict'

import { issueBridgeToken, readBridgeConfig, verifyBridgeToken } from './bridgeAuth.js'

const baseEnvironment = {
  NODE_ENV: 'production',
  HERMES_HUB_PAIRING_CODE: 'bridge-auth-smoke-pairing-code',
  HERMES_HUB_BRIDGE_SECRET: 'bridge-auth-smoke-secret',
}

const input = {
  pairingCode: baseEnvironment.HERMES_HUB_PAIRING_CODE,
  user: 'bridge-auth-smoke-user',
  deviceId: 'bridge-auth-smoke-device',
  hermesAgentId: 'bridge-auth-smoke-agent',
}

const permanentConfig = readBridgeConfig(baseEnvironment)
assert.equal(permanentConfig.tokenTtlSeconds, 0, 'the default token TTL must be non-expiring')
const permanentToken = issueBridgeToken(input, permanentConfig, 1_000, 'bridge_auth_permanent')
assert.equal(
  verifyBridgeToken(permanentToken, permanentConfig, 9_999_999).exp,
  0,
  'a default bridge token must remain valid without an expiry',
)

const expiringConfig = readBridgeConfig({
  ...baseEnvironment,
  HERMES_HUB_TOKEN_TTL_SECONDS: '60',
})
const expiringToken = issueBridgeToken(input, expiringConfig, 1_000, 'bridge_auth_expiring')
assert.equal(verifyBridgeToken(expiringToken, expiringConfig, 1_060).exp, 1_060)
assert.throws(
  () => verifyBridgeToken(expiringToken, expiringConfig, 1_061),
  /Token expired/,
  'an operator-specified positive TTL must remain enforced',
)

console.log(JSON.stringify({
  ok: true,
  checks: [
    'default bridge tokens do not expire',
    'configured positive bridge token TTLs still expire',
  ],
}, null, 2))
