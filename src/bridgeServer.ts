import { spawnSync } from 'node:child_process'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { randomUUID, timingSafeEqual } from 'node:crypto'
import { WebSocketServer } from 'ws'
import { BoundedSseWriter } from './core/http/boundedSseWriter.js'
import { routerBasePath, stripRouterBasePath } from './core/http/routerBasePath.js'
import { resolvePublicRouterUrl } from './core/http/publicRouterUrl.js'
import { errorMessage, logRouter, type RouterLogLevel } from './core/observability/routerLogger.js'
import { readPrivateTextFileSync, writePrivateTextFileAtomicSync } from './core/persistence/privateStateFile.js'
import { resolveRouterStatePaths } from './core/persistence/routerStatePaths.js'
import { elapsedMs, encodeSseEvent, normalizeBootstrapQuery, requestId, sseHeaders, type GatewayRequestMetrics, type RpcStreamFrame } from './core/protocol/bridgeProtocol.js'
import {
  bearerToken,
  bridgeTokenFromWebSocketProtocol,
  issueBridgeToken,
  readBridgeConfig,
  type BridgeTokenPayload,
  verifyBridgeToken,
} from './core/security/bridgeAuth.js'
import { requireGatewayBoundBridge } from './core/security/bridgePolicy.js'
import { DiagnosticsPayloadError, normalizeDiagnosticsReceipt, summarizeDiagnosticsReceipt } from './features/diagnostics/diagnosticsReceipt.js'
import {
  gatewayPluginReleaseArtifact,
  gatewayPluginNpmPackage,
  gatewayPluginRepositoryUrl,
} from './features/gateway/gatewayPluginSource.js'
import {
  AGENT_FEATURE_GATEWAY_CONTRACT_VERSION,
  agentFeatureGatewayAvailable,
  type AgentFeature,
} from './features/gateway/agentFeatureCapability.js'
import { GatewayRegistry, type GatewayActivationReservation, type GatewayRpcResponse } from './features/gateway/gatewayRegistry.js'
import { HermesGatewayRepository } from './features/gateway/hermesGatewayRepository.js'
import { PairingRateLimiter, type PairingRateLimitRule } from './features/pairing/pairingRateLimiter.js'
import { InMemoryPairingStore, PAIRING_RECORD_SCHEMA_VERSION, type PairingClaim, type PairingRequestRecord } from './features/pairing/pairingStore.js'
import { ClientEventHub } from './features/realtime/clientEventHub.js'
import { PendingRealtimeFrameBuffer } from './features/realtime/pendingRealtimeFrames.js'
import { SessionMetadataStore } from './features/sessions/sessionMetadataStore.js'
import { NativeConversationStore } from './features/sessions/nativeConversationStore.js'
import { projectNativeSessionDetailPayload, projectNativeSessionListPayload } from './features/sessions/nativeSessionProjection.js'
import {
  KanbanBridgeRequestError,
  normalizeKanbanBridgeError,
  normalizeKanbanBridgeResponse,
  planKanbanBridgeRequest,
  type KanbanBridgePermission
} from './features/kanban/kanbanBridgeAdapter.js'
import {
  createCronBridgeAdapter,
  cronBridgePermission,
  type CronBridgeLogLevel
} from './features/cron/cronBridge.js'

const config = readBridgeConfig()
const routerInstanceId = randomUUID()
const port = Number(process.env.HERMES_HUB_ROUTER_PORT || 4320)
const host = process.env.HERMES_HUB_ROUTER_HOST || '0.0.0.0'
const configuredRouterUrl = process.env.HERMES_HUB_ROUTER_URL || `http://127.0.0.1:${port}`
const { routerUrl, strippedCanonicalPath: canonicalRouterPathStripped } = resolvePublicRouterUrl(configuredRouterUrl)
const configuredRouterBasePath = routerBasePath(routerUrl)
const {
  diagnosticsDir,
  pairingStorePath,
  sessionMetadataStorePath,
  nativeConversationStorePath,
} = resolveRouterStatePaths(import.meta.url)
const agentApprovalToken = process.env.HERMES_HUB_AGENT_APPROVAL_TOKEN || ''
if (agentApprovalToken.length < 32) {
  throw new Error('HERMES_HUB_AGENT_APPROVAL_TOKEN must be configured with at least 32 characters')
}
const defaultChatRunTimeoutMs = 180_000
const chatRunProxyTimeoutBufferMs = 30_000
const chatRunSseKeepAliveMs = 15_000
const maxPendingRealtimeFrames = 256
const maxPendingRealtimeBytes = 1024 * 1024
const maxDownstreamSseQueueItems = 256
const maxDownstreamSseQueueBytes = 1024 * 1024
const downstreamSseDrainTimeoutMs = 15_000

type PairingRateLimitedAction = 'request' | 'claim'

const pairingRateLimitRules: Record<PairingRateLimitedAction, {
  source: PairingRateLimitRule
  global: PairingRateLimitRule
}> = {
  request: {
    source: { maxAttempts: 8, windowMs: 10 * 60_000 },
    global: { maxAttempts: 64, windowMs: 10 * 60_000 },
  },
  claim: {
    source: { maxAttempts: 20, windowMs: 5 * 60_000 },
    global: { maxAttempts: 256, windowMs: 5 * 60_000 },
  },
}

const pairingRateLimiter = new PairingRateLimiter()

function assertPairingRateAllowed(request: IncomingMessage, action: PairingRateLimitedAction): void {
  // X-Forwarded-For is intentionally ignored. The Router can only trust the
  // address of its immediate TCP peer unless a separately authenticated proxy
  // contract is introduced.
  const source = request.socket.remoteAddress?.trim() || 'unknown-peer'
  const rules = pairingRateLimitRules[action]
  pairingRateLimiter.assertAllowed(`${action}:source`, source, rules.source)
  pairingRateLimiter.assertAllowed(`${action}:global`, 'router', rules.global)
}

interface DebugGatewayConfig {
  requestId: string
  user: string
  deviceName: string
  hermesAgentId: string
  gatewayId: string
  gatewayToken: string
  pairingCode: string
  expiresAt: number
}

function readDebugGatewayConfig(): DebugGatewayConfig | null {
  const enabled = process.env.HERMES_HUB_DEBUG_GATEWAY === '1'
  if (!enabled) return null
  const explicitDebugBuild = process.env.HERMES_HUB_DEBUG_GATEWAY_BUILD === 'debug-testing'
  if (process.env.NODE_ENV === 'production' && !explicitDebugBuild) {
    throw new Error('Debug gateway pairing requires HERMES_HUB_DEBUG_GATEWAY_BUILD=debug-testing when NODE_ENV=production')
  }
  const pairingCode = process.env.HERMES_HUB_DEBUG_PAIRING_CODE || '00000000'
  if (!/^\d{8}$/.test(pairingCode)) throw new Error('Debug gateway pairing code must be 8 digits')
  const hermesAgentId = process.env.HERMES_HUB_DEBUG_AGENT_ID || 'agent_debug_local'
  const gatewayId = process.env.HERMES_HUB_DEBUG_GATEWAY_ID || 'gw_debug_local'
  if (!/^[A-Za-z0-9._:-]{3,160}$/.test(hermesAgentId)) throw new Error('Debug Hermes Agent id must be 3-160 safe characters')
  if (!/^[A-Za-z0-9._:-]{3,160}$/.test(gatewayId)) throw new Error('Debug gateway id must be 3-160 safe characters')
  const gatewayToken = process.env.HERMES_HUB_DEBUG_GATEWAY_TOKEN || ''
  if (gatewayToken.length < 32) throw new Error('HERMES_HUB_DEBUG_GATEWAY_TOKEN is required for debug gateway mode')
  return {
    requestId: process.env.HERMES_HUB_DEBUG_PAIRING_REQUEST_ID || 'pair_debug_gateway',
    user: process.env.HERMES_HUB_DEBUG_USER || 'debug-user',
    deviceName: process.env.HERMES_HUB_DEBUG_DEVICE_NAME || 'Debug gateway',
    hermesAgentId,
    gatewayId,
    gatewayToken,
    pairingCode,
    expiresAt: Number(process.env.HERMES_HUB_DEBUG_GATEWAY_EXPIRES_AT || 4_102_444_800)
  }
}

function loadPairingRecords(path: string): PairingRequestRecord[] {
  const content = readPrivateTextFileSync(path)
  if (content === null) return []
  const data = JSON.parse(content) as { schemaVersion?: unknown; records?: unknown }
  if (data.schemaVersion !== PAIRING_RECORD_SCHEMA_VERSION || !Array.isArray(data.records)) {
    throw new Error('Pairing store has an invalid schema and cannot be loaded safely')
  }
  return data.records as PairingRequestRecord[]
}

function savePairingRecords(path: string, records: PairingRequestRecord[]): void {
  writePrivateTextFileAtomicSync(
    path,
    `${JSON.stringify({ schemaVersion: PAIRING_RECORD_SCHEMA_VERSION, records }, null, 2)}\n`,
  )
}

const pairingStore = new InMemoryPairingStore(
  config.secret,
  routerUrl,
  () => Math.floor(Date.now() / 1000),
  loadPairingRecords(pairingStorePath),
  records => savePairingRecords(pairingStorePath, records)
)
const debugGateway = readDebugGatewayConfig()
if (debugGateway) pairingStore.ensureDebugGateway(debugGateway)
const gatewayRegistry = new GatewayRegistry()
const hermesGateways = new HermesGatewayRepository(gatewayRegistry)
const clientEventHub = new ClientEventHub()
const sessionMetadataStore = new SessionMetadataStore(sessionMetadataStorePath)
const nativeConversationStore = new NativeConversationStore(nativeConversationStorePath)

gatewayRegistry.setSessionEventHandler(event => {
  const conversation = nativeConversationStore.acceptSessionEvent(
    event.hermesAgentId,
    event.laneId,
    event.sessionId,
  )
  if (!conversation) return false
  if (event.submissionId) {
    const submission = nativeConversationStore.getSubmission(event.hermesAgentId, event.submissionId)
    if (!submission || submission.laneId !== event.laneId) return false
  }
  if (event.event === 'prompt.requested') {
    const promptId = typeof event.data.promptId === 'string' ? event.data.promptId : ''
    if (!nativeConversationStore.registerPrompt(
      event.hermesAgentId,
      event.laneId,
      promptId,
      event.sessionId,
    )) return false
  } else if (event.event === 'prompt.resolved') {
    const promptId = typeof event.data.promptId === 'string' ? event.data.promptId : ''
    if (promptId) nativeConversationStore.resolvePrompt(event.hermesAgentId, promptId)
  }
  clientEventHub.publish({
    scope: `hermes-agent:${event.hermesAgentId}`,
    eventId: event.eventId,
    conversationId: conversation.conversationId,
    sessionId: event.sessionId || conversation.sessionId,
    submissionId: event.submissionId,
    event: event.event,
    data: event.data,
  })
  return true
})

gatewayRegistry.setRuntimeSnapshotHandler(snapshot => {
  // Agent-wide snapshots are intentionally cache-only: a Bridge event must
  // always resolve to a client conversation, while the Router's cache can
  // still seed a later status/bootstrap read without inventing one.
  if (snapshot.scope !== 'session' || !snapshot.sessionId) return
  const conversation = snapshot.laneId
    ? nativeConversationStore.acceptSessionEvent(
      snapshot.hermesAgentId,
      snapshot.laneId,
      snapshot.sessionId,
    )
    : nativeConversationStore.getBySessionId(snapshot.hermesAgentId, snapshot.sessionId)
  if (!conversation) return
  clientEventHub.publish({
    scope: `hermes-agent:${snapshot.hermesAgentId}`,
    eventId: snapshot.eventId,
    conversationId: conversation.conversationId,
    sessionId: snapshot.sessionId,
    submissionId: snapshot.submissionId,
    event: 'runtime.snapshot',
    data: snapshot.snapshot,
  })
})

type ProxiedHermesResponse = Awaited<ReturnType<typeof proxyViaGateway>>

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify(body))
}

function sendUnsupportedGatewayOperation(response: ServerResponse, operation: string): void {
  sendJson(response, 501, {
    error: `Hermes Gateway does not expose ${operation}`,
    code: 'gateway_capability_unsupported'
  })
}

function sendBuffer(response: ServerResponse, status: number, headers: Record<string, string>, body: Buffer): void {
  response.writeHead(status, headers)
  response.end(body)
}

