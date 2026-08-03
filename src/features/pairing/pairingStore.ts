
import { createHmac, randomInt, randomUUID, timingSafeEqual } from 'node:crypto'

export interface PairingRequestInput {
  user?: unknown
  deviceName?: unknown
  deviceId?: unknown
  deviceNonce?: unknown
  devicePublicKey?: unknown
  routerUrl?: unknown
  capabilities?: unknown
  client?: unknown
  ttlSeconds?: unknown
  replaceRequestId?: unknown
  replaceToken?: unknown
}

export interface PairingClientMetadata {
  appName: string
  appVersion?: string
  platform?: string
  locale?: string
  userAgent?: string
}

export interface PairingRequestRecord {
  schemaVersion: typeof PAIRING_RECORD_SCHEMA_VERSION
  requestId: string
  user: string
  deviceName: string
  deviceId: string
  deviceNonce: string
  devicePublicKey: string
  routerUrl: string
  capabilities: string[]
  client?: PairingClientMetadata
  createdAt: number
  expiresAt: number
  enrollmentNonce?: string
  replacementTokenHash?: string
  enrollmentConsumedAt?: number
  approvedAt?: number
  claimedAt?: number
  codeHash?: string
  hermesAgentId?: string
  gatewayId?: string
  gatewayTokenHash?: string
  gatewayCredentialState?: GatewayCredentialState
  gatewayCredentialActivatedAt?: number
  gatewayCredentialRevokedAt?: number
}

export type GatewayCredentialState = 'provisional' | 'active' | 'revoked'

export interface PublicPairingRequest {
  requestId: string
  user: string
  deviceName: string
  deviceId: string
  hermesAgentId?: string
  routerUrl: string
  capabilities: string[]
  client?: PairingClientMetadata
  createdAt: number
  expiresAt: number
  status: 'pending' | 'approved' | 'claimed' | 'expired'
  prompt: string
  /** Returned only from request creation; never included in status reads or prompts. */
  replacementToken?: string
}

export interface PairingApproval {
  requestId: string
  randomCode: string
  expiresAt: number
  hermesAgentId: string
  gatewayId: string
  gatewayToken: string
  gatewayStreamPath: string
}

export interface PairingApprovalOptions {
  codeGenerator?: () => string
  hermesAgentId?: string
  gatewayId?: string
  gatewayToken?: string
  /** Internal one-shot enrollment path; never accepted from HTTP input. */
  consumeEnrollmentTicket?: boolean
}

export interface DebugGatewaySeed {
  requestId: string
  user: string
  deviceName: string
  hermesAgentId: string
  gatewayId: string
  gatewayToken: string
  pairingCode: string
  expiresAt: number
}

export interface PairingClaim {
  requestId: string
  user: string
  deviceName: string
  deviceId: string
  hermesAgentId: string
  gatewayId: string
  gatewayCredentialState: 'active'
  claimedAt: number
  bridgeTokenId: string
  recovered: boolean
  revokedGatewayIds: string[]
  credentialRotated: boolean
  capabilities: string[]
}

export type PairingClaimValidator = (claim: PairingClaim, gatewayId: string) => void

const defaultCapabilities = [
  'sessions:list',
  'messages:read',
  'chat:run',
  'cron:read',
  'cron:write',
  'cron:execute',
  'kanban:read',
  'kanban:write',
  'kanban:execute'
]

const allowedCapabilities = new Set([
  ...defaultCapabilities,
  'cron:read',
  'cron:write',
  'cron:execute',
  'kanban:read',
  'kanban:write',
  'kanban:execute',
])

export const PAIRING_RECORD_SCHEMA_VERSION = 'hermes-hub-pairing/v2' as const
export const MAX_LIVE_PAIRING_REQUESTS = 64

export class PairingCapacityError extends Error {
  constructor(readonly retryAfterSeconds: number) {
    super('Pairing request capacity reached; retry after an existing request expires')
    this.name = 'PairingCapacityError'
  }

  readonly statusCode = 503
  readonly code = 'pairing_capacity_reached'
}

export function generateEightDigitCode(): string {
  return randomInt(0, 100_000_000).toString().padStart(8, '0')
}

function cleanText(value: unknown, fallback: string, max = 120): string {
  const raw = typeof value === 'string' && value.trim() ? value : fallback
  const singleLine = raw
    .replace(/[\u0000-\u001f\u007f\u2028\u2029]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
  return (singleLine || fallback).slice(0, max)
}

function cleanCapabilities(value: unknown): string[] {
  if (!Array.isArray(value)) return defaultCapabilities
  const items = [...new Set(
    value
      .filter(item => typeof item === 'string')
      .map(item => item.trim())
      .filter(item => allowedCapabilities.has(item))
  )].slice(0, 12)
  return items.length > 0 ? items : defaultCapabilities
}

function authoritativeRouterUrl(value: string): string {
  const parsed = new URL(value.trim())
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('Router URL must be an HTTP(S) base URL without credentials, query, or fragment')
  }
  const loopback = ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(parsed.hostname.toLowerCase())
  if (parsed.protocol === 'http:' && !loopback) {
    throw new Error('A non-loopback Router URL must use HTTPS')
  }
  return parsed.toString().replace(/\/+$/, '')
}

