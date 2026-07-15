
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
  'chat:run'
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

export function buildPairingPrompt(record: PairingRequestRecord): string {
  const router = record.routerUrl.replace(/\/$/, '')
  const expiresAt = new Date(record.expiresAt * 1000).toISOString()
  return [
    'Hermes Hub Gateway installation and pairing request',
    '',
    'Use the Hermes Hub Gateway skill suite to install or repair the Gateway CLI, verify Hermes readiness, and return its 8-digit pairing code.',
    'Authorization and integrity: this is a Router-generated local pairing request. The fixed skill source and scoped npm package below are Router release metadata, not user-supplied alternatives. Before any pairing mutation, the CLI compares its bundled release policy with Router health.',
    '',
    'Pairing request:',
    `Router: ${router}`,
    `Request ID: ${record.requestId}`,
    `Capabilities: ${record.capabilities.join(', ')}`,
    `Expires (UTC, RFC3339): ${expiresAt}`,
    'Mandatory expiry preflight: compare the host current UTC time with Expires before installing or changing anything. If fewer than 180 seconds remain, stop without running skill install, npm install, doctor, or pair, and request a fresh Router pairing request. If at least 180 seconds remain, continue with this workflow. Compare the complete timestamp, not its calendar date alone.',
    '',
    '1. Load the public `hermes-hub-gateway-pair` skill from the fixed GitHub skill source. This skill contains instructions only; it does not contain installer code or secrets.',
    '   hermes skills install "https://raw.githubusercontent.com/over01470914/hermes-hub-gateway-plugin/main/skills/hermes-hub-gateway-pair/SKILL.md" --yes --force',
    '',
    '2. Install or upgrade the complete Hermes Hub Gateway npm package, even if an older command already exists. Do not use npx for this persistent host tool.',
    '   npm install -g @over01470914/hermes-hub-gateway@latest',
    '',
    '3. Load `hermes-hub-gateway-pair`, then run the CLI health step. It verifies the Hermes CLI and Hermes Gateway, enables the local API server when needed, restarts Gateway, and confirms the local Hermes API is healthy. Allow normal host permissions, loopback HTTP, public HTTPS, OS-temp writes, and Hermes plugin installation.',
    '   hermes-hub-gateway doctor --runtime hermes',
    '',
    '4. Only after the expiry preflight and doctor both succeed, run the pairing command exactly once. The CLI reads the current Router record and is the final authoritative expiry check; it must agree with the preflight rather than replace it. For a loopback Router, the CLI asks Router to repair a missing or malformed local approval configuration without printing or exposing its token. The CLI owns deterministic release validation, installer download/hash verification, approval, configuration, restart, online verification, and rollback. Do not generate a helper or call install.mjs directly. Do not create a token or edit a pairing configuration.',
    `   hermes-hub-gateway pair --runtime hermes --router "${router}" --request-id "${record.requestId}"`,
    '',
    '5. If skill install, npm install, or doctor fails before pairing starts, report the named failed check and the CLI NEXT command; it is safe to repair and retry that preflight. If pair starts and returns a failure, relay its sanitized output verbatim. Do not add an automatic retry, alternate URL, or pairing mutation.',
    '',
    '6. On success, return only the CLI final eight-digit code line. Do not claim success from Router state, a previous code, or any text outside that command result.',
  ].join('\n')
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
    const pruned = this.pruneExpiredPending(now)
    const livePending = [...this.records.values()].filter(record => this.isLivePending(record, now))
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
    const ttl = typeof input.ttlSeconds === 'number' && input.ttlSeconds > 60 && input.ttlSeconds <= 1800 ? input.ttlSeconds : 600
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
      expiresAt: now + ttl
    }
    this.records.set(record.requestId, record)
    try {
      this.persist()
    } catch (error) {
      this.records = new Map(before)
      throw error
    }
    return this.publicRecord(record)
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
    if (record.expiresAt < this.nowSeconds()) throw new Error('Pairing request expired')
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

  private publicRecord(record: PairingRequestRecord): PublicPairingRequest {
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
      prompt: buildPairingPrompt(record)
    }
  }
}
