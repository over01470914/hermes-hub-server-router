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

const defaultChatCapabilities = [
  'sessions:list',
  'messages:read',
  'chat:run',
  ...featureCapabilities
]

function createStore(): InMemoryPairingStore {
  return new InMemoryPairingStore(
    'pairing-capability-smoke-secret',
    'https://router.example.test'
  )
}

function assertFeatureDefaultEnabled(capabilities: string[]): void {
  for (const capability of featureCapabilities) {
    assert.equal(
      capabilities.includes(capability),
      true,
      `missing new-pairing feature grant: ${capability}`
    )
  }
}

const missingStore = createStore()
const missing = missingStore.create({ user: 'missing-capabilities' })
assert.deepEqual(
  missing.capabilities,
  defaultChatCapabilities,
  'all currently supported chat capabilities are granted by default'
)
assertFeatureDefaultEnabled(missing.capabilities)

const emptyStore = createStore()
const empty = emptyStore.create({
  user: 'empty-capabilities',
  capabilities: []
})
assert.deepEqual(empty.capabilities, defaultChatCapabilities)
assertFeatureDefaultEnabled(empty.capabilities)

const previousGrantStore = createStore()
const previousGrantSet = previousGrantStore.create({
  user: 'previous-grant-set',
  capabilities: ['sessions:list', 'messages:read', 'chat:run']
})
assert.deepEqual(
  previousGrantSet.capabilities,
  ['sessions:list', 'messages:read', 'chat:run'],
  'an explicit previous grant set must not be silently expanded'
)

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
assert.match(pathRequest.prompt, /^請完成 Hermes Hub Gateway 配對。/)
assert.match(pathRequest.prompt, /載入 `hermes-hub-gateway-pairing` skill/)
assert.match(pathRequest.prompt, /確認已安裝最新版 `@over01470914\/hermes-hub-gateway`/)
assert.match(pathRequest.prompt, /需要批准任何操作時直接向我提出請求/)
assert.match(pathRequest.prompt, /Router URL: `https:\/\/router\.example\.test\/router-prefix`/)
assert.match(pathRequest.prompt, new RegExp(`Request ID: \`${pathRequest.requestId}\``))
assert.match(pathRequest.prompt, /Enrollment ticket: `enr_[a-f0-9]{32}\.[A-Za-z0-9_-]{43}`/)
assert.doesNotMatch(pathRequest.prompt, /不要重試|僅執行一次|FAILED step|PAIRING_DIAGNOSIS|command -v|npm list -g|npm view|npm install -g/)
assert.doesNotMatch(pathRequest.prompt, /Expires at \(UTC\):|Capabilities:/)
assert.doesNotMatch(pathRequest.prompt, /new uniquely named \.mjs helper/)
assert.doesNotMatch(pathRequest.prompt, /<verified-installer-path>|HERMES_COMMAND|HERMES_HUB_AGENT_APPROVAL_TOKEN/)
assert.doesNotMatch(pathRequest.prompt, /hermes skills install|hermes-hub-gateway doctor|winget install|requires Git for Windows|corepack pnpm|pnpm router:|hermes gateway stop/)
assert.doesNotMatch(pathRequest.prompt, /[A-Za-z]:\\|\/Users\/|\/home\//)
assert.doesNotMatch(pathRequest.prompt, /\/apps\/[^/\s]*server-router/)

const traditionalPrompt = pathStore.create({
  user: 'traditional-prompt',
  client: { appName: 'Hermes Hub', locale: 'traditionalChinese' },
}).prompt
assert.match(traditionalPrompt, /請完成 Hermes Hub Gateway 配對/)
assert.match(traditionalPrompt, /必要參數：/)

const simplifiedPrompt = pathStore.create({
  user: 'simplified-prompt',
  client: { appName: 'Hermes Hub', locale: 'zh-CN' },
}).prompt
assert.match(simplifiedPrompt, /請完成 Hermes Hub Gateway 配對/)
assert.match(simplifiedPrompt, /必要參數：/)

const fallbackPrompt = pathStore.create({
  user: 'fallback-prompt',
  client: { appName: 'Hermes Hub', locale: 'unsupported-locale' },
}).prompt
assert.match(fallbackPrompt, /請完成 Hermes Hub Gateway 配對/)

console.log(JSON.stringify({
  ok: true,
  checks: [
    'new pairing requests default to all Cron and Kanban grants',
    'empty capability requests receive the current default grants',
    'explicit previous grant sets are not silently expanded',
    'explicit feature grants are preserved and deduplicated',
    'pairing claims preserve only requested grants',
    'Router base paths are preserved without trusting Client input',
    'pairing prompts provide only the task, approval handoff, and request parameters'
  ]
}, null, 2))