function cleanClientMetadata(value: unknown): PairingClientMetadata | undefined {
  const record = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
  if (!record) return undefined
  const client: PairingClientMetadata = {
    appName: cleanText(record.appName ?? record.name, 'hermes-hub', 80)
  }
  const appVersion = cleanText(record.appVersion ?? record.version, '', 60)
  const platform = cleanText(record.platform, '', 80)
  const locale = cleanText(record.locale, '', 40)
  const userAgent = cleanText(record.userAgent, '', 180)
  if (appVersion) client.appVersion = appVersion
  if (platform) client.platform = platform
  if (locale) client.locale = locale
  if (userAgent) client.userAgent = userAgent
  return client
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

function requireIdentityId(value: string | undefined, prefix: 'agent_' | 'gw_', fallback: () => string): string {
  const candidate = value?.trim() || fallback()
  if (!candidate.startsWith(prefix) || !/^[A-Za-z0-9._:-]{3,160}$/.test(candidate)) {
    throw new Error(prefix === 'agent_' ? 'Invalid Hermes Agent id' : 'Invalid Gateway id')
  }
  return candidate
}

function requireGatewayToken(value: string): string {
  const candidate = value.trim()
  if (candidate.length < 32 || candidate.length > 1024 || /[\u0000-\u001f\u007f]/.test(candidate)) {
    throw new Error('Invalid Gateway token')
  }
  return candidate
}

function credentialKey(record: PairingRequestRecord): string | null {
  if (!record.hermesAgentId || !record.gatewayId || !record.gatewayTokenHash) return null
  return `${record.hermesAgentId}\u0000${record.gatewayId}\u0000${record.gatewayTokenHash}`
}

function inferredCredentialState(record: PairingRequestRecord): GatewayCredentialState | undefined {
  if (!credentialKey(record) || !record.approvedAt) return undefined
  if (record.gatewayCredentialState) return record.gatewayCredentialState
  return record.claimedAt ? 'active' : 'provisional'
}

function credentialTimestamp(record: PairingRequestRecord): number {
  return record.gatewayCredentialActivatedAt || record.claimedAt || record.approvedAt || record.createdAt
}

function cloneRecord(record: PairingRequestRecord): PairingRequestRecord {
  return {
    ...record,
    capabilities: [...record.capabilities],
    ...(record.client ? { client: { ...record.client } } : {})
  }
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string'
}

function isOptionalNumber(value: unknown): value is number | undefined {
  return value === undefined || (typeof value === 'number' && Number.isFinite(value))
}

function isPairingRequestRecord(value: unknown): value is PairingRequestRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  const client = record.client
  const clientRecord = client && typeof client === 'object' && !Array.isArray(client)
    ? client as Record<string, unknown>
    : null
  const clientValid = client === undefined || Boolean(
    clientRecord &&
    typeof clientRecord.appName === 'string' &&
    isOptionalString(clientRecord.appVersion) &&
    isOptionalString(clientRecord.platform) &&
    isOptionalString(clientRecord.locale) &&
    isOptionalString(clientRecord.userAgent)
  )
  return record.schemaVersion === PAIRING_RECORD_SCHEMA_VERSION &&
    typeof record.requestId === 'string' && Boolean(record.requestId) &&
    typeof record.user === 'string' &&
    typeof record.deviceName === 'string' &&
    typeof record.deviceId === 'string' && Boolean(record.deviceId) &&
    typeof record.deviceNonce === 'string' &&
    typeof record.devicePublicKey === 'string' &&
    typeof record.routerUrl === 'string' &&
    Array.isArray(record.capabilities) && record.capabilities.every(item => typeof item === 'string') &&
    typeof record.createdAt === 'number' && Number.isFinite(record.createdAt) &&
    typeof record.expiresAt === 'number' && Number.isFinite(record.expiresAt) &&
    isOptionalNumber(record.approvedAt) &&
    isOptionalNumber(record.claimedAt) &&
    isOptionalString(record.enrollmentNonce) &&
    isOptionalString(record.replacementTokenHash) &&
    isOptionalNumber(record.enrollmentConsumedAt) &&
    isOptionalString(record.codeHash) &&
    isOptionalString(record.hermesAgentId) &&
    isOptionalString(record.gatewayId) &&
    isOptionalString(record.gatewayTokenHash) &&
    (record.gatewayCredentialState === undefined || record.gatewayCredentialState === 'provisional' || record.gatewayCredentialState === 'active' || record.gatewayCredentialState === 'revoked') &&
    isOptionalNumber(record.gatewayCredentialActivatedAt) &&
    isOptionalNumber(record.gatewayCredentialRevokedAt) &&
    clientValid
}