function sendGatewayResponse(response: ServerResponse, rpc: GatewayRpcResponse): void {
  sendBuffer(response, rpc.status, rpc.headers, Buffer.from(rpc.bodyBase64 || '', 'base64'))
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function chatRunEventText(event: Record<string, unknown>): string {
  const payload = asRecord(event.payload)
  const candidates = [event.text, event.delta, event.message, event.rendered, event.summary, payload?.text, payload?.delta, payload?.message, payload?.rendered, payload?.summary, payload?.question, payload?.description, payload?.command]
  const value = candidates.find(item => typeof item === 'string' && item.length > 0)
  return typeof value === 'string' ? value : ''
}

type ChatStreamFrameSender = (frame: RpcStreamFrame, id?: string) => boolean

async function replayChatRunEvents(sendFrame: ChatStreamFrameSender, id: string, body: Buffer, metrics: GatewayRequestMetrics): Promise<number> {
  const parsed = parseJsonBuffer(body)
  const root = asRecord(parsed)
  const events = Array.isArray(root?.events) ? root.events : []
  const replayEvents = events.map(asRecord).filter((event): event is Record<string, unknown> => Boolean(event))
  const replayMetrics: GatewayRequestMetrics = { ...metrics, bufferedReplay: true, replayedEventCount: replayEvents.length }
  let replayed = 0
  const replayDelayMs = replayEvents.length > 1
    ? Math.max(1, Math.min(16, Math.floor(600 / replayEvents.length)))
    : 0
  for (let index = 0; index < replayEvents.length; index += 1) {
    const event = replayEvents[index]
    const eventName = typeof event.event === 'string' && event.event.trim()
      ? event.event.trim()
      : typeof event.type === 'string' && event.type.trim()
        ? event.type.trim()
        : 'status'
    if (!sendFrame({
      type: 'rpc_stream_chunk',
      id,
      event: eventName,
      data: event,
      text: chatRunEventText(event) || undefined,
      sentAt: Date.now() + index,
      metrics: replayMetrics
    }, id)) break
    replayed += 1
    if (replayDelayMs > 0 && index < replayEvents.length - 1) {
      await new Promise(resolve => setTimeout(resolve, replayDelayMs))
    }
  }
  return replayed
}

function isChatRunContentFrame(frame: RpcStreamFrame): boolean {
  if (frame.type !== 'rpc_stream_chunk') return false
  const event = frame.event.toLowerCase()
  return event !== 'start' &&
    event !== 'status' &&
    event !== 'status.update' &&
    event !== 'gateway.ready' &&
    event !== 'run.started' &&
    event !== 'run.completed'
}

function proxiedBody(proxied: ProxiedHermesResponse): Buffer {
  return Buffer.from(proxied.response.bodyBase64 || '', 'base64')
}

function proxiedStatus(proxied: ProxiedHermesResponse): number {
  return proxied.response.status
}

function statusLevel(status: number): RouterLogLevel {
  if (status >= 500) return 'error'
  if (status >= 400) return 'warn'
  return 'info'
}

function logPath(path: string): string {
  return path.split('?')[0]
}

function queryKeys(search: string): string[] {
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search)
  return [...new Set([...params.keys()])].slice(0, 20)
}

function proxiedLogContext(proxied: ProxiedHermesResponse, requestIdValue?: string, startedAt?: number): Record<string, unknown> {
  return {
    via: proxied.via,
    status: proxiedStatus(proxied),
    requestId: requestIdValue,
    latencyMs: startedAt === undefined ? undefined : elapsedMs(startedAt)
  }
}

function proxiedMetrics(proxied: ProxiedHermesResponse, requestIdValue: string, startedAt: number): GatewayRequestMetrics {
  const gatewayMetrics: Partial<GatewayRequestMetrics> = proxied.response.metrics || {}
  return {
    requestId: requestIdValue,
    totalLatencyMs: elapsedMs(startedAt),
    via: proxied.via,
    ...gatewayMetrics
  }
}

function jsonHeaders(headers: Record<string, string>): Record<string, string> {
  const next = { ...headers }
  delete next['content-length']
  next['content-type'] = next['content-type'] || 'application/json; charset=utf-8'
  return next
}

function parseJsonBuffer(body: Buffer): unknown | null {
  if (!body.length) return null
  try {
    return JSON.parse(body.toString('utf8')) as unknown
  } catch {
    return null
  }
}

function positiveNumber(value: unknown): number | undefined {
  const numeric = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN
  return Number.isFinite(numeric) && numeric > 0 ? numeric : undefined
}

function nonNegativeNumber(value: unknown): number | undefined {
  const numeric = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : undefined
}

function deepValueForKey(value: unknown, key: string, depth = 0): unknown {
  if (depth > 6) return undefined
  const record = asRecord(value)
  if (record) {
    if (Object.prototype.hasOwnProperty.call(record, key)) return record[key]
    for (const nested of Object.values(record)) {
      const found = deepValueForKey(nested, key, depth + 1)
      if (found !== undefined) return found
    }
    return undefined
  }
  if (Array.isArray(value)) {
    for (const nested of value) {
      const found = deepValueForKey(nested, key, depth + 1)
      if (found !== undefined) return found
    }
  }
  return undefined
}

function firstDeepNumber(
  value: unknown,
  keys: string[],
  parse: (candidate: unknown) => number | undefined
): number | undefined {
  for (const key of keys) {
    const parsed = parse(deepValueForKey(value, key))
    if (parsed !== undefined) return parsed
  }
  return undefined
}

function sessionContextMetadata(body: Buffer): Record<string, unknown> | null {
  const parsed = parseJsonBuffer(body)
  if (parsed === null) return null
  const contextMax = firstDeepNumber(
    parsed,
    ['context_max', 'context_length', 'context_limit'],
    positiveNumber
  )
  const contextUsed = firstDeepNumber(
    parsed,
    ['context_used', 'last_prompt_tokens', 'context_tokens'],
    nonNegativeNumber
  )
  const suppliedPercent = firstDeepNumber(
    parsed,
    ['context_percent', 'usage_percent'],
    nonNegativeNumber
  )
  if (contextMax === undefined && contextUsed === undefined && suppliedPercent === undefined) return null
  const contextPercent = suppliedPercent ?? (
    contextMax !== undefined && contextUsed !== undefined
      ? Math.max(0, Math.min(100, (contextUsed / contextMax) * 100))
      : undefined
  )
  return {
    context_max: contextMax,
    context_used: contextUsed,
    context_percent: contextPercent
  }
}

function modelOptionsPath(search = ''): string {
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search)
  const sessionId = params.get('sessionId')
  if (sessionId && !params.has('session_id')) {
    params.set('session_id', sessionId)
  }
  params.delete('sessionId')
  const query = params.toString()
  return query ? `api/model/options?${query}` : 'api/model/options'
}

async function proxyModelOptionsViaGateway(
  payload: Pick<BridgeTokenPayload, 'hermesAgentId' | 'deviceId'>,
  search: string,
  sourceHeaders?: IncomingMessage['headers'],
  requestIdValue?: string
): Promise<{
  proxied: ProxiedHermesResponse
  path: string
}> {
  const path = modelOptionsPath(search)
  const proxied = await proxyViaGateway(payload, path, { sourceHeaders })
  logRouter(statusLevel(proxiedStatus(proxied)), 'Bridge available models received', {
    requestId: requestIdValue,
    path: logPath(path),
    status: proxiedStatus(proxied)
  })
  return { proxied, path }
}

function chatRunProxyTimeoutMs(body: Buffer): number {
  const configured = positiveNumber(process.env.HERMES_HUB_CHAT_RUN_TIMEOUT_MS)
    ?? defaultChatRunTimeoutMs + chatRunProxyTimeoutBufferMs
  const payload = parseJsonBuffer(body)
  const request = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload as Record<string, unknown> : null
  const requested = positiveNumber(request?.timeout_ms ?? request?.timeoutMs)
  return requested ? Math.max(configured, requested + chatRunProxyTimeoutBufferMs) : configured
}

function chatRunUpstreamTimeoutMs(body: Buffer): number {
  return Math.max(1_000, chatRunProxyTimeoutMs(body) - chatRunProxyTimeoutBufferMs)
}

function chatRunStreamBody(body: Buffer): Buffer {
  const payload = parseJsonBuffer(body)
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return body
  const request = payload as Record<string, unknown>
  const normalized = {
    ...request,
    include_events: true,
  }
  return Buffer.from(JSON.stringify(normalized), 'utf8')
}

function applySessionMetadataToBody(hermesAgentId: string, body: Buffer): Buffer {
  const payload = parseJsonBuffer(body)
  if (!payload) return body
  return Buffer.from(JSON.stringify(sessionMetadataStore.applyToPayload(hermesAgentId, payload)), 'utf8')
}

function projectSessionList(hermesAgentId: string, body: Buffer): Buffer {
  const payload = parseJsonBuffer(body)
  if (!payload) return body
  const conversations = nativeConversationStore.ensureForSessions(
    hermesAgentId,
    sessionIdsFromListPayload(payload),
  )
  return Buffer.from(JSON.stringify(
    projectNativeSessionListPayload(payload, conversations),
  ), 'utf8')
}

function sendGatewaySessionResponse(
  response: ServerResponse,
  rpc: GatewayRpcResponse,
  hermesAgentId: string,
): void {
  const body = applySessionMetadataToBody(
    hermesAgentId,
    Buffer.from(rpc.bodyBase64 || '', 'base64'),
  )
  sendBuffer(response, rpc.status, jsonHeaders(rpc.headers), body)
}

function sendGatewaySessionListResponse(
  response: ServerResponse,
  rpc: GatewayRpcResponse,
  hermesAgentId: string,
): void {
  const withMetadata = applySessionMetadataToBody(
    hermesAgentId,
    Buffer.from(rpc.bodyBase64 || '', 'base64'),
  )
  sendBuffer(response, rpc.status, jsonHeaders(rpc.headers), projectSessionList(hermesAgentId, withMetadata))
}

function sessionReadTarget(hermesAgentId: string, clientSessionId: string): string {
  const conversation = nativeConversationStore.getByConversationId(hermesAgentId, clientSessionId)
  if (!conversation) return clientSessionId
  if (!conversation.sessionId) {
    throw Object.assign(new Error('Native conversation has no Hermes session yet'), {
      code: 'native_session_pending',
      statusCode: 409,
    })
  }
  return conversation.sessionId
}

function sendNativeSessionRequired(response: ServerResponse): void {
  sendJson(response, 410, {
    error: 'This request-bound chat route has been removed; use /bridge/session-messages',
    code: 'native_session_required',
  })
}

function gatewayAdvertisesCapability(hermesAgentId: string, capability: string): boolean {
  const gateway = hermesGateways.get(hermesAgentId)
  return gateway?.online === true && gateway.capabilities?.includes(capability) === true
}

function sessionIdFromRecord(session: Record<string, unknown>): string | undefined {
  if (typeof session.id === 'string') return session.id
  if (typeof session.session_id === 'string') return session.session_id
  if (typeof session.sessionId === 'string') return session.sessionId
  return undefined
}

function sessionIdsFromListPayload(payload: unknown): string[] {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return []
  const data = payload as Record<string, unknown>
  const sessions = Array.isArray(data.sessions)
    ? data.sessions
    : Array.isArray(data.data)
      ? data.data
      : []
  const sessionIds = new Set<string>()
  for (const value of sessions) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue
    const sessionId = sessionIdFromRecord(value as Record<string, unknown>)
    if (sessionId) sessionIds.add(sessionId)
  }
  return [...sessionIds]
}

function sessionIdFromBody(body: Buffer): string | undefined {
  const payload = parseJsonBuffer(body)
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return undefined
  const data = payload as Record<string, unknown>
  const session = data.session && typeof data.session === 'object' && !Array.isArray(data.session) ? data.session as Record<string, unknown> : data
  return sessionIdFromRecord(session)
}

function sessionIdFromGatewayResponse(rpc: GatewayRpcResponse): string | undefined {
  return sessionIdFromBody(Buffer.from(rpc.bodyBase64 || '', 'base64'))
}

function sanitizeCreateSessionBody(input: Record<string, unknown>): Record<string, unknown> {
  const allowed = [
    'id',
    'session_id',
    'model',
    'system_prompt',
    'title'
  ]
  return Object.fromEntries(Object.entries(input).filter(([key]) => allowed.includes(key)))
}

function maybePersistChatRunMetadata(
  hermesAgentId: string,
  body: Buffer,
  proxiedBody: Buffer,
): void {
  const input = parseJsonBuffer(body)
  if (!input || typeof input !== 'object' || Array.isArray(input)) return
  const sessionId = sessionIdFromBody(proxiedBody)
  if (!sessionId) return
  sessionMetadataStore.set(hermesAgentId, sessionId, input)
}

function selectedHermesAgentId(payload: { hermesAgentId: string }): string {
  return payload.hermesAgentId
}

async function proxyViaGateway(payload: { hermesAgentId: string; deviceId: string }, hermesPath: string, init: {
  method?: string
  body?: Buffer
  sourceHeaders?: IncomingMessage['headers']
  contentType?: string
  timeoutMs?: number
} = {}): Promise<{ via: 'hermes-hub-gateway'; response: GatewayRpcResponse }> {
  requireGatewayBoundBridge(payload)
  const hermesAgentId = selectedHermesAgentId(payload)
  logRouter('debug', 'Proxy dispatching through Hermes Hub Gateway', {
    hermesAgentId,
    method: init.method || 'GET',
    path: logPath(hermesPath.startsWith('/') ? hermesPath : `/${hermesPath}`),
    queryKeys: queryKeys(hermesPath.includes('?') ? hermesPath.slice(hermesPath.indexOf('?')) : ''),
    bodyBytes: init.body?.length,
    timeoutMs: init.timeoutMs
  })
  const startedAt = Date.now()
  const connection = await hermesGateways.request(hermesAgentId, {
    method: init.method || 'GET',
    path: hermesPath.startsWith('/') ? hermesPath : `/${hermesPath}`,
    headers: init.contentType
      ? { 'content-type': init.contentType, accept: 'application/json' }
      : { accept: 'application/json' },
    bodyBase64: init.body ? init.body.toString('base64') : undefined,
  }, init.timeoutMs)
  const response = connection.response
  logRouter(statusLevel(response.status), 'Gateway response received', {
    hermesAgentId,
    method: init.method || 'GET',
    path: logPath(hermesPath.startsWith('/') ? hermesPath : `/${hermesPath}`),
    status: response.status,
    latencyMs: elapsedMs(startedAt)
  })
  return { via: 'hermes-hub-gateway', response }
}

