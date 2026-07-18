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
  'https://router.example.test/router-prefix/'
)
const pathRequest = pathStore.create({ user: 'router-base-path' })
assert.equal(
  pathRequest.routerUrl,
  'https://router.example.test/router-prefix',
  'operator-configured Router base paths must be preserved'
)
assert.match(pathRequest.prompt, /npm install -g @over01470914\/hermes-hub-gateway@latest/)
assert.match(pathRequest.prompt, /hermes-hub-gateway pair --runtime hermes --router "https:\/\/router\.example\.test\/router-prefix"/)
assert.match(pathRequest.prompt, /Use the official CLI below\. Execute the install command, then run pair once/)
assert.match(pathRequest.prompt, /request native approval for that exact command/)
assert.match(pathRequest.prompt, /Gateway restart required — restart Hermes Gateway once from the Client/)
assert.match(pathRequest.prompt, /Never run `hermes gateway restart`/)
assert.match(pathRequest.prompt, /Expires at \(UTC\): \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/)
assert.doesNotMatch(pathRequest.prompt, /new uniquely named \.mjs helper/)
assert.doesNotMatch(pathRequest.prompt, /<verified-installer-path>|HERMES_COMMAND|HERMES_HUB_AGENT_APPROVAL_TOKEN/)
assert.doesNotMatch(pathRequest.prompt, /Host time zone|Pair window|hermes skills install|hermes-hub-gateway doctor|Allow normal host permissions|npx/)
assert.doesNotMatch(pathRequest.prompt, /winget install|requires Git for Windows|corepack pnpm|pnpm router:|hermes gateway stop/)
assert.doesNotMatch(pathRequest.prompt, /[A-Za-z]:\\|\/Users\/|\/home\//)
assert.doesNotMatch(pathRequest.prompt, /\/apps\/[^/\s]*server-router/)

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