export function hashPairingMaterial(secret: string, value: string): string {
  return createHmac('sha256', secret).update(value).digest('base64url')
}

export function buildGatewayEnrollmentTicket(secret: string, record: PairingRequestRecord): string {
  if (!record.enrollmentNonce) return ''
  const signature = hashPairingMaterial(
    secret,
    `gateway-enrollment:${record.requestId}:${record.enrollmentNonce}`,
  )
  return `enr_${record.enrollmentNonce}.${signature}`
}

type PairingPromptLocale = 'english' | 'traditionalChinese' | 'simplifiedChinese'

function pairingPromptLocale(value: string | undefined): PairingPromptLocale {
  const normalized = (value || '').trim().toLowerCase().replaceAll('_', '-')
  if (['traditionalchinese', 'zh-tw', 'zh-hant', 'zh-hk', 'zh-mo'].includes(normalized)) {
    return 'traditionalChinese'
  }
  if (['simplifiedchinese', 'zh-cn', 'zh-hans', 'zh-sg'].includes(normalized)) {
    return 'simplifiedChinese'
  }
  return 'english'
}

export function buildPairingPrompt(record: PairingRequestRecord, enrollmentTicket = ''): string {
  const router = record.routerUrl.replace(/\/$/, '')
  const enrollmentArgument = enrollmentTicket
    ? ` --enrollment-ticket "${enrollmentTicket}"`
    : ''
  const pairCommand = `hermes-hub-gateway pair --runtime hermes --router "${router}" --request-id "${record.requestId}"${enrollmentArgument}`
  const inspectCommand = 'npm list -g @over01470914/hermes-hub-gateway --depth=0 --json'
  const latestCommand = 'npm view @over01470914/hermes-hub-gateway@latest version --json'
  const npmCommand = 'npm install -g @over01470914/hermes-hub-gateway@latest'
  const commandCheck = 'command -v hermes-hub-gateway'
  const pathRepairCommand = 'export PATH="$(npm prefix -g)/bin:$PATH"'

  switch (pairingPromptLocale(record.client?.locale)) {
    case 'traditionalChinese':
      return [
        'Hermes Hub Gateway 配對',
        '',
        `1. 先執行 \`${inspectCommand}\` 讀取本機全域 CLI 套件版本，再執行 \`${latestCommand}\` 讀取 npm registry 的 latest 版本。若套件不存在或兩個版本不相同，為 \`${npmCommand}\` 請求 Hermes 原生授權並等待使用者批准；只有已安裝版本正好等於 latest 時才跳過升級。不要把版本號寫死、不要使用 Router release metadata 代替 registry 比對，也不要使用 \`npx\`。`,
        `2. 命令原本可用或安裝完成後，在執行配對前先執行 \`${commandCheck}\`。若找不到命令，僅針對目前 Hermes shell 執行 \`${pathRepairCommand}\`，再執行一次 \`${commandCheck}\`；這是配對前置修復，不是重試。不要用絕對路徑執行 CLI。若仍找不到命令，回傳 \`FAILED step PATH: hermes-hub-gateway is not on PATH\` 並停止。接著只執行一次以下配對命令；CLI 會自行使用健康的既有 Gateway，只有缺少或不相容時才修復 Plugin。Hermes Desktop 貼上文字時可能把命令中的 Router URL 改寫成 \`@url:\` 加反引號包裹的 URL；執行前必須移除整個顯示包裝，只把內層 URL 當成 \`--router\` 的單一純文字 argv 值。確認最終 Shell 命令不含 \`@url:\` 或任何反引號；Bash 會把反引號當成命令替換：`,
        `   ${pairCommand}`,
        `3. 若安裝授權尚未批准或被拒絕，回傳 \`NEEDS_APPROVAL: ${npmCommand}\` 並停止；這不是安裝失敗，也不要執行配對。成功時只回傳 CLI 輸出的 8 位配對碼；若有 \`NEXT:\`，原樣附在配對碼後。實際執行過的命令失敗時回傳 \`FAILED step ...\`，不要自行重試。`,
        '',
        '版本或 manifest SHA 不阻擋配對；相容性只由共同 protocol 與 capabilities 決定。不要揭露 enrollment ticket、Gateway credential、API key 或本機秘密。',
      ].join('\n')
    case 'simplifiedChinese':
      return [
        'Hermes Hub Gateway 配对',
        '',
        `1. 先执行 \`${inspectCommand}\` 读取本机全局 CLI 软件包版本，再执行 \`${latestCommand}\` 读取 npm registry 的 latest 版本。如果软件包不存在或两个版本不同，为 \`${npmCommand}\` 请求 Hermes 原生授权并等待用户批准；只有已安装版本正好等于 latest 时才跳过升级。不要把版本号写死、不要使用 Router release metadata 代替 registry 比对，也不要使用 \`npx\`。`,
        `2. 命令原本可用或安装完成后，在执行配对前先执行 \`${commandCheck}\`。若找不到命令，仅针对当前 Hermes shell 执行 \`${pathRepairCommand}\`，再执行一次 \`${commandCheck}\`；这是配对前置修复，不是重试。不要用绝对路径执行 CLI。若仍找不到命令，返回 \`FAILED step PATH: hermes-hub-gateway is not on PATH\` 并停止。接着只执行一次以下配对命令；CLI 会自行使用健康的现有 Gateway，只有缺失或不兼容时才修复 Plugin。Hermes Desktop 粘贴文本时可能把命令中的 Router URL 改写成 \`@url:\` 加反引号包裹的 URL；执行前必须移除整个显示包装，只把内层 URL 当成 \`--router\` 的单一纯文本 argv 值。确认最终 Shell 命令不含 \`@url:\` 或任何反引号；Bash 会把反引号当成命令替换：`,
        `   ${pairCommand}`,
        `3. 如果安装授权尚未批准或被拒绝，返回 \`NEEDS_APPROVAL: ${npmCommand}\` 并停止；这不是安装失败，也不要执行配对。成功时只返回 CLI 输出的 8 位配对码；如果有 \`NEXT:\`，原样附在配对码后。实际执行过的命令失败时返回 \`FAILED step ...\`，不要自行重试。`,
        '',
        '版本或 manifest SHA 不阻止配对；兼容性只由共同 protocol 与 capabilities 决定。不要泄露 enrollment ticket、Gateway credential、API key 或本机秘密。',
      ].join('\n')
    case 'english':
      return [
        'Hermes Hub Gateway pairing',
        '',
        `1. First run \`${inspectCommand}\` to read the locally installed global CLI package version, then run \`${latestCommand}\` to read the npm registry latest version. If the package is missing or the two versions differ, request native Hermes approval for \`${npmCommand}\` and wait for the user; skip the upgrade only when the installed version exactly equals latest. Do not hard-code a version, substitute Router release metadata for the registry comparison, or use \`npx\`.`,
        `2. After the command is already available or installation completes, run \`${commandCheck}\` before pairing. If it is not found, run \`${pathRepairCommand}\` for the current Hermes shell only, then run \`${commandCheck}\` once more; this is a pairing preflight repair, not a retry. Do not invoke the CLI by an absolute path. If it is still not found, return \`FAILED step PATH: hermes-hub-gateway is not on PATH\` and stop. Then run the following pairing command exactly once. The CLI reuses a healthy Gateway and repairs the Plugin only when it is missing or incompatible. Hermes Desktop may rewrite the Router URL in pasted text as \`@url:\` plus a backtick-wrapped URL; before execution, remove that entire display wrapper and pass only the inner URL as the single plain-text argv value for \`--router\`. Confirm the final shell command contains no \`@url:\` and no backticks; Bash treats backticks as command substitution:`,
        `   ${pairCommand}`,
        `3. If installation approval is pending or denied, return \`NEEDS_APPROVAL: ${npmCommand}\` and stop; this is not an installation failure, and do not run pairing. On success, return only the CLI's 8-digit code and append any \`NEXT:\` line unchanged. If a command actually ran and failed, return \`FAILED step ...\` and do not retry.`,
        '',
        'Version or manifest-SHA differences do not block pairing; compatibility comes only from a shared protocol and capabilities. Never reveal the enrollment ticket, Gateway credential, API key, or local secrets.',
      ].join('\n')
  }
}