async function readBody(request: IncomingMessage, maxBytes = 25 * 1024 * 1024): Promise<Buffer> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > maxBytes) throw new Error('Request body too large')
    chunks.push(buffer)
  }
  return Buffer.concat(chunks)
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const body = await readBody(request, 1024 * 1024)
  if (body.length === 0) return {}
  return JSON.parse(body.toString('utf8')) as Record<string, unknown>
}

async function readAttachmentJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const body = await readBody(request, 25 * 1024 * 1024)
  if (body.length === 0) throw Object.assign(new Error('Attachment body is required'), { code: 'validation_error', statusCode: 400 })
  try {
    const parsed = JSON.parse(body.toString('utf8')) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Attachment body must be an object')
    }
    return parsed as Record<string, unknown>
  } catch (error) {
    if ((error as { statusCode?: unknown }).statusCode) throw error
    throw Object.assign(new Error('Attachment body must be valid JSON'), { code: 'validation_error', statusCode: 400 })
  }
}

function gatewayRpcBody(method: string, params: Record<string, unknown>, timeoutMs?: number): Buffer {
  return Buffer.from(JSON.stringify({ method, params, ...(timeoutMs ? { timeoutMs } : {}) }), 'utf8')
}

function commandDispatchGatewayRequest(input: Record<string, unknown>): { method: string; params: Record<string, unknown> } {
  const name = typeof input.name === 'string' ? input.name.trim() : ''
  const sessionId = typeof input.session_id === 'string' ? input.session_id.trim() : ''
  if (!name) throw new Error('command dispatch requires name')

  if (name === 'approval.respond') {
    const rawParams = input.params
    const params = rawParams && typeof rawParams === 'object' && !Array.isArray(rawParams)
      ? { ...(rawParams as Record<string, unknown>) }
      : {}
    return {
      method: name,
      params: {
        ...params,
        session_id: typeof params.session_id === 'string' ? params.session_id : sessionId || undefined
      }
    }
  }

  if (name === 'session.interrupt') {
    const rawParams = input.params
    const params = rawParams && typeof rawParams === 'object' && !Array.isArray(rawParams)
      ? { ...(rawParams as Record<string, unknown>) }
      : {}
    const resolvedSessionId = typeof params.session_id === 'string' ? params.session_id.trim() : sessionId
    if (!resolvedSessionId) throw new Error(`${name} requires session_id`)
    return {
      method: name,
      params: { session_id: resolvedSessionId }
    }
  }

  throw Object.assign(
    new Error(`Gateway command is not supported: ${name}`),
    { statusCode: 501, code: 'gateway_capability_unsupported' }
  )
}

function requirePayload(request: IncomingMessage) {
  const token = bearerToken(request.headers.authorization)
  if (!token) throw new Error('Missing bridge token')
  return verifyBridgeToken(token, config)
}

function requireRealtimePayload(request: IncomingMessage) {
  const token = bearerToken(request.headers.authorization) ||
    bridgeTokenFromWebSocketProtocol(request.headers['sec-websocket-protocol'])
  if (!token) throw new Error('Missing bridge token')
  return verifyBridgeToken(token, config)
}

type AgentFeaturePermission = 'read' | 'write' | 'execute'

function hasAgentFeaturePermission(
  payload: BridgeTokenPayload,
  feature: AgentFeature,
  permission: AgentFeaturePermission
): boolean {
  return (payload.capabilities || []).includes(`${feature}:${permission}`)
}

function requireAgentFeaturePermission(
  payload: BridgeTokenPayload,
  feature: AgentFeature,
  permission: AgentFeaturePermission
): void {
  if (hasAgentFeaturePermission(payload, feature, permission)) return
  throw Object.assign(
    new Error(`Bridge token does not grant ${feature}:${permission}`),
    { statusCode: 403, code: 'feature_permission_denied' }
  )
}

function bridgeClientEventScope(payload: BridgeTokenPayload): string {
  return `hermes-agent:${payload.hermesAgentId}`
}

function bridgeClientId(request: IncomingMessage, url?: URL): string {
  const header = Array.isArray(request.headers['x-hermes-hub-client-id'])
    ? request.headers['x-hermes-hub-client-id'][0]
    : request.headers['x-hermes-hub-client-id']
  const candidate = (header || url?.searchParams.get('clientId') || '').trim()
  if (!candidate) return `anonymous_${randomUUID()}`
  return /^[A-Za-z0-9._:-]{1,128}$/.test(candidate)
    ? candidate
    : `invalid_${randomUUID()}`
}

function chatRunSessionId(body: Buffer): string {
  const parsed = asRecord(parseJsonBuffer(body))
  const value = parsed?.session_id ?? parsed?.sessionId
  return typeof value === 'string' ? value.trim() : ''
}

function frameSessionId(frame: RpcStreamFrame): string {
  if (frame.type === 'rpc_stream_chunk') {
    const data = asRecord(frame.data)
    const value = data?.stored_session_id ?? data?.storedSessionId ?? data?.session_id ?? data?.sessionId
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  if (frame.type === 'rpc_stream_end' && frame.bodyBase64) {
    try {
      const body = asRecord(JSON.parse(Buffer.from(frame.bodyBase64, 'base64').toString('utf8')))
      const value = body?.stored_session_id ?? body?.storedSessionId ?? body?.session_id ?? body?.sessionId
      if (typeof value === 'string' && value.trim()) return value.trim()
    } catch {
      return ''
    }
  }
  return ''
}

function getPath(request: IncomingMessage): { pathname: string; search: string; url: URL } {
  const url = new URL(request.url || '/', 'http://hermes-hub.local')
  return {
    pathname: stripRouterBasePath(url.pathname, configuredRouterBasePath),
    search: url.search,
    url,
  }
}

function requireAgentApproval(request: IncomingMessage): void {
  const value = Array.isArray(request.headers['x-hermes-hub-agent-approval'])
    ? request.headers['x-hermes-hub-agent-approval'][0]
    : request.headers['x-hermes-hub-agent-approval']
  const supplied = Buffer.from(value || '')
  const expected = Buffer.from(agentApprovalToken)
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    throw new Error('Missing agent approval token')
  }
}

function requireDiagnosticsReadApproval(request: IncomingMessage): void {
  requireAgentApproval(request)
}

function requireOperatorApproval(request: IncomingMessage): void {
  requireAgentApproval(request)
}

function headerValue(request: IncomingMessage, name: string): string {
  const value = request.headers[name]
  return Array.isArray(value) ? String(value[0] || '') : String(value || '')
}

function isLoopbackPeer(request: IncomingMessage): boolean {
  const address = String(request.socket.remoteAddress || '').trim().toLowerCase()
  return address === '::1' || address === '127.0.0.1' || address.startsWith('::ffff:127.')
}

function localHermesPairingConfigPath(): string {
  const configured = String(process.env.HERMES_HUB_LOCAL_PAIRING_CONFIG_PATH || '').trim()
  if (configured) return resolve(configured)

  const command = String(process.env.HERMES_COMMAND || '').trim() || 'hermes'
  const result = spawnSync(command, ['config', 'path'], {
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
    timeout: 10_000,
  })
  const configPath = result.status === 0
    ? String(result.stdout || '').trim().split(/\r?\n/).filter(Boolean).at(-1)
    : ''
  if (!configPath) {
    throw Object.assign(new Error('Local Router could not resolve the Hermes configuration path for approval bootstrap'), {
      statusCode: 503,
      code: 'local_approval_bootstrap_unavailable',
    })
  }
  return join(dirname(resolve(configPath)), 'hermes-hub', 'pairing.json')
}

function synchronizeLocalApprovalConfiguration(request: IncomingMessage): void {
  // This endpoint is intentionally not an operator-authenticated route: it is
  // the recovery path used before the CLI has a token. It is limited to a
  // direct loopback peer, rejects browser-originated requests, and never
  // returns the token or accepts a caller-selected destination path.
  if (!isLoopbackPeer(request) || headerValue(request, 'origin') || headerValue(request, 'x-hermes-hub-local-bootstrap') !== '1') {
    throw Object.assign(new Error('Local approval bootstrap is available only to the local Gateway CLI'), {
      statusCode: 403,
      code: 'local_approval_bootstrap_forbidden',
    })
  }
  writePrivateTextFileAtomicSync(
    localHermesPairingConfigPath(),
    `${JSON.stringify({ schemaVersion: 1, approvalToken: agentApprovalToken }, null, 2)}\n`,
  )
}

function diagnosticsFilenameSegment(value: string, fallback: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
  return normalized || fallback
}

function diagnosticsReportId(payload: BridgeTokenPayload, receivedAt: Date): string {
  const timestamp = receivedAt.toISOString().replace(/[-:.]/g, '')
  const user = diagnosticsFilenameSegment(payload.user, 'user')
  const deviceId = diagnosticsFilenameSegment(payload.deviceId, 'device')
  return `diag_${timestamp}_${user}_${deviceId}_${randomUUID().replace(/-/g, '')}`
}

function isDiagnosticsReportId(reportId: string): boolean {
  return /^diag_[a-z0-9]+_[a-f0-9]{8}$/i.test(reportId) ||
    /^diag_\d{8}T\d{9}Z_[a-z0-9-]{1,32}_[a-z0-9-]{1,32}_[a-f0-9]{32}$/i.test(reportId)
}

async function persistDiagnostics(payload: BridgeTokenPayload, input: Record<string, unknown>): Promise<{ reportId: string; fileName: string; receivedAt: string; entries: number }> {
  const receipt = normalizeDiagnosticsReceipt(input)
  const summary = summarizeDiagnosticsReceipt(receipt)
  const receivedAt = new Date()
  const receivedAtIso = receivedAt.toISOString()
  const reportId = diagnosticsReportId(payload, receivedAt)
  const fileName = `${reportId}.json`
  const hermesAgentId = selectedHermesAgentId(payload)
  const record = {
    schemaVersion: 'hermes-hub-diagnostics/v2',
    reportId,
    fileName,
    receivedAt: receivedAtIso,
    sortKey: receivedAtIso,
    routerInstanceId,
    hermesAgentId,
    submittedBy: {
      user: payload.user,
      deviceId: payload.deviceId
    },
    entryCount: summary.entryCount,
    metadata: receipt.metadata,
    entries: receipt.entries
  }
  const serialized = `${JSON.stringify(record, null, 2)}\n`
  await mkdir(diagnosticsDir, { recursive: true })
  await writeFile(join(diagnosticsDir, fileName), serialized, 'utf8')
  logRouter('info', 'Diagnostics report received and persisted', {
    reportId,
    fileName,
    sortKey: receivedAtIso,
    submittedBy: { user: payload.user, deviceId: payload.deviceId },
    hermesAgentId,
    entryCount: summary.entryCount,
    levels: summary.levels,
    categories: summary.categories,
    metadataKeys: summary.metadataKeys,
    receiptBytes: summary.receiptBytes,
    persistedBytes: Buffer.byteLength(serialized, 'utf8')
  })
  return { reportId, fileName, receivedAt: receivedAtIso, entries: summary.entryCount }
}

async function readDiagnostics(reportId: string): Promise<unknown> {
  if (!isDiagnosticsReportId(reportId)) throw new Error('Invalid diagnostics report id')
  const raw = await readFile(join(diagnosticsDir, `${reportId}.json`), 'utf8')
  logRouter('info', 'Diagnostics report read', { reportId })
  return JSON.parse(raw) as unknown
}

function jsonPayloadFromProxied(proxied: Awaited<ReturnType<typeof proxyViaGateway>>): unknown {
  return parseJsonBuffer(proxiedBody(proxied))
}

const agentFeatureProbeCache = new Map<string, { available: boolean; expiresAt: number }>()

async function agentFeatureAvailable(
  payload: BridgeTokenPayload,
  feature: AgentFeature
): Promise<boolean> {
  if (!hasAgentFeaturePermission(payload, feature, 'read')) return false
  const hermesAgentId = selectedHermesAgentId(payload)
  const key = `${hermesAgentId}:${feature}`
  const now = Date.now()
  const cached = agentFeatureProbeCache.get(key)
  if (cached && cached.expiresAt > now) return cached.available

  // Do not use a feature-shaped HTTP probe as evidence of a public contract:
  // it could be a WebUI/private route. The Gateway hello is the only authority
  // for host capabilities and is bound to this Hermes Agent identity.
  const available = agentFeatureGatewayAvailable(hermesGateways.get(hermesAgentId), feature)
  agentFeatureProbeCache.set(key, { available, expiresAt: now + (available ? 15_000 : 5_000) })
  return available
}

