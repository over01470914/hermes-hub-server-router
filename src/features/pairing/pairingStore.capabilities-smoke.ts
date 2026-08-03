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
assert.match(pathRequest.prompt, /ask the user through the approval request and wait/)
assert.doesNotMatch(pathRequest.prompt, /return `NEEDS_APPROVAL:/)
assert.match(pathRequest.prompt, /3\. Load the `hermes-hub-gateway-pairing` skill/)
assert.match(pathRequest.prompt, /4\. If the Router URL has an `@url:` or backtick display wrapper/)
assert.match(pathRequest.prompt, /5\. Then run exactly once:/)
assert.match(pathRequest.prompt, /6\. On success, return the 8-digit code/)
assert.match(pathRequest.prompt, /references\/failure-points\.md/)
assert.match(pathRequest.prompt, /PAIRING_DIAGNOSIS \[problem_key\] layer=<layer> disposition=<disposition>/)
assert.match(pathRequest.prompt, /Stop and wait for a fresh Client pairing request/)
assert.match(pathRequest.prompt, /Do not display the enrollment ticket, Gateway credential, or other secrets/)
assert.ok(pathRequest.prompt.split('\n').length <= 11, 'English pairing prompt stays concise')
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
assert.match(traditionalPrompt, /直接向使用者提出 approval 請求並等待/)
assert.doesNotMatch(traditionalPrompt, /回傳 `NEEDS_APPROVAL:/)
assert.match(traditionalPrompt, /command -v hermes-hub-gateway/)
assert.match(traditionalPrompt, /export PATH="\$\(npm prefix -g\)\/bin:\$PATH"/)
assert.match(traditionalPrompt, /5\. 接著只執行一次：/)
assert.match(traditionalPrompt, /只保留內層 URL/)
assert.match(traditionalPrompt, /成功就回傳 8 位配對碼/)
assert.match(traditionalPrompt, /hermes-hub-gateway pair --runtime hermes/)
assert.match(traditionalPrompt, /references\/failure-points\.md/)
assert.match(traditionalPrompt, /PAIRING_DIAGNOSIS \[problem_key\]/)
assert.match(traditionalPrompt, /等 Client 建立新的 pairing request/)
assert.ok(traditionalPrompt.split('\n').length <= 11, 'Traditional Chinese pairing prompt stays concise')

const simplifiedPrompt = pathStore.create({
  user: 'simplified-prompt',
  client: { appName: 'Hermes Hub', locale: 'zh-CN' },
}).prompt
assert.match(simplifiedPrompt, /直接向用户提出 approval 请求并等待/)
assert.doesNotMatch(simplifiedPrompt, /返回 `NEEDS_APPROVAL:/)
assert.match(simplifiedPrompt, /command -v hermes-hub-gateway/)
assert.match(simplifiedPrompt, /export PATH="\$\(npm prefix -g\)\/bin:\$PATH"/)
assert.match(simplifiedPrompt, /5\. 接着只执行一次：/)
assert.match(simplifiedPrompt, /只保留内层 URL/)
assert.match(simplifiedPrompt, /成功就返回 8 位配对码/)
assert.match(simplifiedPrompt, /hermes-hub-gateway pair --runtime hermes/)
assert.match(simplifiedPrompt, /references\/failure-points\.md/)
assert.match(simplifiedPrompt, /PAIRING_DIAGNOSIS \[problem_key\]/)
assert.match(simplifiedPrompt, /等待 Client 创建新的 pairing request/)
assert.ok(simplifiedPrompt.split('\n').length <= 11, 'Simplified Chinese pairing prompt stays concise')

const fallbackPrompt = pathStore.create({
  user: 'fallback-prompt',
  client: { appName: 'Hermes Hub', locale: 'unsupported-locale' },
}).prompt
assert.match(fallbackPrompt, /Hermes Hub Gateway pairing/)

console.log(JSON.stringify({
  ok: true,
  checks: [
    'new pairing requests default to all Cron and Kanban grants',
    'empty capability requests receive the current default grants',
    'explicit previous grant sets are not silently expanded',
    'explicit feature grants are preserved and deduplicated',
    'pairing claims preserve only requested grants',
    'Router base paths are preserved without trusting Client input',
    'pairing prompts follow the Client locale with an English fallback'
  ]
}, null, 2))