export class InMemoryPairingStore {
  private records = new Map<string, PairingRequestRecord>()

  constructor(
    private readonly secret: string,
    private readonly defaultRouterUrl: string,
    private readonly nowSeconds: () => number = () => Math.floor(Date.now() / 1000),
    initialRecords: unknown[] = [],
    private readonly onChange?: (records: PairingRequestRecord[]) => void
  ) {
    for (const record of initialRecords) {
      if (!isPairingRequestRecord(record)) continue
      this.records.set(record.requestId, cloneRecord(record))
    }
    if (this.reconcileCredentialStates()) this.persist()
  }

  create(input: PairingRequestInput): PublicPairingRequest {
    const now = this.nowSeconds()
    const before = [...this.records.entries()].map(([id, item]) => [id, cloneRecord(item)] as const)
    const replacement = this.pendingReplacement(input, now)
    const pruned = this.pruneExpiredPending(now)
    const livePending = [...this.records.values()]
      .filter(record => this.isLivePending(record, now) && record !== replacement)
    if (livePending.length >= MAX_LIVE_PAIRING_REQUESTS) {
      try {
        if (pruned) this.persist()
      } catch (error) {
        this.records = new Map(before)
        throw error
      }
      const retryAt = Math.min(...livePending.map(record => record.expiresAt))
      throw new PairingCapacityError(Math.max(1, retryAt - now))
    }
    const ttl = typeof input.ttlSeconds === 'number' && input.ttlSeconds > 60 && input.ttlSeconds <= 1800 ? input.ttlSeconds : 1800
    if (replacement) {
      replacement.gatewayCredentialState = 'revoked'
      replacement.gatewayCredentialRevokedAt = now
      replacement.expiresAt = now - 1
    }
    const replacementToken = randomUUID().replaceAll('-', '') + randomUUID().replaceAll('-', '')
    const record: PairingRequestRecord = {
      schemaVersion: PAIRING_RECORD_SCHEMA_VERSION,
      requestId: `pair_${randomUUID()}`,
      user: cleanText(input.user, 'mobile-user'),
      deviceName: cleanText(input.deviceName, 'Mobile device'),
      deviceId: cleanText(input.deviceId, `device_${randomUUID()}`, 160),
      deviceNonce: cleanText(input.deviceNonce, randomUUID(), 200),
      devicePublicKey: cleanText(input.devicePublicKey, 'prototype-public-key', 500),
      // The Router is authoritative for the installer/source origin. Trusting
      // a client-supplied URL here would turn the pairing prompt into a
      // download/SSRF primitive against the local Hermes host.
      routerUrl: authoritativeRouterUrl(this.defaultRouterUrl),
      capabilities: cleanCapabilities(input.capabilities),
      client: cleanClientMetadata(input.client),
      createdAt: now,
      expiresAt: now + ttl,
      enrollmentNonce: randomUUID().replaceAll('-', ''),
      replacementTokenHash: hashPairingMaterial(
        this.secret,
        `pairing-replacement:${replacementToken}`,
      ),
    }
    this.records.set(record.requestId, record)
    try {
      this.persist()
    } catch (error) {
      this.records = new Map(before)
      throw error
    }
    return this.publicRecord(record, replacementToken)
  }

