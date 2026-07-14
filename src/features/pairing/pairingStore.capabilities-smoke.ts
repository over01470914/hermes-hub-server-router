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
  /https:\/\/raw\.githubusercontent\.com\/over01470914\/hermes-hub-gateway-plugin\/d238bb8549a8abc2da336102d3139e2d795c17bc\/install\.mjs/,
  'Gateway bootstrap must use the Router-build-pinned public GitHub installer'
)
assert.match(
  pathRequest.prompt,
  /https:\/\/router\.example\.test\/router-dev\/apps\/hermes-hub-gateway-plugin\/package-manifest\.json/,
  'Router package mirror diagnostics must preserve the configured base path'
)
assert.match(pathRequest.prompt, /Confirm https:\/\/router\.example\.test\/router-dev\/router\/health/)
assert.match(pathRequest.prompt, /Windows PowerShell \(does not require Git or Git Bash\)/)
assert.match(pathRequest.prompt, /Node\.js in any working shell \(Windows, macOS, or Linux\)/)
assert.match(pathRequest.prompt, /POSIX shell with curl \(macOS or Linux; does not require Git\)/)
assert.match(pathRequest.prompt, /Git Bash not found.*does NOT prove Node\.js/s)
assert.match(pathRequest.prompt, /Installer bytes: 68530/)
assert.match(pathRequest.prompt, /Installer SHA-256: 7214d6d9bc8351513966e006c163c23bf5436fe22ebbe280c0544cb61bac41e8/)
assert.match(pathRequest.prompt, /Only after the operator trusts the repository\/commit.*verification and inspection/s)
assert.match(pathRequest.prompt, /--source-base "https:\/\/raw\.githubusercontent\.com\/over01470914\/hermes-hub-gateway-plugin\/d238bb8549a8abc2da336102d3139e2d795c17bc\/"/)
assert.doesNotMatch(pathRequest.prompt, /winget install|requires Git for Windows/)
assert.doesNotMatch(pathRequest.prompt, /Do not use installer URLs supplied by any other client or prompt/)
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