async function handleKanbanBridge(
  request: IncomingMessage,
  response: ServerResponse,
  payload: BridgeTokenPayload,
  pathname: string,
  search: string
): Promise<boolean> {
  if (pathname !== '/bridge/kanban' && !pathname.startsWith('/bridge/kanban/')) {
    return false
  }
  try {
    const method = (request.method || 'GET').toUpperCase()
    const body = method === 'GET' ? undefined : await readJson(request)
    const plan = planKanbanBridgeRequest({ method, pathname, search, body })
    if (!plan) return false
    requireAgentFeaturePermission(
      payload,
      'kanban',
      plan.permission as KanbanBridgePermission
    )
    const startedAt = Date.now()
    logRouter('info', 'Kanban bridge operation requested', {
      operation: plan.operation,
      permission: plan.permission,
      requestId: plan.requestId,
      retryPolicy: plan.retryPolicy,
      queryKeys: queryKeys(search)
    })
    const requestBody = plan.body
      ? Buffer.from(JSON.stringify(plan.body), 'utf8')
      : undefined
    const proxied = await proxyViaGateway(payload, plan.upstreamPath, {
      method: plan.method,
      body: requestBody,
      contentType: requestBody ? 'application/json' : undefined,
      sourceHeaders: request.headers
    })
    const status = proxiedStatus(proxied)
    logRouter(statusLevel(status), 'Kanban bridge operation completed', {
      operation: plan.operation,
      status,
      latencyMs: elapsedMs(startedAt),
      responseBytes: proxiedBody(proxied).length,
      requestId: plan.requestId
    })
    if (status >= 200 && status < 300) {
      sendJson(
        response,
        status,
        normalizeKanbanBridgeResponse(plan.operation, jsonPayloadFromProxied(proxied))
      )
    } else {
      sendJson(response, status, normalizeKanbanBridgeError(status))
    }
    return true
  } catch (error) {
    if (error instanceof KanbanBridgeRequestError) {
      logRouter(error.status >= 500 ? 'error' : 'warn', 'Kanban bridge request rejected', {
        code: error.code,
        status: error.status,
        method: request.method
      })
      sendJson(response, error.status, { error: error.message, code: error.code })
      return true
    }
    const status = typeof (error as { statusCode?: unknown }).statusCode === 'number'
      ? (error as { statusCode: number }).statusCode
      : 500
    const code = (error as { code?: unknown }).code === 'feature_permission_denied'
      ? 'feature_permission_denied'
      : 'kanban_bridge_failed'
    logRouter(status >= 500 ? 'error' : 'warn', 'Kanban bridge operation failed', {
      code,
      status,
      method: request.method
    })
    sendJson(
      response,
      status,
      code === 'feature_permission_denied'
        ? { error: 'Kanban permission denied', code }
        : normalizeKanbanBridgeError(status)
    )
    return true
  }
}

async function handleCronBridge(
  request: IncomingMessage,
  response: ServerResponse,
  payload: BridgeTokenPayload,
  pathname: string,
  url: URL
): Promise<boolean> {
  if (pathname !== '/bridge/cron' && !pathname.startsWith('/bridge/cron/')) {
    return false
  }
  const method = (request.method || 'GET').toUpperCase()
  const permission = cronBridgePermission({ method, pathname })
  if (permission) {
    try {
      requireAgentFeaturePermission(payload, 'cron', permission)
    } catch (error) {
      const status = (error as { statusCode?: number }).statusCode || 403
      sendJson(response, status, {
        error: errorMessage(error),
        code: 'feature_permission_denied'
      })
      return true
    }
  }
  const body = method === 'GET' ? undefined : await readJson(request)
  const adapter = createCronBridgeAdapter({
    proxy: async upstream => {
      const upstreamBody = upstream.body
        ? Buffer.from(JSON.stringify(upstream.body), 'utf8')
        : undefined
      const proxied = await proxyViaGateway(payload, upstream.path, {
        method: upstream.method,
        body: upstreamBody,
        contentType: upstreamBody ? 'application/json' : undefined,
        sourceHeaders: request.headers
      })
      return {
        status: proxiedStatus(proxied),
        body: proxiedBody(proxied),
        via: proxied.via,
        responseBytes: proxiedBody(proxied).length
      }
    },
    log: (level: CronBridgeLogLevel, message, metadata) => {
      logRouter(level, message, metadata)
    }
  })
  const result = await adapter.handle({
    method,
    pathname,
    searchParams: url.searchParams,
    body
  })
  if (!result) return false
  sendJson(response, result.status, result.body)
  return true
}

interface RawSessionUpstreamAttempt {
  path: string
  status?: number
  via?: 'hermes-hub-gateway'
  error?: string
}

interface RawSessionFetch {
  path: string
  status: number
  via: 'hermes-hub-gateway'
  payload: unknown
  attempts: RawSessionUpstreamAttempt[]
}

function isUpstreamOk(fetch: Pick<RawSessionFetch, 'status'>): boolean {
  return fetch.status >= 200 && fetch.status < 300
}

async function fetchRawSessionPath(
  request: IncomingMessage,
  payload: Pick<BridgeTokenPayload, 'hermesAgentId' | 'deviceId'>,
  path: string,
  logMessage: string
): Promise<RawSessionFetch> {
  const startedAt = Date.now()
  const proxied = await proxyViaGateway(payload, path, { sourceHeaders: request.headers })
  const status = proxiedStatus(proxied)
  const parsed = jsonPayloadFromProxied(proxied)
  logRouter(statusLevel(status), logMessage, {
    ...proxiedLogContext(proxied, undefined, startedAt),
    path: logPath(path),
    queryKeys: queryKeys(path.includes('?') ? path.slice(path.indexOf('?')) : ''),
    hasPayload: parsed !== null
  })
  return {
    path,
    status,
    via: proxied.via,
    payload: parsed,
    attempts: [{ path, status, via: proxied.via }]
  }
}

async function fetchRawSessionDetail(
  request: IncomingMessage,
  payload: Pick<BridgeTokenPayload, 'hermesAgentId' | 'deviceId'>,
  sessionId: string,
  _url: URL
): Promise<RawSessionFetch> {
  return fetchRawSessionPath(
    request,
    payload,
    `api/sessions/${sessionId}`,
    'Bridge raw session detail received'
  )
}

async function fetchRawSessionMessages(
  request: IncomingMessage,
  payload: Pick<BridgeTokenPayload, 'hermesAgentId' | 'deviceId'>,
  _decodedSessionId: string,
  sessionId: string,
  _url: URL
): Promise<RawSessionFetch> {
  return fetchRawSessionPath(
    request,
    payload,
    `api/sessions/${sessionId}/messages`,
    'Bridge raw session messages received'
  )
}

async function handleBridgeRawSession(
  request: IncomingMessage,
  response: ServerResponse,
  payload: Pick<BridgeTokenPayload, 'hermesAgentId' | 'deviceId'>,
  url: URL,
  rawSessionId: string
): Promise<void> {
  const decodedSessionId = decodeURIComponent(rawSessionId)
  const sessionId = encodeURIComponent(sessionReadTarget(payload.hermesAgentId, decodedSessionId))
  const startedAt = Date.now()
  logRouter('info', 'Bridge raw session export requested', {
    sessionId: decodedSessionId,
    hasProfile: Boolean((url.searchParams.get('profile') || '').trim())
  })
  const sessionFetch = await fetchRawSessionDetail(request, payload, sessionId, url)
  const messagesFetch = await fetchRawSessionMessages(request, payload, decodedSessionId, sessionId, url)
  const upstreamStatus = {
    session: sessionFetch.status,
    messages: messagesFetch.status
  }
  const upstreamPaths = {
    session: sessionFetch.path,
    messages: messagesFetch.path
  }
  const upstreamVia = {
    session: sessionFetch.via,
    messages: messagesFetch.via
  }
  if (!isUpstreamOk(sessionFetch) || !isUpstreamOk(messagesFetch)) {
    logRouter('warn', 'Bridge raw session export failed', {
      sessionId: decodedSessionId,
      latencyMs: elapsedMs(startedAt),
      upstreamStatus
    })
    sendJson(response, !isUpstreamOk(sessionFetch) ? sessionFetch.status : messagesFetch.status, {
      export_type: 'hermes_hub_raw_session',
      source: 'bridge-raw-session',
      raw_source: 'hermes-api-server',
      error: 'Raw session export failed',
      session_id: decodedSessionId,
      exported_at: new Date().toISOString(),
      upstream_status: upstreamStatus,
      upstream_paths: upstreamPaths,
      upstream_via: upstreamVia,
      attempts: {
        session: sessionFetch.attempts,
        messages: messagesFetch.attempts
      },
      raw: {
        session: sessionFetch.payload,
        messages: messagesFetch.payload
      }
    })
    return
  }

  sendJson(response, 200, {
    export_type: 'hermes_hub_raw_session',
    source: 'bridge-raw-session',
    raw_source: 'hermes-api-server',
    session_id: decodedSessionId,
    exported_at: new Date().toISOString(),
    safety_note:
      'Raw session export fetched by Router through the paired Hermes Hub Gateway. ' +
      'Router preserves the upstream session and messages payloads in raw.* and does not apply local session metadata projection or top-level transcript expansion.',
    upstream_paths: upstreamPaths,
    upstream_status: upstreamStatus,
    upstream_via: upstreamVia,
    attempts: {
      session: sessionFetch.attempts,
      messages: messagesFetch.attempts
    },
    raw: {
      session: sessionFetch.payload,
      messages: messagesFetch.payload
    }
  })
  logRouter('info', 'Bridge raw session export completed', {
    sessionId: decodedSessionId,
    latencyMs: elapsedMs(startedAt),
    upstreamStatus
  })
}

async function handleBridgeDeleteSession(
  request: IncomingMessage,
  response: ServerResponse,
  payload: Pick<BridgeTokenPayload, 'hermesAgentId' | 'deviceId'>,
  url: URL,
  rawSessionId: string
): Promise<void> {
  const clientSessionId = decodeURIComponent(rawSessionId)
  const hermesSessionId = sessionReadTarget(payload.hermesAgentId, clientSessionId)
  const sessionId = encodeURIComponent(hermesSessionId)
  const profile = (url.searchParams.get('profile') || '').trim()
  const profileQuery = profile ? `?profile=${encodeURIComponent(profile)}` : ''
  const startedAt = Date.now()
  logRouter('warn', 'Bridge session delete requested', {
    sessionId: clientSessionId,
    hasProfile: Boolean(profile)
  })
  const proxied = await proxyViaGateway(
    payload,
    `api/sessions/${sessionId}${profileQuery}`,
    { method: 'DELETE', sourceHeaders: request.headers }
  )
  logRouter(statusLevel(proxiedStatus(proxied)), 'Bridge session delete completed', {
    ...proxiedLogContext(proxied, undefined, startedAt),
    sessionId: clientSessionId
  })
  if (proxiedStatus(proxied) >= 200 && proxiedStatus(proxied) < 300) {
    try {
      sessionMetadataStore.delete(payload.hermesAgentId, clientSessionId)
    } catch (error) {
      logRouter(
        'warn',
        'Bridge session metadata cleanup failed after upstream delete',
        { sessionId: clientSessionId },
        error
      )
    }
  }
  sendGatewayResponse(response, proxied.response)
}

function projectNativeSessionMutationPayload(
  payload: unknown,
  conversationId: string,
  hermesSessionId: string,
): unknown {
  const record = asRecord(payload)
  if (!record) return payload
  const nested = asRecord(record.session) || asRecord(record.data)
  const source = nested || record
  const session = {
    ...source,
    id: conversationId,
    session_id: conversationId,
    conversation_id: conversationId,
    hermes_session_id: hermesSessionId,
    native: true,
    readOnly: false,
    read_only: false,
  }
  return nested ? { ...record, session, data: session } : { session, data: session }
}

async function handleBridgeRenameSession(
  request: IncomingMessage,
  response: ServerResponse,
  payload: Pick<BridgeTokenPayload, 'hermesAgentId' | 'deviceId'>,
  url: URL,
  rawSessionId: string,
): Promise<void> {
  const clientSessionId = decodeURIComponent(rawSessionId)
  const hermesSessionId = sessionReadTarget(payload.hermesAgentId, clientSessionId)
  const input = await readJson(request)
  const title = typeof input.title === 'string' ? input.title.trim() : ''
  if (!title) {
    sendJson(response, 400, { error: 'Session title is required', code: 'validation_error' })
    return
  }
  const profile = (url.searchParams.get('profile') || '').trim()
  const profileQuery = profile ? `?profile=${encodeURIComponent(profile)}` : ''
  const startedAt = Date.now()
  logRouter('info', 'Bridge session rename requested', {
    sessionId: clientSessionId,
    hasProfile: Boolean(profile),
  })
  const proxied = await proxyViaGateway(payload, `api/sessions/${encodeURIComponent(hermesSessionId)}${profileQuery}`, {
    method: 'PATCH',
    body: Buffer.from(JSON.stringify({ title }), 'utf8'),
    contentType: 'application/json',
    sourceHeaders: request.headers,
  })
  const status = proxiedStatus(proxied)
  logRouter(statusLevel(status), 'Bridge session rename completed', {
    ...proxiedLogContext(proxied, undefined, startedAt),
    sessionId: clientSessionId,
  })
  if (status >= 200 && status < 300) {
    const conversation = nativeConversationStore.getByConversationId(payload.hermesAgentId, clientSessionId)
    const responsePayload = conversation
      ? projectNativeSessionMutationPayload(jsonPayloadFromProxied(proxied), clientSessionId, hermesSessionId)
      : sessionMetadataStore.applyToPayload(payload.hermesAgentId, jsonPayloadFromProxied(proxied))
    sendJson(response, status, responsePayload)
    return
  }
  sendGatewayResponse(response, proxied.response)
}

function normalizeForkSessionPayload(payload: unknown, profile: string): unknown {
  const data = asRecord(payload)
  if (!data) return payload
  const nested = asRecord(data.session)
  if (nested) {
    return {
      ...data,
      session: profile && typeof nested.profile !== 'string'
        ? { ...nested, profile }
        : nested
    }
  }
  const sessionId = typeof data.id === 'string'
    ? data.id
    : typeof data.session_id === 'string'
      ? data.session_id
      : ''
  if (!sessionId) return data
  const session = {
    ...data,
    id: sessionId,
    ...(profile && typeof data.profile !== 'string' ? { profile } : {})
  }
  return { ...session, session }
}