  get(requestId: string): PublicPairingRequest | null {
    const record = this.records.get(requestId)
    return record ? this.publicRecord(record) : null
  }

  approve(requestId: string, options: (() => string) | PairingApprovalOptions = generateEightDigitCode): PairingApproval {
    const record = this.requireLive(requestId)
    const before = cloneRecord(record)
    if (record.claimedAt) throw new Error('Pairing request already claimed')
    if (record.gatewayCredentialState === 'revoked') {
      throw new Error('Revoked Gateway credentials cannot be reused')
    }
    const approvalOptions = typeof options === 'function' ? { codeGenerator: options } : options
    const codeGenerator = approvalOptions.codeGenerator || generateEightDigitCode
    const randomCode = codeGenerator()
    if (!/^\d{8}$/.test(randomCode)) throw new Error('Pairing code must be 8 digits')
    const gatewayToken = requireGatewayToken(
      approvalOptions.gatewayToken || randomUUID().replaceAll('-', '') + randomUUID().replaceAll('-', '')
    )
    const hermesAgentId = requireIdentityId(
      approvalOptions.hermesAgentId || record.hermesAgentId,
      'agent_',
      () => `agent_${randomUUID()}`
    )
    const gatewayId = requireIdentityId(
      approvalOptions.gatewayId || record.gatewayId,
      'gw_',
      () => `gw_${randomUUID()}`
    )
    const gatewayTokenHash = hashPairingMaterial(this.secret, `${gatewayId}:${gatewayToken}`)
    if (record.approvedAt && (
      record.hermesAgentId !== hermesAgentId ||
      record.gatewayId !== gatewayId ||
      record.gatewayTokenHash !== gatewayTokenHash
    )) {
      throw new Error('Pairing request already approved for another Gateway credential')
    }
    const matchingGatewayRecords = [...this.records.values()].filter(item => (
      item.requestId !== record.requestId && item.gatewayId === gatewayId && item.gatewayTokenHash
    ))
    if (matchingGatewayRecords.some(item => (
      item.hermesAgentId !== hermesAgentId || item.gatewayTokenHash !== gatewayTokenHash
    ))) {
      throw new Error('Gateway id is already bound to another credential')
    }
    if (matchingGatewayRecords.some(item => inferredCredentialState(item) === 'revoked')) {
      throw new Error('Revoked Gateway credentials cannot be reused')
    }
    const activeCredential = matchingGatewayRecords.find(item => inferredCredentialState(item) === 'active')
    record.approvedAt = this.nowSeconds()
    record.hermesAgentId = hermesAgentId
    record.gatewayId = gatewayId
    record.codeHash = hashPairingMaterial(this.secret, `${record.requestId}:${randomCode}`)
    record.gatewayTokenHash = gatewayTokenHash
    record.gatewayCredentialState = activeCredential ? 'active' : 'provisional'
    record.gatewayCredentialActivatedAt = activeCredential?.gatewayCredentialActivatedAt || activeCredential?.claimedAt
    delete record.gatewayCredentialRevokedAt
    if (approvalOptions.consumeEnrollmentTicket) record.enrollmentConsumedAt = this.nowSeconds()
    try {
      this.persist()
    } catch (error) {
      this.records.set(record.requestId, before)
      throw error
    }
    return {
      requestId: record.requestId,
      randomCode,
      expiresAt: record.expiresAt,
      hermesAgentId,
      gatewayId,
      gatewayToken,
      gatewayStreamPath: `/router/hermes-hub-gateways/${gatewayId}/stream`
    }
  }

