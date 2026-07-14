import assert from 'node:assert/strict'

import { InMemoryPairingStore } from './pairingStore.js'

const featureCapabilities = [
  'cron:read',
  'cron:write',
  'cron:execute',
  'kanban:read',
  'kanban:write',
  'kanban:execute'
]

function createStore(): InMemoryPairingStore {
  return new InMemoryPairingStore(
    'pairing-capability-smoke-secret',
    'https://router.example.test'
  )
}

function assertFeatureDefaultDeny(capabilities: string[]): void {
  for (const capability of featureCapabilities) {
    assert.equal(
      capabilities.includes(capability),
      false,
      `unexpected implicit feature grant: ${capability}`
    )
  }
}

const missingStore = createStore()
const missing = missingStore.create({ user: 'missing-capabilities' })
assertFeatureDefaultDeny(missing.capabilities)

const emptyStore = createStore()
const empty = emptyStore.create({
  user: 'empty-capabilities',
  capabilities: []
})
assertFeatureDefaultDeny(empty.capabilities)

const explicitStore = createStore()
const explicit = explicitStore.create({
  user: 'explicit-capabilities',
  capabilities: [
    'sessions:list',
    ...featureCapabilities,
    'cron:read'
  ]
})
assert.deepEqual(
  explicit.capabilities,
  ['sessions:list', ...featureCapabilities],
  'explicit feature grants should be preserved and deduplicated'
)

const approval = explicitStore.approve(explicit.requestId, () => '12345678')
const claim = explicitStore.claim(explicit.requestId, approval.randomCode)
assert.deepEqual(
  claim.capabilities,
  explicit.capabilities,
  'only the requested capabilities should reach the signed claim input'
)

const pathStore = new InMemoryPairingStore(
  'pairing-base-path-smoke-secret',
  'https://router.example.test/router-dev/'
)
const pathRequest = pathStore.create({ user: 'router-base-path' })
assert.equal(
  pathRequest.routerUrl,
  'https://router.example.test/router-dev',
  'operator-configured Router base paths must be preserved'
)
assert.match(
  pathRequest.prompt,
  /https:\/\/raw\.githubusercontent\.com\/over01470914\/hermes-hub-gateway-plugin\/4c0c31e0e99218c189ba96055ccacb700dceb0b6\/install\.mjs/,
  'Gateway bootstrap must use the Router-build-pinned public GitHub installer'
)
assert.match(pathRequest.prompt, /GET https:\/\/router\.example\.test\/router-dev\/router\/health/)
assert.match(pathRequest.prompt, /Never guess or hard-code a username, drive, home, checkout/)
assert.match(pathRequest.prompt, /HERMES_COMMAND/)
assert.match(pathRequest.prompt, /with `--version` and `config path`/)
assert.match(pathRequest.prompt, /one new uniquely named \.mjs helper/)
assert.match(pathRequest.prompt, /do not alter an existing file, use `node -e`/)
assert.match(pathRequest.prompt, /node "<verified-installer-path>"/)
assert.match(pathRequest.prompt, /shell disabled, and the unchanged inherited environment/)
assert.match(pathRequest.prompt, /Do not call POST \/router\/pairing\/approve/)
assert.match(pathRequest.prompt, /401, 409, 502, or another 5xx/)
assert.match(pathRequest.prompt, /Do not probe, retry, or call an alternative endpoint/)
assert.match(pathRequest.prompt, /Installer bytes: 68536/)
assert.match(pathRequest.prompt, /Installer SHA-256: c2aabfe14445bff7178fed4904f6361f84114b435e352002d068d5a0afaccbc2/)
assert.match(pathRequest.prompt, /Verify the raw file has the exact byte count and lowercase SHA-256/)
assert.match(pathRequest.prompt, /--source-base "https:\/\/raw\.githubusercontent\.com\/over01470914\/hermes-hub-gateway-plugin\/4c0c31e0e99218c189ba96055ccacb700dceb0b6\/"/)
assert.doesNotMatch(pathRequest.prompt, /winget install|requires Git for Windows|corepack pnpm|pnpm router:|hermes gateway stop/)
assert.doesNotMatch(pathRequest.prompt, /[A-Za-z]:\\|\/Users\/|\/home\//)
assert.doesNotMatch(pathRequest.prompt, /\/apps\/server-router/)

console.log(JSON.stringify({
  ok: true,
  checks: [
    'missing capabilities keep agent features denied',
    'empty capabilities keep agent features denied',
    'explicit feature grants are preserved and deduplicated',
    'pairing claims preserve only requested grants',
    'Router base paths are preserved without trusting Client input'
  ]
}, null, 2))