async function handleBridgeForkSession(
  request: IncomingMessage,
  response: ServerResponse,
  payload: Pick<BridgeTokenPayload, 'hermesAgentId' | 'deviceId'>,
  url: URL,
  rawSessionId: string
): Promise<void> {
  const sourceConversationId = decodeURIComponent(rawSessionId)
  const sourceSessionId = sessionReadTarget(payload.hermesAgentId, sourceConversationId)
  const sessionId = encodeURIComponent(sourceSessionId)
  const profile = (url.searchParams.get('profile') || '').trim()
  const profileQuery = profile ? `?profile=${encodeURIComponent(profile)}` : ''
  const input = parseJsonBuffer(await readBody(request))
  const forkInput = input && typeof input === 'object' && !Array.isArray(input)
    ? input as Record<string, unknown>
    : {}
  const startedAt = Date.now()
  logRouter('info', 'Bridge session fork requested', {
    sourceSessionId,
    hasProfile: Boolean(profile)
  })
  const proxied = await proxyViaGateway(
    payload,
    `api/sessions/${sessionId}/fork${profileQuery}`,
    {
      method: 'POST',
      body: Buffer.from(JSON.stringify(forkInput), 'utf8'),
      contentType: 'application/json',
      sourceHeaders: request.headers
    }
  )
  const status = proxiedStatus(proxied)
  logRouter(statusLevel(status), 'Bridge session fork completed', {
    ...proxiedLogContext(proxied, undefined, startedAt),
    sourceSessionId
  })
  if (status >= 200 && status < 300) {
    const normalized = normalizeForkSessionPayload(jsonPayloadFromProxied(proxied), profile)
    const forkedSessionId = sessionIdFromBody(Buffer.from(JSON.stringify(normalized), 'utf8'))
    if (forkedSessionId) {
      sessionMetadataStore.copy(payload.hermesAgentId, sourceConversationId, forkedSessionId)
    }
    sendJson(
      response,
      status,
      sessionMetadataStore.applyToPayload(payload.hermesAgentId, normalized),
    )
  } else {
    sendGatewayResponse(response, proxied.response)
  }
}

async function handleBridgeArchiveSession(
  request: IncomingMessage,
  response: ServerResponse,
  payload: Pick<BridgeTokenPayload, 'hermesAgentId' | 'deviceId'>,
  url: URL,
  rawSessionId: string,
  archived: boolean
): Promise<void> {
  const clientSessionId = decodeURIComponent(rawSessionId)
  const hermesSessionId = sessionReadTarget(payload.hermesAgentId, clientSessionId)
  const sessionId = encodeURIComponent(hermesSessionId)
  const profile = (url.searchParams.get('profile') || '').trim()
  const profileQuery = profile ? `?profile=${encodeURIComponent(profile)}` : ''
  const startedAt = Date.now()
  logRouter('info', 'Bridge session archive update requested', {
    sessionId: clientSessionId,
    archived,
    hasProfile: Boolean(profile)
  })
  const proxied = await proxyViaGateway(
    payload,
    `api/sessions/${sessionId}${profileQuery}`,
    {
      method: 'PATCH',
      body: Buffer.from(JSON.stringify({ archived }), 'utf8'),
      contentType: 'application/json',
      sourceHeaders: request.headers
    }
  )
  logRouter(statusLevel(proxiedStatus(proxied)), 'Bridge session archive update completed', {
    ...proxiedLogContext(proxied, undefined, startedAt),
    sessionId: clientSessionId,
    archived
  })
  sendGatewayResponse(response, proxied.response)
}

async function handleBridgeBootstrap(request: IncomingMessage, response: ServerResponse, payload: Pick<BridgeTokenPayload, 'hermesAgentId' | 'deviceId'>, url: URL): Promise<void> {
  const query = normalizeBootstrapQuery(url)
  const bootstrapStartedAt = Date.now()
  const bootstrapRequestId = requestId('bootstrap')
  logRouter('info', 'Bridge bootstrap received', {
    requestId: bootstrapRequestId,
    limit: query.limit,
    hasActiveSessionId: Boolean(query.activeSessionId),
    hermesAgentId: selectedHermesAgentId(payload)
  })
  const sessions = await proxyViaGateway(payload, `api/sessions?limit=${encodeURIComponent(String(query.limit))}`, { sourceHeaders: request.headers })
  const sessionsJson = parseJsonBuffer(projectSessionList(
    payload.hermesAgentId,
    applySessionMetadataToBody(
      payload.hermesAgentId,
      Buffer.from(sessions.response.bodyBase64 || '', 'base64'),
    ),
  ))
  logRouter(statusLevel(proxiedStatus(sessions)), 'Bridge sessions received for bootstrap', {
    ...proxiedLogContext(sessions, bootstrapRequestId, bootstrapStartedAt),
    hasSessionsPayload: Boolean(sessionsJson)
  })
  let messagesJson: unknown = null
  let messagesStatus: number | undefined
  if (query.activeSessionId) {
    const sessionId = encodeURIComponent(sessionReadTarget(payload.hermesAgentId, query.activeSessionId))
    const messages = await proxyViaGateway(payload, `api/sessions/${sessionId}/messages`, { sourceHeaders: request.headers })
    messagesStatus = proxiedStatus(messages)
    messagesJson = jsonPayloadFromProxied(messages)
    logRouter(statusLevel(messagesStatus), 'Bridge active session messages received for bootstrap', {
      ...proxiedLogContext(messages, bootstrapRequestId, bootstrapStartedAt),
      sessionId: query.activeSessionId,
      hasMessagesPayload: Boolean(messagesJson)
    })
  }
  const models = await proxyModelOptionsViaGateway(payload, '', request.headers, bootstrapRequestId).catch(error => ({ error: error instanceof Error ? error.message : String(error) }))
  if ('error' in models) {
    logRouter('warn', 'Bridge model options hint failed during bootstrap', {
      requestId: bootstrapRequestId,
      error: models.error
    })
  }
  const modelHint = 'error' in models
    ? { available: false, error: models.error, fetchedAt: Date.now() }
    : {
        available: proxiedStatus(models.proxied) >= 200 && proxiedStatus(models.proxied) < 400,
        status: proxiedStatus(models.proxied),
        via: models.proxied.via,
        fetchedAt: Date.now(),
        upstreamPath: logPath(models.path),
        data: jsonPayloadFromProxied(models.proxied)
      }
  const hermesAgentId = selectedHermesAgentId(payload)
  sendJson(response, 200, {
    sessions: sessionsJson && typeof sessionsJson === 'object' && !Array.isArray(sessionsJson) && 'sessions' in sessionsJson ? (sessionsJson as { sessions?: unknown }).sessions : sessionsJson,
    activeSessionMessages: messagesJson && typeof messagesJson === 'object' && !Array.isArray(messagesJson) && 'messages' in messagesJson ? (messagesJson as { messages?: unknown }).messages : messagesJson,
    activeSessionId: query.activeSessionId,
    gatewaySummary: {
      hermesAgentId,
    },
    modelOptionsCacheHint: modelHint,
    serverTimestamp: Math.floor(Date.now() / 1000),
    upstreamStatus: { sessions: proxiedStatus(sessions), messages: messagesStatus },
    metrics: proxiedMetrics(sessions, bootstrapRequestId, bootstrapStartedAt)
  })
  logRouter('info', 'Bridge bootstrap completed', {
    requestId: bootstrapRequestId,
    latencyMs: elapsedMs(bootstrapStartedAt),
    sessionsStatus: proxiedStatus(sessions),
    messagesStatus,
    hermesAgentId
  })
}

function publishConversationResync(
  hermesAgentId: string,
  conversationId: string,
  sessionId: string | undefined,
  submissionId: string | undefined,
  reason: string,
): void {
  clientEventHub.publish({
    scope: `hermes-agent:${hermesAgentId}`,
    conversationId,
    sessionId,
    submissionId,
    event: 'session.resync_required',
    data: { reason },
  })
}

async function handleNativeSessionMessage(
  request: IncomingMessage,
  response: ServerResponse,
  payload: BridgeTokenPayload,
): Promise<void> {
  requireGatewayBoundBridge(payload)
  const input = await readJson(request)
  const submissionId = typeof input.submissionId === 'string' ? input.submissionId.trim() : ''
  const conversationId = typeof input.conversationId === 'string' && input.conversationId.trim()
    ? input.conversationId.trim()
    : undefined
  const text = typeof input.text === 'string' ? input.text : ''
  const attachmentIds = Array.isArray(input.attachmentIds)
    ? input.attachmentIds
    : []
  if (!/^sub_[A-Za-z0-9._:-]{8,191}$/.test(submissionId)) {
    throw Object.assign(new Error('submissionId is invalid'), { code: 'validation_error', statusCode: 400 })
  }
  if (attachmentIds.length > 10 || attachmentIds.some(id => typeof id !== 'string' || !/^att_[A-Za-z0-9._:-]{8,191}$/.test(id))) {
    throw Object.assign(new Error('attachmentIds is invalid'), { code: 'validation_error', statusCode: 400 })
  }
  if (new Set(attachmentIds).size !== attachmentIds.length) {
    throw Object.assign(new Error('attachmentIds contains duplicates'), { code: 'validation_error', statusCode: 400 })
  }
  if (!text.trim() && attachmentIds.length === 0) {
    throw Object.assign(new Error('text or attachment is required'), { code: 'validation_error', statusCode: 400 })
  }
  if (Buffer.byteLength(text, 'utf8') > 1024 * 1024) {
    throw Object.assign(new Error('Session message is too large'), { code: 'body_too_large', statusCode: 413 })
  }

  const begun = nativeConversationStore.beginSubmission(
    payload.hermesAgentId,
    submissionId,
    conversationId,
  )
  if (begun.duplicate) {
    if (begun.submission.state === 'accepted' && begun.submission.sessionId) {
      sendJson(response, 202, {
        accepted: true,
        submissionId,
        conversationId: begun.conversation.conversationId,
        sessionId: begun.submission.sessionId,
        idempotent: true,
      })
      return
    }
    publishConversationResync(
      payload.hermesAgentId,
      begun.conversation.conversationId,
      begun.conversation.sessionId,
      submissionId,
      `submission_${begun.submission.state}`,
    )
    throw Object.assign(new Error('Native submission outcome is ambiguous and will not be resent'), {
      code: 'submission_ambiguous',
      statusCode: 409,
    })
  }

  try {
    const acknowledgement = await gatewayRegistry.submitSessionByAgentId(
      payload.hermesAgentId,
      {
        laneId: begun.conversation.laneId,
        submissionId,
        text,
        deviceId: payload.deviceId,
        attachmentIds,
      },
      10_000,
    )
    if (!acknowledgement.accepted || !acknowledgement.sessionId) {
      const code = acknowledgement.code || 'native_submission_rejected'
      nativeConversationStore.updateSubmission(payload.hermesAgentId, submissionId, 'failed', { errorCode: code })
      throw Object.assign(new Error(acknowledgement.error || 'Gateway rejected native session submission'), {
        code,
        statusCode: code === 'submission_conflict' ? 409 : 502,
      })
    }
    const accepted = nativeConversationStore.updateSubmission(
      payload.hermesAgentId,
      submissionId,
      'accepted',
      { sessionId: acknowledgement.sessionId },
    )
    clientEventHub.publish({
      scope: bridgeClientEventScope(payload),
      conversationId: accepted.conversationId,
      sessionId: accepted.sessionId,
      submissionId,
      event: 'submission.accepted',
      data: { accepted: true },
    })
    sendJson(response, 202, {
      accepted: true,
      submissionId,
      conversationId: accepted.conversationId,
      sessionId: accepted.sessionId,
    })
  } catch (error) {
    const code = typeof (error as { code?: unknown }).code === 'string'
      ? (error as { code: string }).code
      : 'native_submission_failed'
    if (code === 'gateway_submission_ambiguous') {
      const ambiguous = nativeConversationStore.updateSubmission(
        payload.hermesAgentId,
        submissionId,
        'ambiguous',
        { errorCode: code },
      )
      publishConversationResync(
        payload.hermesAgentId,
        ambiguous.conversationId,
        ambiguous.sessionId,
        submissionId,
        'gateway_submission_ambiguous',
      )
      throw Object.assign(new Error('Gateway submission outcome is ambiguous and will not be resent'), {
        code: 'submission_ambiguous',
        statusCode: 409,
      })
    }
    if (nativeConversationStore.getSubmission(payload.hermesAgentId, submissionId)?.state === 'pending') {
      nativeConversationStore.updateSubmission(payload.hermesAgentId, submissionId, 'failed', { errorCode: code })
    }
    throw error
  }
}