  enroll(requestId: string, enrollmentTicket: string, options: PairingApprovalOptions): PairingApproval {
    const record = this.requireLive(requestId)
    if (record.approvedAt || record.enrollmentConsumedAt) {
      throw Object.assign(new Error('Gateway enrollment ticket has already been consumed'), {
        code: 'gateway_enrollment_consumed',
      })
    }
    const expectedTicket = buildGatewayEnrollmentTicket(this.secret, record)
    const supplied = Buffer.from(enrollmentTicket || '')
    const expected = Buffer.from(expectedTicket)
    if (!expectedTicket || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      throw Object.assign(new Error('Gateway enrollment ticket is invalid'), {
        code: 'gateway_enrollment_invalid',
      })
    }

    return this.approve(requestId, { ...options, consumeEnrollmentTicket: true })
  }

  ensureDebugGateway(seed: DebugGatewaySeed): void {
    if (!/^\d{8}$/.test(seed.pairingCode)) throw new Error('Debug pairing code must be 8 digits')
    if (!seed.hermesAgentId.trim()) throw new Error('Debug Hermes Agent id is required')
    if (!seed.gatewayId.trim()) throw new Error('Debug gateway id is required')
    if (!seed.gatewayToken.trim()) throw new Error('Debug gateway token is required')
    const now = this.nowSeconds()
    const existing = this.records.get(seed.requestId)
    const record: PairingRequestRecord = {
      schemaVersion: PAIRING_RECORD_SCHEMA_VERSION,
      requestId: seed.requestId,
      user: cleanText(seed.user, 'debug-user'),
      deviceName: cleanText(seed.deviceName, 'Debug gateway'),
      deviceId: existing?.deviceId || 'device_debug_gateway',
      deviceNonce: existing?.deviceNonce || 'debug-gateway-nonce',
      devicePublicKey: existing?.devicePublicKey || 'debug-gateway-public-key',
      routerUrl: existing?.routerUrl || this.defaultRouterUrl,
      capabilities: existing?.capabilities || defaultCapabilities,
      client: existing?.client,
      createdAt: existing?.createdAt || now,
      expiresAt: seed.expiresAt,
      approvedAt: now,
      claimedAt: existing?.claimedAt,
      hermesAgentId: seed.hermesAgentId,
      gatewayId: seed.gatewayId,
      codeHash: hashPairingMaterial(this.secret, `${seed.requestId}:${seed.pairingCode}`),
      gatewayTokenHash: hashPairingMaterial(this.secret, `${seed.gatewayId}:${seed.gatewayToken}`),
      gatewayCredentialState: existing?.gatewayCredentialState === 'active' ? 'active' : 'provisional',
      gatewayCredentialActivatedAt: existing?.gatewayCredentialActivatedAt
    }
    const before = existing ? cloneRecord(existing) : undefined
    this.records.set(seed.requestId, record)
    try {
      this.persist()
    } catch (error) {
      if (before) this.records.set(seed.requestId, before)
      else this.records.delete(seed.requestId)
      throw error
    }
  }

  claim(requestId: string, code: string, validate?: PairingClaimValidator): PairingClaim {
    return this.claimRecord(this.requireLive(requestId), code, validate)
  }

