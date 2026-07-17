import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'

export interface BridgeTokenPayload {
  sub: string
  user: string
  deviceId: string
  hermesAgentId: string
  jti: string
  iat: number
  exp: number
  capabilities?: string[]
}

export interface PairingInput {
  user?: unknown
  pairingCode?: unknown
  deviceId?: unknown
  hermesAgentId?: unknown
  capabilities?: unknown
}

export interface BridgeRuntimeConfig {
  pairingCode: string
  secret: string
  tokenTtlSeconds: number
  insecureDevDefaults: boolean
}

function base64Url(input: string | Buffer): string {
  return Buffer.from(input).toString('base64url')
}

function sign(data: string, secret: string): string {
  return createHmac('sha256', secret).update(data).digest('base64url')
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

function requiredId(value: unknown, label: string, max = 160): string {
  if (typeof value !== 'string') throw new Error(`${label} missing`)
  const id = value.trim()
  if (!id || id.length > max || !/^[A-Za-z0-9._:-]+$/.test(id)) {
    throw new Error(`${label} invalid`)
  }
  return id
}

function cleanCapabilities(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return [...new Set(value
    .filter((item): item is string => typeof item === 'string')
    .map(item => item.trim())
    .filter(item => /^[a-z][a-z0-9-]*:[a-z][a-z0-9-]*$/.test(item))
    .slice(0, 24))]
}

export function readBridgeConfig(env: NodeJS.ProcessEnv = process.env): BridgeRuntimeConfig {
  const production = env.NODE_ENV === 'production'
  const pairingCode = env.HERMES_HUB_PAIRING_CODE || ''
  const bridgeSecret = env.HERMES_HUB_BRIDGE_SECRET || ''
  const insecureDevDefaults = !production && (!pairingCode || !bridgeSecret)
  if (production && (!pairingCode || !bridgeSecret)) {
    throw new Error('HERMES_HUB_PAIRING_CODE and HERMES_HUB_BRIDGE_SECRET are required in production')
  }
  return {
    pairingCode: pairingCode || 'dev-pairing-code',
    secret: bridgeSecret || 'dev-only-hermes-hub-bridge-secret-change-me',
    // A non-positive TTL intentionally creates a non-expiring token. Operators
    // can still opt into expiry by setting HERMES_HUB_TOKEN_TTL_SECONDS.
    tokenTtlSeconds: Number(env.HERMES_HUB_TOKEN_TTL_SECONDS || 0),
    insecureDevDefaults,
  }
}

export function issueBridgeToken(
  input: PairingInput,
  config: BridgeRuntimeConfig,
  now = Math.floor(Date.now() / 1000),
  tokenId = `bridge_${randomUUID()}`,
): string {
  if (input.pairingCode !== config.pairingCode) throw new Error('Invalid pairing code')
  const user = typeof input.user === 'string' && input.user.trim()
    ? input.user.trim().slice(0, 80)
    : 'mobile-user'
  const deviceId = requiredId(input.deviceId, 'Device id')
  const hermesAgentId = requiredId(input.hermesAgentId, 'Hermes Agent id')
  const jti = requiredId(tokenId, 'Token id', 200)
  const capabilities = cleanCapabilities(input.capabilities)
  const payload: BridgeTokenPayload = {
    sub: `device:${deviceId}`,
    user,
    deviceId,
    hermesAgentId,
    jti,
    iat: now,
    exp: config.tokenTtlSeconds > 0 ? now + config.tokenTtlSeconds : 0,
    ...(capabilities.length ? { capabilities } : {}),
  }
  const header = { alg: 'HS256', typ: 'JWT' }
  const body = `${base64Url(JSON.stringify(header))}.${base64Url(JSON.stringify(payload))}`
  return `${body}.${sign(body, config.secret)}`
}

export function verifyBridgeToken(
  token: string,
  config: BridgeRuntimeConfig,
  now = Math.floor(Date.now() / 1000),
): BridgeTokenPayload {
  const parts = token.split('.')
  if (parts.length !== 3) throw new Error('Invalid token')
  const [header, payload, signature] = parts
  const expected = sign(`${header}.${payload}`, config.secret)
  if (!safeEqual(signature, expected)) throw new Error('Invalid token signature')
  const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Partial<BridgeTokenPayload>
  if (typeof parsed.exp !== 'number' || !Number.isFinite(parsed.exp)) {
    throw new Error('Token expiry invalid')
  }
  if (parsed.exp > 0 && parsed.exp < now) throw new Error('Token expired')
  const deviceId = requiredId(parsed.deviceId, 'Token device id')
  const hermesAgentId = requiredId(parsed.hermesAgentId, 'Token Hermes Agent id')
  const jti = requiredId(parsed.jti, 'Token id', 200)
  if (typeof parsed.sub !== 'string' || parsed.sub !== `device:${deviceId}`) throw new Error('Token subject invalid')
  if (typeof parsed.user !== 'string' || !parsed.user.trim()) throw new Error('Token user missing')
  return {
    sub: parsed.sub,
    user: parsed.user,
    deviceId,
    hermesAgentId,
    jti,
    iat: typeof parsed.iat === 'number' ? parsed.iat : 0,
    exp: parsed.exp,
    capabilities: cleanCapabilities(parsed.capabilities),
  }
}

export function bearerToken(header: string | string[] | undefined): string | null {
  const value = Array.isArray(header) ? header[0] : header
  if (!value || !value.startsWith('Bearer ')) return null
  return value.slice('Bearer '.length).trim() || null
}

const bridgeWebSocketProtocolPrefix = 'hermes-hub.bridge.bearer.'

export function bridgeWebSocketProtocol(token: string): string {
  const normalized = token.trim()
  if (!normalized || !/^[A-Za-z0-9._-]+$/.test(normalized)) {
    throw new Error('Bridge WebSocket token is invalid')
  }
  return `${bridgeWebSocketProtocolPrefix}${normalized}`
}

export function bridgeTokenFromWebSocketProtocol(
  header: string | string[] | undefined,
): string | null {
  const values = (Array.isArray(header) ? header : [header || ''])
    .flatMap(value => value.split(','))
    .map(value => value.trim())
    .filter(Boolean)
  if (values.length !== 1) return null
  const protocol = values[0]
  if (!protocol.startsWith(bridgeWebSocketProtocolPrefix)) return null
  const token = protocol.slice(bridgeWebSocketProtocolPrefix.length)
  return token && /^[A-Za-z0-9._-]+$/.test(token) ? token : null
}
