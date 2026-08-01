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
  'chat:run'
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
assert.deepEqual(
  missing.capabilities,
  defaultChatCapabilities,
  'all currently supported chat capabilities are granted by default'
)
assertFeatureDefaultDeny(missing.capabilities)

const emptyStore = createStore()
const empty = emptyStore.create({
  user: 'empty-capabilities',
  capabilities: []
})
assert.deepEqual(empty.capabilities, defaultChatCapabilities)
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
assert.match(pathRequest.prompt, /First check whether `hermes-hub-gateway` is available/)
assert.match(pathRequest.prompt, /request native Hermes approval/)
assert.match(pathRequest.prompt, /NEEDS_APPROVAL: npm install -g/)
assert.match(pathRequest.prompt, /pairing command exactly once/)
assert.match(pathRequest.prompt, /reuses a healthy Gateway/)
assert.match(pathRequest.prompt, /Version or manifest-SHA differences do not block pairing/)
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
assert.match(traditionalPrompt, /請求 Hermes 原生授權並等待使用者批准/)
assert.match(traditionalPrompt, /NEEDS_APPROVAL: npm install -g/)
assert.match(traditionalPrompt, /只執行一次以下配對命令/)
assert.match(traditionalPrompt, /成功時只回傳 CLI 輸出的 8 位配對碼/)
assert.match(traditionalPrompt, /hermes-hub-gateway pair --runtime hermes/)

const simplifiedPrompt = pathStore.create({
  user: 'simplified-prompt',
  client: { appName: 'Hermes Hub', locale: 'zh-CN' },
}).prompt
assert.match(simplifiedPrompt, /请求 Hermes 原生授权并等待用户批准/)
assert.match(simplifiedPrompt, /NEEDS_APPROVAL: npm install -g/)
assert.match(simplifiedPrompt, /只执行一次以下配对命令/)
assert.match(simplifiedPrompt, /成功时只返回 CLI 输出的 8 位配对码/)
assert.match(simplifiedPrompt, /hermes-hub-gateway pair --runtime hermes/)

const fallbackPrompt = pathStore.create({
  user: 'fallback-prompt',
  client: { appName: 'Hermes Hub', locale: 'unsupported-locale' },
}).prompt
assert.match(fallbackPrompt, /Hermes Hub Gateway pairing/)

console.log(JSON.stringify({
  ok: true,
  checks: [
    'missing capabilities keep agent features denied',
    'empty capabilities keep agent features denied',
    'explicit feature grants are preserved and deduplicated',
    'pairing claims preserve only requested grants',
    'Router base paths are preserved without trusting Client input',
    'pairing prompts follow the Client locale with an English fallback'
  ]
}, null, 2))