  verifyGateway(gatewayId: string, token: string): PairingRequestRecord {
    const cleanGatewayId = requireIdentityId(gatewayId, 'gw_', () => '')
    const cleanToken = requireGatewayToken(token)
    const candidate = hashPairingMaterial(this.secret, `${cleanGatewayId}:${cleanToken}`)
    const matching = [...this.records.values()]
      .filter(item => item.schemaVersion === PAIRING_RECORD_SCHEMA_VERSION && item.gatewayId === cleanGatewayId && item.gatewayTokenHash)
      .filter(item => safeEqual(candidate, item.gatewayTokenHash!))
    const now = this.nowSeconds()
    const record = matching
      .filter(item => {
        const state = inferredCredentialState(item)
        return state === 'active' || (state === 'provisional' && item.expiresAt >= now)
      })
      .sort((left, right) => {
        const stateDelta = Number(inferredCredentialState(right) === 'active') - Number(inferredCredentialState(left) === 'active')
        return stateDelta || credentialTimestamp(right) - credentialTimestamp(left)
      })[0]
    if (!record) {
      if (matching.some(item => inferredCredentialState(item) === 'revoked')) {
        throw Object.assign(new Error('Gateway credential has been revoked'), { code: 'gateway_credential_revoked' })
      }
      if (matching.some(item => inferredCredentialState(item) === 'provisional')) {
        throw Object.assign(new Error('Gateway credential approval expired'), { code: 'gateway_credential_expired' })
      }
      throw Object.assign(new Error('Unknown gateway or invalid Gateway token'), { code: 'gateway_credential_invalid' })
    }
    return record
  }

  verifyPairingGateway(requestId: string, gatewayId: string, token: string): PairingRequestRecord {
    const record = this.records.get(requestId)
    if (!record || !record.gatewayId || !record.gatewayTokenHash) {
      throw Object.assign(new Error('Unknown Gateway pairing credential'), { code: 'gateway_credential_invalid' })
    }
    const cleanGatewayId = requireIdentityId(gatewayId, 'gw_', () => '')
    const cleanToken = requireGatewayToken(token)
    const candidate = hashPairingMaterial(this.secret, `${cleanGatewayId}:${cleanToken}`)
    const expected = Buffer.from(record.gatewayTokenHash)
    const supplied = Buffer.from(candidate)
    if (
      cleanGatewayId !== record.gatewayId ||
      supplied.length !== expected.length ||
      !timingSafeEqual(supplied, expected)
    ) {
      throw Object.assign(new Error('Unknown Gateway pairing credential'), { code: 'gateway_credential_invalid' })
    }
    return record
  }

  private claimRecord(
    record: PairingRequestRecord,
    code: string,
    validate?: PairingClaimValidator,
  ): PairingClaim {
    if (!record.codeHash || !record.hermesAgentId || !record.gatewayId) throw new Error('Pairing request not approved')
    const candidate = hashPairingMaterial(this.secret, `${record.requestId}:${code}`)
    if (!safeEqual(candidate, record.codeHash)) throw new Error('Invalid pairing code')
    const hermesAgentId = record.hermesAgentId
    const gatewayId = record.gatewayId
    const recordKey = credentialKey(record)
    if (!recordKey) throw new Error('Pairing request has an invalid Gateway credential')
    const otherCredentials = [...this.records.values()].filter(item => (
      item.hermesAgentId === hermesAgentId &&
      credentialKey(item) !== recordKey &&
      item.gatewayId
    ))
    const revokedGatewayIds = [...new Set(otherCredentials.map(item => item.gatewayId!))]
    const credentialRotated = record.claimedAt
      ? otherCredentials.some(item => item.gatewayCredentialRevokedAt === record.claimedAt)
      : otherCredentials.some(item => inferredCredentialState(item) === 'active')
    const buildClaim = (claimedAt: number, recovered: boolean): PairingClaim => ({
      requestId: record.requestId,
      user: record.user,
      deviceName: record.deviceName,
      deviceId: record.deviceId,
      hermesAgentId,
      gatewayId,
      gatewayCredentialState: 'active',
      claimedAt,
      bridgeTokenId: `bridge_${record.requestId}`,
      recovered,
      revokedGatewayIds,
      credentialRotated,
      capabilities: record.capabilities
    })

    if (record.claimedAt) {
      if (inferredCredentialState(record) !== 'active') {
        throw Object.assign(new Error('Pairing claim has been superseded by a newer Gateway credential'), {
          statusCode: 409,
          code: 'pairing_claim_superseded',
        })
      }
      const recoveredClaim = buildClaim(record.claimedAt, true)
      validate?.(recoveredClaim, gatewayId)
      return recoveredClaim
    }

    if (inferredCredentialState(record) === 'revoked') throw new Error('Gateway credential has been revoked')
    const now = this.nowSeconds()
    const claim = buildClaim(now, false)
    validate?.(claim, gatewayId)
    const before = [...this.records.entries()].map(([id, item]) => [id, cloneRecord(item)] as const)
    for (const item of this.records.values()) {
      if (item.hermesAgentId !== hermesAgentId || !credentialKey(item)) continue
      if (credentialKey(item) === recordKey) {
        item.gatewayCredentialState = 'active'
        item.gatewayCredentialActivatedAt = now
        delete item.gatewayCredentialRevokedAt
      } else if (inferredCredentialState(item) !== 'revoked') {
        item.gatewayCredentialState = 'revoked'
        item.gatewayCredentialRevokedAt = now
      }
    }
    record.claimedAt = now
    try {
      this.persist()
    } catch (error) {
      this.records = new Map(before)
      throw error
    }
    return claim
  }

