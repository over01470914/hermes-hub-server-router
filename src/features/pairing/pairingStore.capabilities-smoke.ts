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
assert.match(pathRequest.prompt, /npm install -g @over01470914\/hermes-hub-gateway@latest/)
assert.match(pathRequest.prompt, /npm list -g @over01470914\/hermes-hub-gateway --depth=0 --json/)
assert.match(pathRequest.prompt, /npm view @over01470914\/hermes-hub-gateway@latest version --json/)
assert.match(pathRequest.prompt, /hermes-hub-gateway pair --runtime hermes --router "https:\/\/router\.example\.test\/router-prefix"/)
assert.match(pathRequest.prompt, /command -v hermes-hub-gateway/)
assert.match(pathRequest.prompt, /export PATH="\$\(npm prefix -g\)\/bin:\$PATH"/)
assert.match(pathRequest.prompt, /FAILED step PATH: hermes-hub-gateway is not on PATH/)
assert.doesNotMatch(pathRequest.prompt, /1\.1\.0/)
assert.match(pathRequest.prompt, /^執行 Hermes Hub Gateway 配對；全程依序進行，不要重試 pairing。/)
assert.match(pathRequest.prompt, /1\. 載入 `hermes-hub-gateway-operations` skill。/)
assert.match(pathRequest.prompt, /3\. 若未安裝或版本不同，先向我請求批准執行：/)
assert.match(pathRequest.prompt, /5\. Router 只接受純 HTTPS origin；移除 `@url:`、反引號或其他包裝。/)
assert.match(pathRequest.prompt, /6\. 僅執行一次：/)
assert.match(pathRequest.prompt, /成功：只回傳 8 位配對碼/)
assert.match(pathRequest.prompt, /hermes-hub-gateway-operations\/references\/failure-points\.md/)
assert.match(pathRequest.prompt, /PAIRING_DIAGNOSIS \[problem_key\] layer=<layer> disposition=<disposition>/)
assert.match(pathRequest.prompt, /失敗後停止，等待新的 pairing request；不要重試、不要顯示 ticket、credential 或任何 secret/)
assert.doesNotMatch(pathRequest.prompt, /--router "@url:/)
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
assert.match(traditionalPrompt, /執行 Hermes Hub Gateway 配對/)
assert.match(traditionalPrompt, /command -v hermes-hub-gateway/)
assert.match(traditionalPrompt, /export PATH="\$\(npm prefix -g\)\/bin:\$PATH"/)
assert.match(traditionalPrompt, /6\. 僅執行一次：/)
assert.match(traditionalPrompt, /成功：只回傳 8 位配對碼/)
assert.match(traditionalPrompt, /hermes-hub-gateway pair --runtime hermes/)
assert.match(traditionalPrompt, /hermes-hub-gateway-operations\/references\/failure-points\.md/)
assert.match(traditionalPrompt, /PAIRING_DIAGNOSIS \[problem_key\]/)

const simplifiedPrompt = pathStore.create({
  user: 'simplified-prompt',
  client: { appName: 'Hermes Hub', locale: 'zh-CN' },
}).prompt
assert.match(simplifiedPrompt, /執行 Hermes Hub Gateway 配對/)
assert.match(simplifiedPrompt, /command -v hermes-hub-gateway/)
assert.match(simplifiedPrompt, /export PATH="\$\(npm prefix -g\)\/bin:\$PATH"/)
assert.match(simplifiedPrompt, /6\. 僅執行一次：/)
assert.match(simplifiedPrompt, /成功：只回傳 8 位配對碼/)
assert.match(simplifiedPrompt, /hermes-hub-gateway pair --runtime hermes/)
assert.match(simplifiedPrompt, /hermes-hub-gateway-operations\/references\/failure-points\.md/)
assert.match(simplifiedPrompt, /PAIRING_DIAGNOSIS \[problem_key\]/)

const fallbackPrompt = pathStore.create({
  user: 'fallback-prompt',
  client: { appName: 'Hermes Hub', locale: 'unsupported-locale' },
}).prompt
assert.match(fallbackPrompt, /執行 Hermes Hub Gateway 配對/)

console.log(JSON.stringify({
  ok: true,
  checks: [
    'new pairing requests default to all Cron and Kanban grants',
    'empty capability requests receive the current default grants',
    'explicit previous grant sets are not silently expanded',
    'explicit feature grants are preserved and deduplicated',
    'pairing claims preserve only requested grants',
    'Router base paths are preserved without trusting Client input',
    'pairing prompts use the fixed operator-provided Traditional Chinese flow'
  ]
}, null, 2))
