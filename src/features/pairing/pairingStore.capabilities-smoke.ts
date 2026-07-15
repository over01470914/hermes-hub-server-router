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
assert.match(pathRequest.prompt, /Load the installed `hermes-hub-gateway-pairing` skill before taking any action/)
assert.match(pathRequest.prompt, /https:\/\/github\.com\/over01470914\/hermes-hub-gateway-plugin/)
assert.match(pathRequest.prompt, /hermes skills install "https:\/\/raw\.githubusercontent\.com\/over01470914\/hermes-hub-gateway-plugin\/main\/skills\/hermes-hub-gateway-pairing\/SKILL\.md" --yes/)
assert.match(pathRequest.prompt, /`scripts\/`, `references\/`, and `templates\/` beside `SKILL\.md`/)
assert.match(pathRequest.prompt, /loaded skill's `skill_dir`/)
assert.match(pathRequest.prompt, /NODE_USE_ENV_PROXY=1/)
assert.match(pathRequest.prompt, /HTTP_PROXY.*HTTPS_PROXY/)
assert.match(pathRequest.prompt, /node "<skill_dir>\/scripts\/pair\.mjs" --router "https:\/\/router\.example\.test\/router-dev"/)
assert.match(pathRequest.prompt, /Do not generate, write, copy, or modify a helper script/)
assert.match(pathRequest.prompt, /Do not add a retry, alternate URL, or pairing mutation/)
assert.match(pathRequest.prompt, /normal-permission terminal invocation/)
assert.doesNotMatch(
  pathRequest.prompt,
  /raw\.githubusercontent\.com\/(?!over01470914\/hermes-hub-gateway-plugin\/main\/skills\/hermes-hub-gateway-pairing\/SKILL\.md)/,
)
assert.doesNotMatch(pathRequest.prompt, /new uniquely named \.mjs helper/)
assert.doesNotMatch(pathRequest.prompt, /<verified-installer-path>|HERMES_COMMAND|HERMES_HUB_AGENT_APPROVAL_TOKEN/)
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