  private requireLive(requestId: string): PairingRequestRecord {
    const record = this.records.get(requestId)
    if (!record) throw new Error('Pairing request not found')
    if (record.expiresAt < this.nowSeconds()) throw new Error('Pairing request is no longer available')
    return record
  }

  private pendingReplacement(
    input: PairingRequestInput,
    now: number,
  ): PairingRequestRecord | undefined {
    const requestId = typeof input.replaceRequestId === 'string'
      ? input.replaceRequestId.trim()
      : ''
    const token = typeof input.replaceToken === 'string'
      ? input.replaceToken.trim()
      : ''
    if (!requestId && !token) return undefined
    if (!/^pair_[A-Za-z0-9-]{1,200}$/.test(requestId) || !/^[A-Za-z0-9_-]{32,256}$/.test(token)) {
      throw Object.assign(new Error('Pairing replacement is invalid'), {
        statusCode: 400,
        code: 'pairing_replacement_invalid',
      })
    }
    const record = this.records.get(requestId)
    const expected = record?.replacementTokenHash
    const supplied = hashPairingMaterial(this.secret, `pairing-replacement:${token}`)
    if (!record || !expected || !this.isLivePending(record, now) || !safeEqual(expected, supplied)) {
      throw Object.assign(new Error('Pairing replacement is no longer available'), {
        statusCode: 409,
        code: 'pairing_replacement_unavailable',
      })
    }
    return record
  }

  private isLivePending(record: PairingRequestRecord, now: number): boolean {
    return !record.claimedAt && record.expiresAt >= now && inferredCredentialState(record) !== 'revoked'
  }

  private pruneExpiredPending(now: number): boolean {
    let changed = false
    for (const [requestId, record] of this.records) {
      const state = inferredCredentialState(record)
      if (record.claimedAt || record.expiresAt >= now || state === 'active' || state === 'revoked') continue
      this.records.delete(requestId)
      changed = true
    }
    return changed
  }

  private persist(): void {
    this.onChange?.([...this.records.values()].map(cloneRecord))
  }

  private reconcileCredentialStates(): boolean {
    let changed = false
    const agents = new Set(
      [...this.records.values()].map(record => record.hermesAgentId).filter((value): value is string => Boolean(value))
    )
    for (const hermesAgentId of agents) {
      const records = [...this.records.values()].filter(record => record.hermesAgentId === hermesAgentId && credentialKey(record))
      const activeCandidate = records
        .filter(record => inferredCredentialState(record) !== 'revoked' && (
          record.gatewayCredentialState === 'active' || (!record.gatewayCredentialState && record.claimedAt)
        ))
        .sort((left, right) => credentialTimestamp(right) - credentialTimestamp(left))[0]
      const activeKey = activeCandidate ? credentialKey(activeCandidate) : null
      for (const record of records) {
        const previous = record.gatewayCredentialState
        const next: GatewayCredentialState = activeKey
          ? credentialKey(record) === activeKey
            ? 'active'
            : previous === 'active' || Boolean(record.claimedAt)
              ? 'revoked'
              : previous || 'provisional'
          : previous || (record.claimedAt ? 'active' : 'provisional')
        if (next !== previous) {
          record.gatewayCredentialState = next
          changed = true
        }
      }
    }
    return changed
  }

  private publicRecord(
    record: PairingRequestRecord,
    replacementToken?: string,
  ): PublicPairingRequest {
    const now = this.nowSeconds()
    return {
      requestId: record.requestId,
      user: record.user,
      deviceName: record.deviceName,
      deviceId: record.deviceId,
      routerUrl: record.routerUrl,
      hermesAgentId: record.hermesAgentId,
      capabilities: record.capabilities,
      client: record.client,
      createdAt: record.createdAt,
      expiresAt: record.expiresAt,
      status: record.claimedAt ? 'claimed' : record.expiresAt < now ? 'expired' : record.approvedAt ? 'approved' : 'pending',
      ...(replacementToken ? { replacementToken } : {}),
      prompt: buildPairingPrompt(
        record,
        record.approvedAt || record.enrollmentConsumedAt
          ? ''
          : buildGatewayEnrollmentTicket(this.secret, record),
      )
    }
  }
}