function attachmentDataUrl(input: Record<string, unknown>): {
  filename: string
  mimeType: string
  dataBase64: string
} {
  const filename = typeof input.path === 'string' ? input.path.trim() : ''
  const dataUrl = typeof input.data_url === 'string' ? input.data_url.trim() : ''
  if (!filename || filename.length > 255 || /[\\/\x00]/.test(filename)) {
    throw Object.assign(new Error('Attachment filename is invalid'), { code: 'validation_error', statusCode: 400 })
  }
  const match = dataUrl.match(/^data:([A-Za-z0-9!#$&^_.+\-]+\/[A-Za-z0-9!#$&^_.+\-]+);base64,([A-Za-z0-9+/]*={0,2})$/)
  if (!match || match[2].length === 0 || match[2].length % 4 !== 0) {
    throw Object.assign(new Error('Attachment data must be a base64 data URL'), { code: 'validation_error', statusCode: 400 })
  }
  const decodedBytes = (match[2].length / 4) * 3 - (match[2].endsWith('==') ? 2 : match[2].endsWith('=') ? 1 : 0)
  if (decodedBytes <= 0 || decodedBytes > 12 * 1024 * 1024) {
    throw Object.assign(new Error('Attachment is too large'), { code: 'attachment_too_large', statusCode: 413 })
  }
  return { filename, mimeType: match[1].toLowerCase(), dataBase64: match[2] }
}

async function handleBridgeAttachmentUpload(
  request: IncomingMessage,
  response: ServerResponse,
  payload: BridgeTokenPayload,
  pathname: string,
): Promise<boolean> {
  if (pathname !== '/bridge/attachments') return false
  if (request.method !== 'POST') {
    sendJson(response, 405, { error: 'Attachment endpoint requires POST', code: 'method_not_allowed' })
    return true
  }
  requireGatewayBoundBridge(payload)
  const input = attachmentDataUrl(await readAttachmentJson(request))
  const attachmentId = `att_${randomUUID()}`
  const proxied = await proxyViaGateway(payload, '/api/ws', {
    method: 'POST',
    body: gatewayRpcBody('attachment.stage', {
      attachmentId,
      deviceId: payload.deviceId,
      filename: input.filename,
      mimeType: input.mimeType,
      dataBase64: input.dataBase64,
    }),
    contentType: 'application/json',
    timeoutMs: 30_000,
    sourceHeaders: request.headers,
  })
  const status = proxiedStatus(proxied)
  if (status < 200 || status >= 300) {
    sendJson(response, status, { error: 'Attachment staging failed', code: 'attachment_stage_failed' })
    return true
  }
  const result = jsonPayloadFromProxied(proxied)
  const attachment = result && typeof result === 'object' && !Array.isArray(result)
    ? (result as Record<string, unknown>).attachment
    : undefined
  if (!attachment || typeof attachment !== 'object' || Array.isArray(attachment)) {
    throw Object.assign(new Error('Gateway returned an invalid attachment reference'), { code: 'invalid_upstream_response', statusCode: 502 })
  }
  sendJson(response, 201, { attachment })
  return true
}

async function handleNativePromptResponse(
  request: IncomingMessage,
  response: ServerResponse,
  payload: BridgeTokenPayload,
  rawPromptId: string,
): Promise<void> {
  requireGatewayBoundBridge(payload)
  const promptId = decodeURIComponent(rawPromptId)
  const input = await readJson(request)
  const responseText = typeof input.response === 'string' ? input.response : ''
  const pending = nativeConversationStore.pendingPrompt(payload.hermesAgentId, promptId)
  if (!pending) {
    throw Object.assign(new Error('Native prompt is not pending for this Agent'), {
      code: 'prompt_not_pending',
      statusCode: 409,
    })
  }
  if (!responseText.trim()) {
    throw Object.assign(new Error('response is required'), { code: 'validation_error', statusCode: 400 })
  }
  const requestedConversationId = typeof input.conversationId === 'string' ? input.conversationId.trim() : ''
  if (requestedConversationId && requestedConversationId !== pending.conversationId) {
    throw Object.assign(new Error('Prompt conversation does not match'), {
      code: 'prompt_scope_mismatch',
      statusCode: 409,
    })
  }
  try {
    const acknowledgement = await gatewayRegistry.respondPromptByAgentId(
      payload.hermesAgentId,
      { laneId: pending.laneId, promptId, response: responseText },
      10_000,
    )
    if (!acknowledgement.accepted) {
      throw Object.assign(new Error(acknowledgement.error || 'Gateway rejected native prompt response'), {
        code: acknowledgement.code || 'prompt_not_pending',
        statusCode: 409,
      })
    }
    nativeConversationStore.resolvePrompt(payload.hermesAgentId, promptId)
    sendJson(response, 202, {
      accepted: true,
      promptId,
      conversationId: pending.conversationId,
      sessionId: pending.sessionId,
    })
  } catch (error) {
    const code = typeof (error as { code?: unknown }).code === 'string'
      ? (error as { code: string }).code
      : ''
    if (code === 'gateway_submission_ambiguous') {
      publishConversationResync(
        payload.hermesAgentId,
        pending.conversationId,
        pending.sessionId,
        undefined,
        'gateway_prompt_response_ambiguous',
      )
      throw Object.assign(new Error('Prompt response outcome is ambiguous and will not be resent'), {
        code: 'prompt_response_ambiguous',
        statusCode: 409,
      })
    }
    throw error
  }
}

async function handleRouter(request: IncomingMessage, response: ServerResponse, pathname: string, url: URL): Promise<boolean> {
  if (pathname === '/router/health') {
    const gateways = gatewayRegistry.list()
    const onlineAgents = new Set(gateways.filter(item => item.routable).map(item => item.hermesAgentId))
    logRouter('debug', 'Router health requested', {
      gatewayCount: gateways.length,
      gatewayOnlineCount: gateways.filter(item => item.online).length,
      hermesAgentCount: new Set(gateways.map(item => item.hermesAgentId)).size,
      hermesAgentOnlineCount: onlineAgents.size,
      debugGatewayEnabled: Boolean(debugGateway),
    })
    sendJson(response, 200, {
      ok: true,
      service: 'hermes-hub-router',
      routerUrl,
      topology: 'client-router-hermes-hub-gateway-agent',
      gateways: gateways.length,
      gatewaysOnline: gateways.filter(item => item.online).length,
      hermesAgents: new Set(gateways.map(item => item.hermesAgentId)).size,
      hermesAgentsOnline: onlineAgents.size,
      pairing: 'prompt-code-claim/v2',
      gatewayPlugin: {
        skillsRepositoryUrl: gatewayPluginRepositoryUrl,
        npmPackage: gatewayPluginNpmPackage,
        release: {
          ...gatewayPluginReleaseArtifact,
        },
      },
      debugGateway: { enabled: Boolean(debugGateway) },
    })
    return true
  }

  if (pathname === '/router/heartbeat' && request.method === 'GET') {
    const bridgeToken = bearerToken(request.headers.authorization)
    let hermesAgentId: string
    if (bridgeToken) {
      hermesAgentId = verifyBridgeToken(bridgeToken, config).hermesAgentId
    } else {
      requireOperatorApproval(request)
      hermesAgentId = (url.searchParams.get('hermesAgentId') || '').trim()
      if (!/^[A-Za-z0-9._:-]{3,160}$/.test(hermesAgentId)) {
        throw Object.assign(new Error('Operator heartbeat requires a valid hermesAgentId'), {
          statusCode: 400,
          code: 'hermes_agent_id_invalid'
        })
      }
    }
    const startedAt = Date.now()
    const gateway = await hermesGateways.heartbeat(hermesAgentId, 3000).catch(error => ({
      ok: false,
      gatewayId: undefined,
      hermesAgentId,
      gatewayConnectionId: undefined,
      online: false,
      latencyMs: undefined,
      lastSeenAt: undefined,
      error: error instanceof Error ? error.message : String(error)
    }))
    logRouter(gateway.online ? 'info' : 'warn', 'Router heartbeat checked', {
      hermesAgentId: gateway.hermesAgentId || hermesAgentId,
      gatewayId: gateway.gatewayId,
      gatewayOnline: gateway.online,
      gatewayLatencyMs: gateway.latencyMs,
      routerLatencyMs: Date.now() - startedAt,
      gatewayError: gateway.error,
    })
    sendJson(response, 200, {
      ok: true,
      service: 'hermes-hub-router',
      routerUrl,
      checkedAt: Math.floor(Date.now() / 1000),
      router: { ok: true, latencyMs: Date.now() - startedAt },
      gateway: {
        ok: gateway.ok,
        hermesAgentId,
        online: gateway.online,
        latencyMs: gateway.latencyMs,
        lastSeenAt: gateway.lastSeenAt,
        error: gateway.error,
      },
    })
    return true
  }

  if (pathname === '/router/pairing/request' && request.method === 'POST') {
    assertPairingRateAllowed(request, 'request')
    const input = await readJson(request)
    const created = pairingStore.create(input)
    logRouter('info', 'Pairing request created', {
      requestId: created.requestId,
      status: created.status,
      user: created.user,
      deviceName: created.deviceName,
      debugGatewayEnabled: Boolean(debugGateway)
    })
    if (debugGateway) {
      pairingStore.approve(created.requestId, {
        codeGenerator: () => debugGateway.pairingCode,
        hermesAgentId: debugGateway.hermesAgentId,
        gatewayId: debugGateway.gatewayId,
        gatewayToken: debugGateway.gatewayToken,
      })
      sendJson(response, 200, pairingStore.get(created.requestId) || created)
    } else {
      sendJson(response, 200, created)
    }
    return true
  }

  if (pathname === '/router/pairing/local-approval-bootstrap' && request.method === 'POST') {
    synchronizeLocalApprovalConfiguration(request)
    logRouter('info', 'Local Gateway approval configuration synchronized', {
      source: 'loopback-cli',
    })
    response.writeHead(204)
    response.end()
    return true
  }

  if (pathname === '/router/diagnostics' && request.method === 'POST') {
    const payload = requirePayload(request)
    const input = await readJson(request)
    try {
      const report = await persistDiagnostics(payload, input)
      sendJson(response, 200, report)
    } catch (error) {
      if (!(error instanceof DiagnosticsPayloadError)) throw error
      logRouter('warn', 'Diagnostics report rejected', {
        code: error.code,
        status: error.statusCode,
        submittedEntryCount: Array.isArray(input.entries) ? input.entries.length : undefined
      })
      sendJson(response, error.statusCode, { error: error.message, code: error.code })
    }
    return true
  }

  const diagnosticsMatch = pathname.match(/^\/router\/diagnostics\/(diag_[a-z0-9_-]+)$/i)
  if (diagnosticsMatch && request.method === 'GET') {
    requireDiagnosticsReadApproval(request)
    sendJson(response, 200, await readDiagnostics(decodeURIComponent(diagnosticsMatch[1])))
    return true
  }

  if (pathname === '/router/pairing/approve' && request.method === 'POST') {
    requireAgentApproval(request)
    const input = await readJson(request)
    const requestId = typeof input.requestId === 'string' ? input.requestId : ''
    const approval = debugGateway
      ? pairingStore.approve(requestId, {
        codeGenerator: () => debugGateway.pairingCode,
        hermesAgentId: debugGateway.hermesAgentId,
        gatewayId: debugGateway.gatewayId,
        gatewayToken: debugGateway.gatewayToken,
      })
      : pairingStore.approve(requestId, {
        hermesAgentId: typeof input.hermesAgentId === 'string' ? input.hermesAgentId : undefined,
        gatewayId: typeof input.gatewayId === 'string' ? input.gatewayId : undefined,
        gatewayToken: typeof input.gatewayToken === 'string' ? input.gatewayToken : undefined,
      })
    logRouter('info', 'Pairing request approved', {
      requestId: approval.requestId,
      hermesAgentId: approval.hermesAgentId,
      gatewayId: approval.gatewayId,
      expiresAt: approval.expiresAt,
      debugGatewayEnabled: Boolean(debugGateway),
    })
    sendJson(response, 200, {
      requestId: approval.requestId,
      randomCode: approval.randomCode,
      expiresAt: approval.expiresAt,
      hermesAgentId: approval.hermesAgentId,
      gatewayId: approval.gatewayId,
      gatewayStreamPath: approval.gatewayStreamPath,
      messageForUser: approval.randomCode
    })
    return true
  }

  if (pathname === '/router/pairing/enroll' && request.method === 'POST') {
    // Remote Gateways receive only a short-lived, request-bound enrollment
    // capability. Browser callers and the long-lived Router operator token are
    // deliberately excluded from this path.
    if (headerValue(request, 'origin')) {
      throw Object.assign(new Error('Gateway enrollment is not available to browser origins'), {
        statusCode: 403,
        code: 'gateway_enrollment_browser_forbidden',
      })
    }
    assertPairingRateAllowed(request, 'request')
    const input = await readJson(request)
    const enrollmentTicket = headerValue(request, 'x-hermes-hub-gateway-enrollment')
    const requestId = typeof input.requestId === 'string' ? input.requestId : ''
    const approval = pairingStore.enroll(requestId, enrollmentTicket, {
      hermesAgentId: typeof input.hermesAgentId === 'string' ? input.hermesAgentId : undefined,
      gatewayId: typeof input.gatewayId === 'string' ? input.gatewayId : undefined,
      gatewayToken: typeof input.gatewayToken === 'string' ? input.gatewayToken : undefined,
    })
    logRouter('info', 'Gateway enrollment accepted', {
      requestId: approval.requestId,
      hermesAgentId: approval.hermesAgentId,
      gatewayId: approval.gatewayId,
      expiresAt: approval.expiresAt,
    })
    sendJson(response, 200, {
      requestId: approval.requestId,
      randomCode: approval.randomCode,
      expiresAt: approval.expiresAt,
      hermesAgentId: approval.hermesAgentId,
      gatewayId: approval.gatewayId,
      gatewayStreamPath: approval.gatewayStreamPath,
      messageForUser: approval.randomCode,
    })
    return true
  }

  if (pathname === '/router/pairing/claim' && request.method === 'POST') {
    assertPairingRateAllowed(request, 'claim')
    const input = await readJson(request)
    const requestId = typeof input.requestId === 'string' ? input.requestId.trim() : ''
    if (!requestId) {
      throw Object.assign(new Error('Pairing claim requires requestId'), {
        statusCode: 400,
        code: 'pairing_request_id_required',
      })
    }
    const code = typeof input.code === 'string' ? input.code.replace(/\D/g, '').slice(0, 8) : ''
    let activationReservation: GatewayActivationReservation | undefined
    const reserveGatewayActivation = (claim: PairingClaim, gatewayId: string): void => {
      try {
        activationReservation = gatewayRegistry.reserveCredentialActivation(claim.hermesAgentId, gatewayId)
      } catch (error) {
        throw Object.assign(
          error instanceof Error ? error : new Error(String(error)),
          { statusCode: 503, code: 'gateway_activation_retry' },
        )
      }
    }
    if (debugGateway && code === debugGateway.pairingCode && pairingStore.get(requestId)?.status === 'pending') {
      pairingStore.approve(requestId, {
        codeGenerator: () => debugGateway.pairingCode,
        hermesAgentId: debugGateway.hermesAgentId,
        gatewayId: debugGateway.gatewayId,
        gatewayToken: debugGateway.gatewayToken,
      })
    }
    const claimed = pairingStore.claim(requestId, code, reserveGatewayActivation)
    if (!activationReservation) {
      throw Object.assign(new Error('Gateway activation reservation was not created'), {
        statusCode: 503,
        code: 'gateway_activation_retry',
      })
    }
    const activation = gatewayRegistry.synchronizeCredentialActivation(activationReservation)
    if (!activation.activated || !activation.gateway) {
      throw Object.assign(new Error('Gateway connection changed during credential activation; retry this pairing claim'), {
        statusCode: 503,
        code: 'gateway_activation_retry',
      })
    }
    const activatedGateway = activation.gateway
    const token = issueBridgeToken({
      user: claimed.user,
      pairingCode: config.pairingCode,
      deviceId: claimed.deviceId,
      hermesAgentId: claimed.hermesAgentId,
      capabilities: claimed.capabilities
    }, config, claimed.claimedAt, claimed.bridgeTokenId)
    logRouter('info', 'Pairing request claimed', {
      requestId: claimed.requestId,
      hermesAgentId: claimed.hermesAgentId,
      gatewayId: claimed.gatewayId,
      gatewayConnectionId: activatedGateway.gatewayConnectionId,
      recovered: claimed.recovered,
      credentialRotated: claimed.credentialRotated,
      quarantinedGatewayCount: activation.quarantinedGatewayIds.length,
      user: claimed.user
    })
    sendJson(response, 200, {
      token,
      tokenType: 'Bearer',
      expiresIn: config.tokenTtlSeconds,
      hermesAgentId: claimed.hermesAgentId,
      requestId: claimed.requestId,
      user: claimed.user,
      status: 'paired'
    })
    return true
  }

  const pairingGatewayStatusMatch = pathname.match(/^\/router\/pairing\/([^/]+)\/gateway-status$/)
  if (pairingGatewayStatusMatch && request.method === 'GET') {
    const requestId = decodeURIComponent(pairingGatewayStatusMatch[1])
    const gatewayId = headerValue(request, 'x-hermes-hub-gateway-id')
    const token = bearerToken(request.headers.authorization) || ''
    const record = pairingStore.verifyPairingGateway(requestId, gatewayId, token)
    const gateway = gatewayRegistry.get(gatewayId)
    const matchingGateway = gateway?.hermesAgentId === record.hermesAgentId ? gateway : undefined
    const expired = record.expiresAt < Math.floor(Date.now() / 1000)
    sendJson(response, 200, {
      requestId,
      hermesAgentId: record.hermesAgentId,
      gatewayId: record.gatewayId,
      expiresAt: record.expiresAt,
      gatewayCredentialState: expired && record.gatewayCredentialState === 'provisional'
        ? 'expired'
        : record.gatewayCredentialState || 'pending',
      online: Boolean(matchingGateway?.online),
      connectedAt: matchingGateway?.connectedAt,
      protocols: matchingGateway?.protocols || [],
    })
    return true
  }

  const statusMatch = pathname.match(/^\/router\/pairing\/([^/]+)$/)
  if (statusMatch && request.method === 'GET') {
    const record = pairingStore.get(decodeURIComponent(statusMatch[1]))
    logRouter(record ? 'debug' : 'warn', 'Pairing request status read', {
      requestId: decodeURIComponent(statusMatch[1]),
      found: Boolean(record),
      status: record?.status
    })
    if (!record) sendJson(response, 404, { error: 'Pairing request not found' })
    else sendJson(response, 200, record)
    return true
  }

  if (pathname === '/router/hermes-hub-gateways' && request.method === 'GET') {
    requireOperatorApproval(request)
    logRouter('debug', 'Hermes Hub Gateway list requested', {
      gatewayCount: gatewayRegistry.list().length,
    })
    sendJson(response, 200, { gateways: gatewayRegistry.list() })
    return true
  }

  const gatewayMatch = pathname.match(/^\/router\/hermes-hub-gateways\/([^/]+)$/)
  if (gatewayMatch && request.method === 'GET') {
    requireOperatorApproval(request)
    const gatewayId = decodeURIComponent(gatewayMatch[1])
    const state = gatewayRegistry.get(gatewayId)
    logRouter(state ? 'debug' : 'warn', 'Hermes Hub Gateway state requested', {
      gatewayId,
      found: Boolean(state),
      online: state?.online,
    })
    if (!state) sendJson(response, 404, { error: 'Hermes Hub Gateway not found' })
    else sendJson(response, 200, state)
    return true
  }

  return false
}

function setCorsHeaders(request: IncomingMessage, response: ServerResponse): void {
  const configuredOrigin = process.env.HERMES_HUB_CORS_ORIGIN || '*'
  const requestOrigin = Array.isArray(request.headers.origin) ? request.headers.origin[0] : request.headers.origin
  const allowOrigin = configuredOrigin === '*' && requestOrigin ? requestOrigin : configuredOrigin
  response.setHeader('access-control-allow-origin', allowOrigin)
  response.setHeader('access-control-allow-headers', 'authorization, content-type, x-hermes-hub-agent-approval, x-hermes-hub-client-id')
  response.setHeader('access-control-allow-methods', 'GET, POST, PATCH, DELETE, OPTIONS')
  response.setHeader('vary', 'Origin')
  if (allowOrigin !== '*') response.setHeader('access-control-allow-credentials', 'true')
}

async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
  setCorsHeaders(request, response)
  if (request.method === 'OPTIONS') {
    response.writeHead(204)
    response.end()
    return
  }

  const { pathname, search, url } = getPath(request)

  if (await handleRouter(request, response, pathname, url)) return

  if (pathname === '/bridge/health') {
    logRouter('debug', 'Bridge health requested', {
      gatewayOnly: true,
      insecureDevDefaults: config.insecureDevDefaults,
    })
    sendJson(response, 200, {
      ok: true,
      service: 'hermes-hub-bridge',
      topology: 'client-router-hermes-hub-gateway-agent',
      gatewayOnly: true,
      insecureDevDefaults: config.insecureDevDefaults,
      routerUrl
    })
    return
  }

  if (!pathname.startsWith('/bridge/')) {
    logRouter('warn', 'HTTP route not found', { method: request.method, pathname })
    sendJson(response, 404, { error: 'Not found' })
    return
  }

  const payload = requirePayload(request)

  if (pathname === '/bridge/auth/session' && request.method === 'GET') {
    sendJson(response, 200, {
      auth: 'valid',
      deviceId: payload.deviceId,
      hermesAgentId: payload.hermesAgentId,
      expiresAt: payload.exp,
      protocol: 'hermes-hub-bridge/v2',
      routerInstanceId,
    })
    return
  }

  if (pathname === '/bridge/capabilities' && request.method === 'GET') {
    const [cronAvailable, kanbanAvailable] = await Promise.all([
      agentFeatureAvailable(payload, 'cron'),
      agentFeatureAvailable(payload, 'kanban')
    ])
    const sessionResourcesAvailable = gatewayAdvertisesCapability(payload.hermesAgentId, 'sessions')
    sendJson(response, 200, {
      protocol: 'hermes-hub-bridge/v2',
      featureCapabilityContractVersion: AGENT_FEATURE_GATEWAY_CONTRACT_VERSION,
      features: {
        sessions: {
          rename: sessionResourcesAvailable,
          archive: sessionResourcesAvailable,
          delete: sessionResourcesAvailable,
          fork: sessionResourcesAvailable,
          // Hermes treats a session branch as a fork. Message-level `/branch`
          // remains a native session command and is not a Router mutation API.
          branch: sessionResourcesAvailable,
        },
        attachments: {
          // Attachment staging is native Gateway media caching, not a WebUI
          // file API. A pairing token is still required for every upload.
          read: false,
          write: gatewayAdvertisesCapability(payload.hermesAgentId, 'attachments.write'),
        },
        cron: {
          read: cronAvailable && hasAgentFeaturePermission(payload, 'cron', 'read'),
          write: cronAvailable && hasAgentFeaturePermission(payload, 'cron', 'write'),
          execute: cronAvailable && hasAgentFeaturePermission(payload, 'cron', 'execute')
        },
        kanban: {
          read: kanbanAvailable && hasAgentFeaturePermission(payload, 'kanban', 'read'),
          write: kanbanAvailable && hasAgentFeaturePermission(payload, 'kanban', 'write'),
          execute: kanbanAvailable && hasAgentFeaturePermission(payload, 'kanban', 'execute')
        }
      }
    })
    return
  }

  if (await handleCronBridge(request, response, payload, pathname, url)) return
  if (await handleKanbanBridge(request, response, payload, pathname, search)) return
  if (await handleBridgeAttachmentUpload(request, response, payload, pathname)) return

  if (pathname === '/bridge/bootstrap' && request.method === 'GET') {
    await handleBridgeBootstrap(request, response, payload, url)
    return
  }

  if (pathname === '/bridge/chat-run/stream' && request.method === 'POST') {
    sendNativeSessionRequired(response)
    return
  }

  if (pathname === '/bridge/session-messages' && request.method === 'POST') {
    await handleNativeSessionMessage(request, response, payload)
    return
  }

  const promptResponseMatch = pathname.match(/^\/bridge\/session-prompts\/([^/]+)\/responses$/)
  if (promptResponseMatch && request.method === 'POST') {
    await handleNativePromptResponse(request, response, payload, promptResponseMatch[1])
    return
  }

  if (pathname === '/bridge/sessions' && request.method === 'GET') {
    const startedAt = Date.now()
    logRouter('info', 'Bridge sessions list requested', { queryKeys: queryKeys(search) })
    const proxied = await proxyViaGateway(payload, `api/sessions${search}`, { sourceHeaders: request.headers })
    logRouter(statusLevel(proxiedStatus(proxied)), 'Bridge sessions list received', proxiedLogContext(proxied, undefined, startedAt))
    sendGatewaySessionListResponse(response, proxied.response, payload.hermesAgentId)
    return
  }

  if (pathname === '/bridge/sessions' && request.method === 'POST') {
    sendNativeSessionRequired(response)
    return
  }

  const sessionGetMatch = pathname.match(/^\/bridge\/sessions\/([^/]+)$/)
  if (sessionGetMatch && request.method === 'GET') {
    const clientSessionId = decodeURIComponent(sessionGetMatch[1])
    const sessionId = encodeURIComponent(sessionReadTarget(payload.hermesAgentId, clientSessionId))
    const startedAt = Date.now()
    logRouter('info', 'Bridge session detail requested', { sessionId: decodeURIComponent(sessionGetMatch[1]) })
    const proxied = await proxyViaGateway(payload, `api/sessions/${sessionId}`, { sourceHeaders: request.headers })
    logRouter(statusLevel(proxiedStatus(proxied)), 'Bridge session detail received', {
      ...proxiedLogContext(proxied, undefined, startedAt),
      sessionId: decodeURIComponent(sessionGetMatch[1])
    })
    const conversation = nativeConversationStore.getByConversationId(payload.hermesAgentId, clientSessionId)
    const metadataApplied = applySessionMetadataToBody(
      payload.hermesAgentId,
      Buffer.from(proxied.response.bodyBase64 || '', 'base64'),
    )
    sendJson(
      response,
      proxied.response.status,
      projectNativeSessionDetailPayload(
        parseJsonBuffer(metadataApplied),
        conversation,
      ),
    )
    return
  }

  if (sessionGetMatch && request.method === 'PATCH') {
    const input = await readJson(request)
    if (typeof input.archived !== 'boolean' || Object.keys(input).some(key => key !== 'archived')) {
      sendJson(response, 400, {
        error: 'Only the archived session field may be updated through this endpoint',
        code: 'validation_error',
      })
      return
    }
    await handleBridgeArchiveSession(request, response, payload, url, sessionGetMatch[1], input.archived)
    return
  }

  if (sessionGetMatch && request.method === 'DELETE') {
    await handleBridgeDeleteSession(request, response, payload, url, sessionGetMatch[1])
    return
  }

  const sessionActionMatch = pathname.match(/^\/bridge\/sessions\/([^/]+)\/(raw|messages|rename|fork|branch|metadata|model|usage|context|runtime|archive|delete)$/)
  if (sessionActionMatch && request.method === 'GET' && sessionActionMatch[2] === 'raw') {
    await handleBridgeRawSession(request, response, payload, url, sessionActionMatch[1])
    return
  }

  if (sessionActionMatch && request.method === 'GET' && sessionActionMatch[2] === 'runtime') {
    const clientSessionId = decodeURIComponent(sessionActionMatch[1])
    const hermesSessionId = sessionReadTarget(payload.hermesAgentId, clientSessionId)
    const refresh = url.searchParams.get('refresh') === '1'
    let snapshot = refresh
      ? null
      : hermesGateways.cachedRuntimeSnapshot(payload.hermesAgentId, hermesSessionId)
    if (!snapshot || refresh) {
      snapshot = await hermesGateways.runtimeSnapshot(payload.hermesAgentId, {
        sessionId: hermesSessionId,
        timeoutMs: 6_000,
      })
    }
    sendJson(response, 200, {
      ...snapshot.snapshot,
      session_id: clientSessionId,
      hermes_session_id: hermesSessionId,
      cache: {
        stale: snapshot.stale,
        received_at: snapshot.receivedAt,
      },
    })
    return
  }

  if (sessionActionMatch && request.method === 'GET' && sessionActionMatch[2] === 'usage') {
    const rawSessionId = decodeURIComponent(sessionActionMatch[1])
    const sessionId = encodeURIComponent(sessionReadTarget(payload.hermesAgentId, rawSessionId))
    const startedAt = Date.now()
    let proxied = await proxyViaGateway(
      payload,
      `api/session/usage?session_id=${sessionId}`,
      { sourceHeaders: request.headers, timeoutMs: 6_000 }
    )
    if (proxiedStatus(proxied) === 404 || proxiedStatus(proxied) === 405) {
      proxied = await proxyViaGateway(payload, 'api/ws', {
        method: 'POST',
      body: gatewayRpcBody('session.usage', { session_id: decodeURIComponent(sessionId) }, 5_000),
        contentType: 'application/json',
        sourceHeaders: request.headers,
        timeoutMs: 6_000
      })
    }
    logRouter(statusLevel(proxiedStatus(proxied)), 'Bridge session usage received', {
      ...proxiedLogContext(proxied, undefined, startedAt),
      sessionId: rawSessionId
    })
    sendGatewayResponse(response, proxied.response)
    return
  }

  if (sessionActionMatch && request.method === 'GET' && sessionActionMatch[2] === 'context') {
    const clientSessionId = decodeURIComponent(sessionActionMatch[1])
    const sessionId = sessionReadTarget(payload.hermesAgentId, clientSessionId)
    const encodedSessionId = encodeURIComponent(sessionId)
    const startedAt = Date.now()
    const proxied = await proxyViaGateway(payload, 'api/ws', {
      method: 'POST',
      body: gatewayRpcBody('session.context_breakdown', {
        session_id: sessionId
      }, 5_000),
      contentType: 'application/json',
      sourceHeaders: request.headers,
      timeoutMs: 6_000
    })
    const canonicalContext = sessionContextMetadata(proxiedBody(proxied))
    if (canonicalContext === null) {
      const sessionProxy = await proxyViaGateway(
        payload,
        `api/sessions/${encodedSessionId}`,
        { sourceHeaders: request.headers, timeoutMs: 6_000 }
      )
      const estimatedContext = sessionContextMetadata(proxiedBody(sessionProxy))
      if (estimatedContext) {
        logRouter('info', 'Bridge session context estimated from session metadata', {
          ...proxiedLogContext(sessionProxy, undefined, startedAt),
          sessionId
        })
        sendJson(response, 200, {
          ...estimatedContext,
          estimated: true,
          source: 'session_metadata'
        })
        return
      }
    }
    logRouter(statusLevel(proxiedStatus(proxied)), 'Bridge session context received', {
      ...proxiedLogContext(proxied, undefined, startedAt),
      sessionId
    })
    sendGatewayResponse(response, proxied.response)
    return
  }
  if (sessionActionMatch && request.method === 'POST' && sessionActionMatch[2] === 'metadata') {
    const sessionId = decodeURIComponent(sessionActionMatch[1])
    const input = await readJson(request)
    const record = sessionMetadataStore.set(payload.hermesAgentId, sessionId, input)
    logRouter('info', 'Bridge session metadata updated', {
      sessionId,
      metadataKeys: Object.keys(input)
    })
    sendJson(response, 200, { sessionId, metadata: record || null })
    return
  }

  if (sessionActionMatch && request.method === 'GET' && sessionActionMatch[2] === 'messages') {
    const clientSessionId = decodeURIComponent(sessionActionMatch[1])
    const sessionId = encodeURIComponent(sessionReadTarget(payload.hermesAgentId, clientSessionId))
    const offset = url.searchParams.get('offset') || '0'
    const limit = url.searchParams.get('limit') || '150'
    const startedAt = Date.now()
    logRouter('info', 'Bridge messages receive requested', {
      sessionId: decodeURIComponent(sessionActionMatch[1]),
      offset,
      limit
    })
    const proxied = await proxyViaGateway(
      payload,
      `api/sessions/${sessionId}/messages?offset=${encodeURIComponent(offset)}&limit=${encodeURIComponent(limit)}`,
      { sourceHeaders: request.headers },
    )
    logRouter(statusLevel(proxiedStatus(proxied)), 'Bridge messages received', {
      ...proxiedLogContext(proxied, undefined, startedAt),
      sessionId: decodeURIComponent(sessionActionMatch[1]),
      offset,
      limit
    })
    sendGatewayResponse(response, proxied.response)
    return
  }

  if (sessionActionMatch && request.method === 'POST' && sessionActionMatch[2] === 'rename') {
    await handleBridgeRenameSession(request, response, payload, url, sessionActionMatch[1])
    return
  }

  if (sessionActionMatch && request.method === 'POST' && sessionActionMatch[2] === 'model') {
    sendUnsupportedGatewayOperation(response, 'session model mutation')
    return
  }

  if (sessionActionMatch && request.method === 'POST' && (sessionActionMatch[2] === 'fork' || sessionActionMatch[2] === 'branch')) {
    await handleBridgeForkSession(request, response, payload, url, sessionActionMatch[1])
    return
  }

  if (sessionActionMatch && request.method === 'POST' && sessionActionMatch[2] === 'archive') {
    await handleBridgeArchiveSession(request, response, payload, url, sessionActionMatch[1], true)
    return
  }

  if (sessionActionMatch && request.method === 'POST' && sessionActionMatch[2] === 'delete') {
    await handleBridgeDeleteSession(request, response, payload, url, sessionActionMatch[1])
    return
  }

  if (pathname === '/bridge/command/dispatch' && request.method === 'POST') {
    sendNativeSessionRequired(response)
    return
  }

  if (pathname === '/bridge/chat-run' && request.method === 'POST') {
    sendNativeSessionRequired(response)
    return
  }

  if (pathname === '/bridge/audio/transcribe' && request.method === 'POST') {
    sendUnsupportedGatewayOperation(response, 'audio transcription')
    return
  }

  if (pathname === '/bridge/upload' && request.method === 'POST') {
    sendUnsupportedGatewayOperation(response, 'file upload')
    return
  }

  if (pathname === '/bridge/download' && request.method === 'GET') {
    sendUnsupportedGatewayOperation(response, 'file download')
    return
  }

  if (pathname === '/bridge/group-chat/rooms' && request.method === 'GET') {
    sendUnsupportedGatewayOperation(response, 'group chat rooms')
    return
  }

  if (pathname === '/bridge/hermes/available-models' && request.method === 'GET') {
    const startedAt = Date.now()
    logRouter('info', 'Bridge available models requested', { queryKeys: queryKeys(search) })
    const result = await proxyModelOptionsViaGateway(payload, search, request.headers)
    const proxied = result.proxied
    logRouter(statusLevel(proxiedStatus(proxied)), 'Bridge available models completed', {
      ...proxiedLogContext(proxied, undefined, startedAt),
      upstreamPath: logPath(result.path)
    })
    sendGatewayResponse(response, proxied.response)
    return
  }

  if (pathname === '/bridge/hermes/runtime' && request.method === 'GET') {
    const refresh = url.searchParams.get('refresh') === '1'
    let snapshot = refresh
      ? null
      : hermesGateways.cachedRuntimeSnapshot(payload.hermesAgentId)
    if (!snapshot || refresh) {
      snapshot = await hermesGateways.runtimeSnapshot(payload.hermesAgentId, {
        timeoutMs: 6_000,
      })
    }
    sendJson(response, 200, {
      ...snapshot.snapshot,
      cache: {
        stale: snapshot.stale,
        received_at: snapshot.receivedAt,
      },
    })
    return
  }

  if (pathname === '/bridge/hermes/model-context' && request.method === 'GET') {
    sendUnsupportedGatewayOperation(response, 'global model context')
    return
  }

  logRouter('warn', 'HTTP route not found', { method: request.method, pathname })
  sendJson(response, 404, { error: 'Not found' })
}

const server = createServer((request, response) => {
  handle(request, response).catch(error => {
    const message = errorMessage(error)
    const explicitStatus = typeof (error as { statusCode?: unknown }).statusCode === 'number'
      ? (error as { statusCode: number }).statusCode
      : undefined
    const status = explicitStatus ?? (/too large/i.test(message)
      ? 413
      : /pairing|token|expired|signature|Missing|Invalid|Unknown|not found/i.test(message)
        ? 401
        : 500)
    logRouter(status >= 500 ? 'error' : 'warn', 'HTTP request failed', {
      method: request.method,
      pathname: getPath(request).pathname,
      status
    }, error)
    const code = typeof (error as { code?: unknown }).code === 'string'
      ? (error as { code: string }).code
      : undefined
    const retryAfterSeconds = typeof (error as { retryAfterSeconds?: unknown }).retryAfterSeconds === 'number'
      ? Math.max(1, Math.ceil((error as { retryAfterSeconds: number }).retryAfterSeconds))
      : undefined
    if (retryAfterSeconds !== undefined) response.setHeader('retry-after', String(retryAfterSeconds))
    sendJson(response, status, { error: message, ...(code ? { code } : {}) })
  })
})

const gatewayWss = new WebSocketServer({ noServer: true })
const clientEventsWss = new WebSocketServer({ noServer: true })
server.on('upgrade', (request, socket, head) => {
  const { pathname, url } = getPath(request)
  if (pathname === '/bridge/events') {
    try {
      const payload = requireRealtimePayload(request)
      const clientId = bridgeClientId(request, url)
      const afterValue = url.searchParams.get('after')
      const afterCursor = afterValue == null || afterValue.trim() === ''
        ? undefined
        : Number(afterValue)
      if (afterCursor != null && (!Number.isSafeInteger(afterCursor) || afterCursor < 0)) {
        throw Object.assign(new Error('Invalid realtime cursor'), { statusCode: 400 })
      }
      clientEventsWss.handleUpgrade(request, socket, head, ws => {
        const attached = clientEventHub.attach(ws, {
          scope: bridgeClientEventScope(payload),
          clientId,
          afterCursor,
          expiresAtMs: payload.exp > 0 ? payload.exp * 1000 : undefined
        })
        logRouter('info', 'Client realtime WebSocket connected', {
          clientId,
          hermesAgentId: payload.hermesAgentId,
          replayed: attached.replayed,
          resyncRequired: attached.resyncRequired,
          subscriberCount: clientEventHub.subscriberCount
        })
        ws.once('close', () => {
          logRouter('info', 'Client realtime WebSocket disconnected', {
            clientId,
            hermesAgentId: payload.hermesAgentId,
            subscriberCount: clientEventHub.subscriberCount
          })
        })
      })
    } catch (error) {
      const status = typeof (error as { statusCode?: unknown }).statusCode === 'number'
        ? (error as { statusCode: number }).statusCode
        : 401
      const reason = status === 400 ? 'Bad Request' : 'Unauthorized'
      logRouter('warn', 'Client realtime WebSocket upgrade rejected', { status }, error)
      socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\n\r\n`)
      socket.destroy()
    }
    return
  }
  const gatewayMatch = pathname.match(/^\/router\/hermes-hub-gateways\/([^/]+)\/stream$/)
  if (!gatewayMatch) {
    logRouter('warn', 'WebSocket upgrade rejected for unknown path', { pathname })
    socket.destroy()
    return
  }
  let gatewayId = ''
  try {
    gatewayId = decodeURIComponent(gatewayMatch[1])
    const token = bearerToken(request.headers.authorization) || ''
    const record = pairingStore.verifyGateway(gatewayId, token)
    gatewayWss.handleUpgrade(request, socket, head, ws => {
      logRouter('info', 'Hermes Hub Gateway WebSocket upgrade accepted', {
        gatewayId,
        hermesAgentId: record.hermesAgentId,
        connectionKind: 'hermes-hub-gateway',
        requestId: record.requestId,
        user: record.user,
        deviceName: record.deviceName
      })
      gatewayRegistry.attach(ws, record)
    })
  } catch (error) {
    logRouter('warn', 'Hermes Hub Gateway WebSocket upgrade rejected', {
      gatewayId: gatewayId || '[invalid-path-segment]'
    }, error)
    socket.destroy()
  }
})

server.on('error', error => {
  const code = (error as NodeJS.ErrnoException).code || 'listen_failed'
  logRouter('error', 'Hermes Hub router failed to listen', { host, port, code }, error)
  process.exitCode = 1
})

server.listen(port, host, () => {
  logRouter('info', 'Hermes Hub router listening', {
    host,
    port,
    routerUrl,
    canonicalRouterPathStripped,
    diagnosticsDir,
    pairingStorePath,
    sessionMetadataStorePath,
    topology: 'client-router-hermes-hub-gateway-agent',
    debugGatewayEnabled: Boolean(debugGateway),
  })
})
