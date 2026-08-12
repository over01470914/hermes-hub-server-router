
import { createHash, randomUUID } from 'node:crypto'
import type { RawData, WebSocket } from 'ws'
import { elapsedMs, type GatewayRequestMetrics } from '../../core/protocol/bridgeProtocol.js'
import { logRouter } from '../../core/observability/routerLogger.js'
import type { GatewayCredentialState } from '../pairing/pairingStore.js'
import {
  GatewayLivenessSupervisor,
  type GatewayLivenessProbe,
  type GatewayLivenessProbeOutcome,
  type GatewayLivenessState,
} from './gatewayLivenessSupervisor.js'
import {
  GatewayRequestTombstones,
  type GatewayRequestLifecycleMetrics,
  type GatewayRpcCancelOutcome,
} from './gatewayRequestTombstones.js'

export interface GatewayState {
  gatewayId: string
  hermesAgentId: string
  gatewayConnectionId: string
  connectionKind: ConnectionKind
  gatewayCredentialState: GatewayCredentialState
  routable: boolean
  connectedAt: number
  lastSeenAt: number
  online: boolean
  agentOnline?: boolean
  inFlightRpc: number
  runtime: string
  mode: string
  protocols?: string[]
  capabilities?: string[]
  operational?: GatewayCombinedOperationalMetrics
}

export type ConnectionKind = 'hermes-hub-gateway'

export interface GatewayRegistryOptions {
  connectionKind: ConnectionKind
  protocol: string
  protocols: string[]
  helloTimeoutMs: number
  livenessProbeIntervalMs?: number
}

const defaultRegistryOptions: GatewayRegistryOptions = {
  connectionKind: 'hermes-hub-gateway',
  protocol: 'hermes-hub-gateway-rpc/v2',
  protocols: ['hermes-hub-gateway-rpc/v2'],
  helloTimeoutMs: 10_000,
  livenessProbeIntervalMs: 5_000,
}

export interface GatewaySessionSubmit {
  laneId: string
  submissionId: string
  text: string
  deviceId: string
  model?: string
  provider?: string
  reasoningEffort?: string
  fast?: boolean
  presentation?: 'command'
  attachmentIds?: string[]
}

export interface GatewayPromptResponse {
  laneId: string
  promptId: string
  response: string
}

export interface GatewayNativeAck {
  accepted: boolean
  requestType: 'session_submit' | 'session_prompt_response'
  laneId?: string
  submissionId?: string
  sessionId?: string
  promptId?: string
  code?: string
  error?: string
}

export interface GatewaySessionEvent {
  eventId: string
  hermesAgentId: string
  gatewayId: string
  laneId: string
  sessionId?: string
  submissionId?: string
  event: string
  data: Record<string, unknown>
  sentAt: number
}

export interface GatewayRpcRequest {
  method: string
  path: string
  headers?: Record<string, string>
  bodyBase64?: string
}

export interface GatewayRpcResponse {
  status: number
  headers: Record<string, string>
  bodyBase64: string
  metrics?: GatewayRequestMetrics
}

export interface GatewayHeartbeatResult {
  ok: boolean
  gatewayId?: string
  hermesAgentId?: string
  gatewayConnectionId?: string
  latencyMs?: number
  online: boolean
  agentOnline?: boolean
  routable?: boolean
  lastSeenAt?: number
  liveness?: GatewayLivenessState['kind']
  consecutiveMisses?: 1
  error?: string
}

export interface GatewayRuntimeSnapshot {
  eventId: string
  hermesAgentId: string
  gatewayId: string
  scope: 'agent' | 'session'
  sessionId?: string
  laneId?: string
  submissionId?: string
  snapshot: Record<string, unknown>
  receivedAt: number
  stale: boolean
}

export interface GatewayOperationalSnapshot {
  sampledAt: number
  eventLoop: {
    sampleCount: number
    lastMs: number
    p50Ms: number
    p95Ms: number
    p99Ms: number
    signal: 'ok' | 'warning' | 'critical'
  }
  fileDescriptors: {
    count?: number
    softLimit?: number
    ratioPercent?: number
    consecutiveHighSamples: number
    signal: 'ok' | 'warning' | 'critical' | 'unavailable'
  }
  tasks: Record<
    'request' | 'native' | 'transcript' | 'cancel',
    { count: number; oldestAgeMs: number }
  >
  semaphore: {
    waitingCount: number
    oldestWaitingMs: number
    lastWaitMs: number
    p95WaitMs: number
  }
  outbound: Record<
    'control' | 'data',
    { depth: number; oldestAgeMs: number }
  >
  rpcCancel: {
    cancelled: number
    notFound: number
    alreadyCompleted: number
  }
  reconnect: {
    lastAt?: number
    reason?: string
  }
}

export interface GatewayCombinedOperationalMetrics {
  gateway?: GatewayOperationalSnapshot
  gatewayReceivedAt?: number
  router: {
    heartbeat: {
      state: GatewayLivenessState['kind']
      rttMs?: number
      missStreak: number
    }
    rpc: GatewayRequestLifecycleMetrics
  }
}

export interface GatewayActivationReservation {
  hermesAgentId: string
  gatewayId: string
  gatewayConnectionId: string
}

export interface GatewayActivationSyncResult {
  activated: boolean
  reservation: GatewayActivationReservation
  gateway?: GatewayState
  quarantinedGatewayIds: string[]
  reason?: 'candidate_missing' | 'candidate_connection_changed' | 'candidate_not_open' | 'sync_failed'
}

interface PendingRpc {
  resolve: (response: GatewayRpcResponse) => void
  reject: (error: Error) => void
  timeout: NodeJS.Timeout
  startedAt: number
  chunked?: {
    status: number
    headers: Record<string, string>
    totalBytes: number
    chunkCount: number
    sha256: string
    nextIndex: number
    receivedBytes: number
    chunks: Buffer[]
  }
}

export interface GatewayGlobalEvent {
  eventId: string
  hermesAgentId: string
  gatewayId: string
  event: 'sessions.changed'
  data: Record<string, unknown>
  sentAt: number
}

const maxGatewayRpcResponseBytes = 25 * 1024 * 1024
const maxGatewayRpcResponseChunks = 128

interface PendingHeartbeat {
  resolve: (result: GatewayLivenessProbeOutcome) => void
  timeout: NodeJS.Timeout
  startedAt: number
}

interface PendingNative {
  resolve: (response: GatewayNativeAck) => void
  reject: (error: Error) => void
  timeout: NodeJS.Timeout
  startedAt: number
  requestType: GatewayNativeAck['requestType']
  laneId: string
  submissionId?: string
  promptId?: string
}

interface PendingRuntimeSnapshot {
  resolve: (snapshot: GatewayRuntimeSnapshot) => void
  reject: (error: Error) => void
  timeout: NodeJS.Timeout
  startedAt: number
  sessionId?: string
}

interface TrackedGateway extends GatewayState {
  agentOnline: boolean
  requestId: string
  user: string
  deviceName: string
  socket?: WebSocket
  pending: Map<string, PendingRpc>
  pendingHeartbeats: Map<string, PendingHeartbeat>
  pendingNative: Map<string, PendingNative>
  pendingRuntimeSnapshots: Map<string, PendingRuntimeSnapshot>
  operationalSnapshot?: GatewayOperationalSnapshot
  operationalReceivedAt?: number
  helloTimeout?: NodeJS.Timeout
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000)
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function cleanHeaders(value: unknown): Record<string, string> {
  const input = asRecord(value)
  if (!input) return {}
  const output: Record<string, string> = {}
  for (const [key, raw] of Object.entries(input)) {
    if (typeof raw !== 'string') continue
    output[key.toLowerCase()] = raw
  }
  return output
}

function cleanRpcResponse(value: unknown): GatewayRpcResponse {
  const input = asRecord(value)
  if (!input) throw new Error('Gateway RPC response must be an object')
  const status = typeof input.status === 'number' && input.status >= 100 && input.status <= 599 ? input.status : 502
  const bodyBase64 = typeof input.bodyBase64 === 'string' ? input.bodyBase64 : ''
  return { status, headers: cleanHeaders(input.headers), bodyBase64 }
}

function decodeStrictBase64(value: unknown): Buffer {
  if (typeof value !== 'string' || value.length > Math.ceil(maxGatewayRpcResponseBytes / 3) * 4 + 8) {
    throw new Error('Gateway RPC response chunk is invalid')
  }
  const decoded = Buffer.from(value, 'base64')
  if (decoded.toString('base64') !== value) {
    throw new Error('Gateway RPC response chunk is invalid')
  }
  return decoded
}

function safeRuntimeString(value: unknown, maximum = 240): string | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = value.trim()
  if (!normalized || normalized.length > maximum || /[\r\n\0]/.test(normalized)) return undefined
  return normalized
}

function safeRuntimeNumber(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) return undefined
  return Math.floor(value)
}

function safeOperationalNumber(
  value: unknown,
  maximum = 1_000_000_000,
): number {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > maximum
  ) return 0
  return Math.round(value * 1_000) / 1_000
}

function cleanOperationalSignal(
  value: unknown,
  allowUnavailable = false,
): 'ok' | 'warning' | 'critical' | 'unavailable' {
  if (value === 'warning' || value === 'critical') return value
  if (allowUnavailable && value === 'unavailable') return value
  return 'ok'
}

function cleanGatewayOperationalSnapshot(
  value: Record<string, unknown>,
  state: Pick<TrackedGateway, 'gatewayId' | 'hermesAgentId'>,
): GatewayOperationalSnapshot {
  if (
    value.gatewayId !== state.gatewayId ||
    value.hermesAgentId !== state.hermesAgentId
  ) {
    throw new Error('Gateway operational snapshot identity mismatch')
  }
  const raw = asRecord(value.snapshot)
  if (
    !raw ||
    raw.object !== 'hermes-hub.gateway.operational' ||
    raw.version !== 1
  ) {
    throw new Error('Gateway operational snapshot contract is invalid')
  }
  const eventLoop = asRecord(raw.eventLoop) || {}
  const fileDescriptors = asRecord(raw.fileDescriptors) || {}
  const tasks = asRecord(raw.tasks) || {}
  const semaphore = asRecord(raw.semaphore) || {}
  const outbound = asRecord(raw.outbound) || {}
  const rpcCancel = asRecord(raw.rpcCancel) || {}
  const reconnect = asRecord(raw.reconnect) || {}
  const cleanTasks = {} as GatewayOperationalSnapshot['tasks']
  for (const name of ['request', 'native', 'transcript', 'cancel'] as const) {
    const task = asRecord(tasks[name]) || {}
    cleanTasks[name] = {
      count: safeOperationalNumber(task.count, 100_000),
      oldestAgeMs: safeOperationalNumber(task.oldestAgeMs),
    }
  }
  const cleanOutbound = {} as GatewayOperationalSnapshot['outbound']
  for (const name of ['control', 'data'] as const) {
    const queue = asRecord(outbound[name]) || {}
    cleanOutbound[name] = {
      depth: safeOperationalNumber(queue.depth, 100_000),
      oldestAgeMs: safeOperationalNumber(queue.oldestAgeMs),
    }
  }
  const reconnectReason = safeRuntimeString(reconnect.reason, 80)
  if (reconnectReason && !/^[a-z0-9_.-]+$/.test(reconnectReason)) {
    throw new Error('Gateway operational reconnect reason is invalid')
  }
  const fdCount = typeof fileDescriptors.count === 'number'
    ? safeOperationalNumber(fileDescriptors.count, 10_000_000)
    : undefined
  const fdSoftLimit = typeof fileDescriptors.softLimit === 'number'
    ? safeOperationalNumber(fileDescriptors.softLimit, 10_000_000)
    : undefined
  const fdRatio = typeof fileDescriptors.ratioPercent === 'number'
    ? safeOperationalNumber(fileDescriptors.ratioPercent, 100)
    : undefined
  const reconnectAt = typeof reconnect.lastAt === 'number'
    ? safeOperationalNumber(reconnect.lastAt, Number.MAX_SAFE_INTEGER)
    : undefined
  return {
    sampledAt: safeOperationalNumber(
      raw.sampledAt,
      Number.MAX_SAFE_INTEGER,
    ),
    eventLoop: {
      sampleCount: safeOperationalNumber(eventLoop.sampleCount, 60),
      lastMs: safeOperationalNumber(eventLoop.lastMs, 60_000),
      p50Ms: safeOperationalNumber(eventLoop.p50Ms, 60_000),
      p95Ms: safeOperationalNumber(eventLoop.p95Ms, 60_000),
      p99Ms: safeOperationalNumber(eventLoop.p99Ms, 60_000),
      signal: cleanOperationalSignal(eventLoop.signal) as
        'ok' | 'warning' | 'critical',
    },
    fileDescriptors: {
      ...(fdCount === undefined ? {} : { count: fdCount }),
      ...(fdSoftLimit === undefined ? {} : { softLimit: fdSoftLimit }),
      ...(fdRatio === undefined ? {} : { ratioPercent: fdRatio }),
      consecutiveHighSamples: safeOperationalNumber(
        fileDescriptors.consecutiveHighSamples,
        1_000_000,
      ),
      signal: cleanOperationalSignal(fileDescriptors.signal, true),
    },
    tasks: cleanTasks,
    semaphore: {
      waitingCount: safeOperationalNumber(semaphore.waitingCount, 100_000),
      oldestWaitingMs: safeOperationalNumber(semaphore.oldestWaitingMs),
      lastWaitMs: safeOperationalNumber(semaphore.lastWaitMs),
      p95WaitMs: safeOperationalNumber(semaphore.p95WaitMs),
    },
    outbound: cleanOutbound,
    rpcCancel: {
      cancelled: safeOperationalNumber(rpcCancel.cancelled),
      notFound: safeOperationalNumber(rpcCancel.notFound),
      alreadyCompleted: safeOperationalNumber(rpcCancel.alreadyCompleted),
    },
    reconnect: {
      ...(reconnectAt === undefined ? {} : { lastAt: reconnectAt }),
      ...(reconnectReason ? { reason: reconnectReason } : {}),
    },
  }
}

function cleanRuntimeCategories(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return []
  const categories: Record<string, unknown>[] = []
  for (const rawCategory of value.slice(0, 16)) {
    const category = asRecord(rawCategory)
    if (!category) continue
    const id = safeRuntimeString(category.id, 80)
    const label = safeRuntimeString(category.label, 120)
    const tokens = safeRuntimeNumber(category.tokens)
    if (!id || !label || tokens === undefined) continue
    categories.push({ id, label, tokens })
  }
  return categories
}

function cleanRuntimeSnapshot(
  value: Record<string, unknown>,
  state: Pick<TrackedGateway, 'gatewayId' | 'hermesAgentId'>,
): GatewayRuntimeSnapshot {
  if (value.gatewayId !== state.gatewayId || value.hermesAgentId !== state.hermesAgentId) {
    throw new Error('Gateway runtime snapshot identity mismatch')
  }
  const rawSnapshot = asRecord(value.snapshot)
  if (!rawSnapshot || rawSnapshot.object !== 'hermes.runtime.status' || rawSnapshot.version !== 1) {
    throw new Error('Gateway runtime snapshot contract is invalid')
  }
  const scope = rawSnapshot.scope === 'agent' || rawSnapshot.scope === 'session' ? rawSnapshot.scope : undefined
  if (!scope) throw new Error('Gateway runtime snapshot scope is invalid')
  const snapshotSessionId = safeRuntimeString(rawSnapshot.session_id, 256)
  const frameSessionId = safeRuntimeString(value.sessionId, 256)
  if (scope === 'session' && (!snapshotSessionId || (frameSessionId && frameSessionId !== snapshotSessionId))) {
    throw new Error('Gateway runtime snapshot session identity is invalid')
  }
  const model = safeRuntimeString(rawSnapshot.model, 240)
  const provider = safeRuntimeString(rawSnapshot.provider, 120)
  const reasoningEffort = safeRuntimeString(rawSnapshot.reasoning_effort, 120)
  const serviceTier = safeRuntimeString(rawSnapshot.service_tier, 120)
  const transcriptRevision = safeRuntimeString(rawSnapshot.transcript_revision, 160)
  const headCursor = safeRuntimeString(rawSnapshot.head_cursor, 512)
  const totalCount = safeRuntimeNumber(rawSnapshot.total_count)
  const segmentCount = safeRuntimeNumber(rawSnapshot.segment_count)
  const revision = safeRuntimeString(rawSnapshot.revision, 160)
  const status = safeRuntimeString(rawSnapshot.status, 80)
  const source = safeRuntimeString(rawSnapshot.source, 120)
  const context = asRecord(rawSnapshot.context) || {}
  const usage = asRecord(rawSnapshot.usage) || {}
  const compression = asRecord(rawSnapshot.compression) || {}
  const contextUsed = safeRuntimeNumber(context.context_used ?? rawSnapshot.context_used)
  const contextMax = safeRuntimeNumber(context.context_max ?? rawSnapshot.context_max)
  const contextPercentRaw = context.context_percent ?? rawSnapshot.context_percent
  const contextPercent = typeof contextPercentRaw === 'number' && Number.isFinite(contextPercentRaw)
    ? Math.max(0, Math.min(100, contextPercentRaw))
    : undefined
  const cleanUsage: Record<string, unknown> = {}
  for (const key of ['input_tokens', 'output_tokens', 'total_tokens', 'cache_read_tokens', 'cache_write_tokens', 'reasoning_tokens']) {
    const number = safeRuntimeNumber(usage[key])
    if (number !== undefined) cleanUsage[key] = number
  }
  const cleanContext: Record<string, unknown> = {
    ...(contextUsed !== undefined ? { context_used: contextUsed } : {}),
    ...(contextMax !== undefined ? { context_max: contextMax } : {}),
    ...(contextPercent !== undefined ? { context_percent: contextPercent } : {}),
    categories: cleanRuntimeCategories(context.categories),
    accuracy: context.accuracy === 'exact' ? 'exact' : 'estimated',
  }
  const contextSource = safeRuntimeString(context.source, 120)
  if (contextSource) cleanContext.source = contextSource
  const cleanCompression: Record<string, unknown> = {}
  const compressionStatus = safeRuntimeString(compression.status, 80)
  const thresholdTokens = safeRuntimeNumber(compression.threshold_tokens)
  if (compressionStatus) cleanCompression.status = compressionStatus
  if (typeof compression.available === 'boolean') cleanCompression.available = compression.available
  if (thresholdTokens !== undefined) cleanCompression.threshold_tokens = thresholdTokens
  const cleanSnapshot: Record<string, unknown> = {
    object: 'hermes.runtime.status',
    version: 1,
    scope,
    ...(snapshotSessionId ? { session_id: snapshotSessionId } : {}),
    ...(revision ? { revision } : {}),
    observed_at: safeRuntimeNumber(rawSnapshot.observed_at) || Date.now(),
    ...(model ? { model } : {}),
    ...(provider ? { provider } : {}),
    ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
    ...(serviceTier ? { service_tier: serviceTier } : {}),
    ...(typeof rawSnapshot.fast === 'boolean' ? { fast: rawSnapshot.fast } : {}),
    ...(typeof rawSnapshot.running === 'boolean' ? { running: rawSnapshot.running } : {}),
    ...(transcriptRevision ? { transcript_revision: transcriptRevision } : {}),
    ...(headCursor ? { head_cursor: headCursor } : {}),
    ...(totalCount !== undefined ? { total_count: totalCount } : {}),
    ...(segmentCount !== undefined ? { segment_count: segmentCount } : {}),
    ...(typeof rawSnapshot.lineage_complete === 'boolean'
      ? { lineage_complete: rawSnapshot.lineage_complete }
      : {}),
    ...(status ? { status } : {}),
    usage: cleanUsage,
    context: cleanContext,
    ...(contextUsed !== undefined ? { context_used: contextUsed } : {}),
    ...(contextMax !== undefined ? { context_max: contextMax } : {}),
    ...(contextPercent !== undefined ? { context_percent: contextPercent } : {}),
    estimated: rawSnapshot.estimated !== false,
    ...(source ? { source } : {}),
    compression: cleanCompression,
  }
  const eventId = safeRuntimeString(value.eventId, 200) || `runtime_${randomUUID()}`
  const laneId = safeRuntimeString(value.laneId, 200)
  const submissionId = safeRuntimeString(value.submissionId, 200)
  return {
    eventId,
    hermesAgentId: state.hermesAgentId,
    gatewayId: state.gatewayId,
    scope,
    ...(snapshotSessionId ? { sessionId: snapshotSessionId } : {}),
    ...(laneId ? { laneId } : {}),
    ...(submissionId ? { submissionId } : {}),
    snapshot: cleanSnapshot,
    receivedAt: Date.now(),
    stale: false,
  }
}

const nativeSessionEvents = new Set([
  'message.created',
  'message.updated',
  'message.start',
  'message.delta',
  'message.interim',
  'message.complete',
  'assistant.delta',
  'assistant.live_input',
  'review.summary',
  'processing.started',
  'processing.completed',
  'session.transcript.committed',
  'prompt.requested',
  'prompt.resolved',
  'session.resync_required',
  'reasoning',
  'reasoning.delta',
  'reasoning.available',
  'thinking.delta',
  'text',
  'status',
  'status.update',
  'usage.updated',
  'gateway.ready',
  'session.info',
  'session.title',
  'clarify.request',
  'clarify.requested',
  'approval.request',
  'sudo.request',
  'secret.request',
  'interrupted',
  'done',
  'session.end',
  'error',
])

const nativeSessionEventPrefixes = [
  'tool.',
  'terminal.',
  'response.',
]

function isNativeSessionEvent(event: unknown): event is string {
  if (typeof event !== 'string' || event.length === 0 || event.length > 160) {
    return false
  }
  return nativeSessionEvents.has(event) || nativeSessionEventPrefixes.some(prefix => event.startsWith(prefix))
}

function nativeAckError(
  message: string,
  code: 'gateway_update_required' | 'gateway_native_ack_invalid',
  statusCode: 426 | 502,
): Error {
  return Object.assign(new Error(message), { code, statusCode })
}

function cleanNativeAck(value: Record<string, unknown>, pending: PendingNative): GatewayNativeAck {
  if (value.requestType !== pending.requestType || typeof value.accepted !== 'boolean') {
    throw nativeAckError('Gateway native acknowledgement shape is invalid', 'gateway_native_ack_invalid', 502)
  }
  // A legacy Gateway can reject a valid native request without echoing the
  // Router-owned correlation fields. This cannot be trusted as an ACK, but it
  // is actionable compatibility evidence rather than an identity conflict.
  if (typeof value.laneId !== 'string' || !value.laneId) {
    throw nativeAckError(
      'Gateway native acknowledgement is missing lane correlation; update the Hermes Hub Gateway and reconnect',
      'gateway_update_required',
      426,
    )
  }
  if (value.laneId !== pending.laneId) {
    throw nativeAckError('Gateway native acknowledgement lane correlation is invalid', 'gateway_native_ack_invalid', 502)
  }
  if (pending.submissionId && (typeof value.submissionId !== 'string' || !value.submissionId)) {
    throw nativeAckError(
      'Gateway native acknowledgement is missing submission correlation; update the Hermes Hub Gateway and reconnect',
      'gateway_update_required',
      426,
    )
  }
  if (pending.submissionId && value.submissionId !== pending.submissionId) {
    throw nativeAckError('Gateway native acknowledgement submission correlation is invalid', 'gateway_native_ack_invalid', 502)
  }
  if (pending.promptId && (typeof value.promptId !== 'string' || !value.promptId)) {
    throw nativeAckError(
      'Gateway native acknowledgement is missing prompt correlation; update the Hermes Hub Gateway and reconnect',
      'gateway_update_required',
      426,
    )
  }
  if (pending.promptId && value.promptId !== pending.promptId) {
    throw nativeAckError('Gateway native acknowledgement prompt correlation is invalid', 'gateway_native_ack_invalid', 502)
  }
  return {
    accepted: value.accepted,
    requestType: pending.requestType,
    laneId: pending.laneId,
    ...(pending.submissionId ? { submissionId: pending.submissionId } : {}),
    ...(pending.promptId ? { promptId: pending.promptId } : {}),
    ...(typeof value.sessionId === 'string' && value.sessionId.length <= 256
      ? { sessionId: value.sessionId }
      : {}),
    ...(typeof value.code === 'string' && value.code.length <= 120 ? { code: value.code } : {}),
    ...(typeof value.error === 'string' && value.error.length <= 500 ? { error: value.error } : {}),
  }
}

function cleanSessionEvent(
  value: Record<string, unknown>,
  state: Pick<TrackedGateway, 'gatewayId' | 'hermesAgentId'>,
): GatewaySessionEvent {
  if (value.gatewayId !== state.gatewayId || value.hermesAgentId !== state.hermesAgentId) {
    throw new Error('Gateway session event identity mismatch')
  }
  const eventId = typeof value.eventId === 'string' && /^evt_[A-Za-z0-9._:-]{8,191}$/.test(value.eventId)
    ? value.eventId
    : ''
  const laneId = typeof value.laneId === 'string' && /^lane_[A-Za-z0-9._:-]{8,191}$/.test(value.laneId)
    ? value.laneId
    : ''
  const event = isNativeSessionEvent(value.event) ? value.event : ''
  let data = asRecord(value.data)
  if (!eventId || !laneId || !event || !data) {
    throw new Error('Gateway session event shape is invalid')
  }
  const sessionId = typeof value.sessionId === 'string' && value.sessionId.length <= 256
    ? value.sessionId
    : undefined
  if (event === 'session.title') {
    const storedSessionId = typeof data.session_id === 'string' ? data.session_id : ''
    const title = typeof data.title === 'string'
      ? data.title.trim().replace(/\s+/g, ' ')
      : ''
    if (!sessionId || storedSessionId !== sessionId || !title || title.length > 240) {
      throw new Error('Gateway session title event shape is invalid')
    }
    data = { session_id: storedSessionId, title }
  } else if (event === 'session.info') {
    const storedSessionId = typeof data.stored_session_id === 'string'
      ? data.stored_session_id
      : ''
    const previousStoredSessionId = typeof data.previous_stored_session_id === 'string'
      ? data.previous_stored_session_id
      : ''
    if (previousStoredSessionId) {
      if (
        !sessionId
        || storedSessionId !== sessionId
        || !/^[A-Za-z0-9._:-]{3,200}$/.test(previousStoredSessionId)
        || previousStoredSessionId === storedSessionId
      ) {
        throw new Error('Gateway session continuation event shape is invalid')
      }
      data = {
        ...data,
        stored_session_id: storedSessionId,
        previous_stored_session_id: previousStoredSessionId,
      }
    }
  } else if (event === 'session.transcript.committed') {
    const transcriptRevision = safeRuntimeString(data.transcript_revision, 160)
    const headCursor = safeRuntimeString(data.head_cursor, 512)
    const totalCount = safeRuntimeNumber(data.total_count)
    const segmentCount = safeRuntimeNumber(data.segment_count)
    if (!sessionId || !transcriptRevision || !headCursor || totalCount === undefined || segmentCount === undefined) {
      throw new Error('Gateway transcript commit event shape is invalid')
    }
    data = {
      transcript_revision: transcriptRevision,
      head_cursor: headCursor,
      total_count: totalCount,
      segment_count: segmentCount,
      lineage_complete: data.lineage_complete === true,
      committed_at: safeRuntimeNumber(data.committed_at) || Date.now(),
    }
  }
  const submissionId = typeof value.submissionId === 'string' && /^sub_[A-Za-z0-9._:-]{8,191}$/.test(value.submissionId)
    ? value.submissionId
    : undefined
  return {
    eventId,
    gatewayId: state.gatewayId,
    hermesAgentId: state.hermesAgentId,
    laneId,
    ...(sessionId ? { sessionId } : {}),
    ...(submissionId ? { submissionId } : {}),
    event,
    data,
    sentAt: typeof value.sentAt === 'number' && Number.isSafeInteger(value.sentAt)
      ? value.sentAt
      : Date.now(),
  }
}

function cleanGlobalEvent(
  value: Record<string, unknown>,
  state: Pick<TrackedGateway, 'gatewayId' | 'hermesAgentId'>,
): GatewayGlobalEvent {
  if (value.gatewayId !== state.gatewayId || value.hermesAgentId !== state.hermesAgentId) {
    throw new Error('Gateway global event identity mismatch')
  }
  const eventId = typeof value.eventId === 'string' && /^evt_[A-Za-z0-9._:-]{8,191}$/.test(value.eventId)
    ? value.eventId
    : ''
  const data = asRecord(value.data)
  if (!eventId || value.event !== 'sessions.changed' || !data) {
    throw new Error('Gateway global event shape is invalid')
  }
  const profile = typeof data.profile === 'string'
    ? data.profile.trim()
    : ''
  if (profile.length > 160 || /[\u0000-\u001f\u007f]/.test(profile)) {
    throw new Error('Gateway global event profile is invalid')
  }
  return {
    eventId,
    gatewayId: state.gatewayId,
    hermesAgentId: state.hermesAgentId,
    event: 'sessions.changed',
    data: profile ? { profile } : {},
    sentAt: typeof value.sentAt === 'number' && Number.isSafeInteger(value.sentAt)
      ? value.sentAt
      : Date.now(),
  }
}

function logPath(path: string): string {
  return path.split('?')[0]
}

function queryKeys(path: string): string[] {
  const index = path.indexOf('?')
  if (index < 0) return []
  const params = new URLSearchParams(path.slice(index + 1))
  return [...new Set([...params.keys()])].slice(0, 20)
}

export class GatewayRegistry {
  private gateways = new Map<string, TrackedGateway>()
  private readonly firstSessionEventBySubmission = new Set<string>()
  private sessionEventHandler?: (event: GatewaySessionEvent) => boolean
  private globalEventHandler?: (event: GatewayGlobalEvent) => void
  private runtimeSnapshotHandler?: (snapshot: GatewayRuntimeSnapshot) => void
  private readonly runtimeSnapshots = new Map<string, GatewayRuntimeSnapshot>()
  private readonly requestTombstones = new GatewayRequestTombstones()
  private readonly liveness: GatewayLivenessSupervisor
  private readonly livenessTimer: NodeJS.Timeout

  constructor(private readonly options: GatewayRegistryOptions = defaultRegistryOptions) {
    this.liveness = new GatewayLivenessSupervisor(
      (hermesAgentId, timeoutMs) => this.livenessProbeFor(
        hermesAgentId,
        timeoutMs,
      ),
    )
    this.livenessTimer = setInterval(
      () => this.probeOnlineGateways(),
      options.livenessProbeIntervalMs ?? 5_000,
    )
    this.livenessTimer.unref()
  }

  attach(socket: WebSocket, record: { gatewayId?: string; hermesAgentId?: string; gatewayCredentialState?: GatewayCredentialState; requestId: string; user: string; deviceName: string }): GatewayState {
    if (!record.gatewayId) throw new Error('Gateway id missing')
    if (!record.hermesAgentId) throw new Error('Hermes Agent id missing')
    const now = nowSeconds()
    const existing = this.gateways.get(record.gatewayId)
    if (existing?.socket && existing.socket.readyState <= 1) {
      logRouter('warn', 'gateway.connection.reconnecting', 'A newer Gateway connection replaces the prior socket.', {
        gatewayId: record.gatewayId,
        hermesAgentId: record.hermesAgentId,
        gatewayConnectionId: existing.gatewayConnectionId,
        previousInFlightRpc: existing.inFlightRpc,
        nextAction: 'reconnect',
      })
      existing.socket.close(4000, 'superseded by new gateway socket')
    }
    const state: TrackedGateway = {
      gatewayId: record.gatewayId,
      hermesAgentId: record.hermesAgentId,
      gatewayConnectionId: `gwc_${randomUUID()}`,
      connectionKind: this.options.connectionKind,
      gatewayCredentialState: record.gatewayCredentialState === 'active' ? 'active' : 'provisional',
      routable: false,
      requestId: record.requestId,
      user: record.user,
      deviceName: record.deviceName,
      connectedAt: now,
      lastSeenAt: now,
      // A bearer-authenticated socket is not routable until its hello frame
      // proves the Agent/Gateway identities and negotiates our protocol.
      online: false,
      agentOnline: false,
      inFlightRpc: 0,
      runtime: 'unknown',
      mode: 'unknown',
      socket,
      pending: new Map(),
      pendingHeartbeats: new Map(),
      pendingNative: new Map(),
      pendingRuntimeSnapshots: new Map(),
    }
    this.gateways.set(record.gatewayId, state)
    logRouter('info', 'gateway.connection.started', 'Gateway transport connected and awaits the authenticated hello.', {
      gatewayId: record.gatewayId,
      hermesAgentId: record.hermesAgentId,
      gatewayConnectionId: state.gatewayConnectionId,
      gatewayCredentialState: state.gatewayCredentialState,
      requestId: record.requestId,
      nextAction: 'none',
    })
    let detached = false
    const detach = (reason: string, closeCode?: number, closeReason?: string): void => {
      if (detached) return
      detached = true
      if (state.helloTimeout) clearTimeout(state.helloTimeout)
      state.helloTimeout = undefined
      state.online = false
      state.agentOnline = false
      state.routable = false
      state.lastSeenAt = nowSeconds()
      state.socket = undefined
      this.liveness.recordSocketClosed(
        state.hermesAgentId,
        state.gatewayConnectionId,
        reason,
      )
      logRouter(
        state.pendingNative.size > 0 ? 'warn' : 'info',
        'gateway.connection.closed',
        state.pendingNative.size > 0
          ? 'Gateway transport closed; pending native submissions remain ambiguous.'
          : 'Gateway transport closed with no pending native submission.',
        {
        gatewayId: state.gatewayId,
        hermesAgentId: state.hermesAgentId,
        gatewayConnectionId: state.gatewayConnectionId,
        closeCode,
        pendingRpc: state.pending.size,
        pendingHeartbeats: state.pendingHeartbeats.size,
        pendingNative: state.pendingNative.size,
        pendingRuntimeSnapshots: state.pendingRuntimeSnapshots.size,
        nextAction: state.pendingNative.size > 0 ? 'hydrate' : 'reconnect',
        },
      )
      for (const [id, pending] of state.pending.entries()) {
        clearTimeout(pending.timeout)
        pending.reject(Object.assign(new Error(reason), {
          statusCode: 503,
          code: 'gateway_disconnected',
          retryAfterSeconds: 1,
        }))
        state.pending.delete(id)
      }
      for (const [id, pending] of state.pendingHeartbeats.entries()) {
        clearTimeout(pending.timeout)
        pending.resolve({ ok: false, reason })
        state.pendingHeartbeats.delete(id)
      }
      for (const [id, pending] of state.pendingNative.entries()) {
        clearTimeout(pending.timeout)
        pending.reject(Object.assign(new Error('Gateway native submission became ambiguous'), {
          code: 'gateway_submission_ambiguous',
        }))
        state.pendingNative.delete(id)
      }
      for (const [id, pending] of state.pendingRuntimeSnapshots.entries()) {
        clearTimeout(pending.timeout)
        pending.reject(Object.assign(new Error(reason), {
          statusCode: 503,
          code: 'gateway_disconnected',
          retryAfterSeconds: 1,
        }))
        state.pendingRuntimeSnapshots.delete(id)
      }
      state.inFlightRpc = 0
    }
    socket.on('message', (data: RawData) => {
      try {
        this.handleMessage(state, data)
      } catch (error) {
        logRouter('warn', 'gateway.message.handle_failed', 'Gateway frame handling failed; Router detached the transport.', {
          gatewayId: state.gatewayId,
          hermesAgentId: state.hermesAgentId,
          gatewayConnectionId: state.gatewayConnectionId,
        }, error)
        detach('Gateway message handler failed')
        if (socket.readyState <= 1) socket.terminate()
      }
    })
    socket.on('error', error => {
      logRouter('warn', 'gateway.connection.socket_failed', 'Gateway transport reported a socket error.', {
        gatewayId: state.gatewayId,
        hermesAgentId: state.hermesAgentId,
        gatewayConnectionId: state.gatewayConnectionId,
      }, error)
      detach('Gateway socket error')
      if (socket.readyState <= 1) socket.terminate()
    })
    state.helloTimeout = setTimeout(() => {
      if (state.online || state.socket?.readyState !== 1) return
      logRouter('warn', 'gateway.handshake.failed', 'Gateway did not complete its hello before the connection deadline.', {
        gatewayId: state.gatewayId,
        hermesAgentId: state.hermesAgentId,
        gatewayConnectionId: state.gatewayConnectionId,
        timeoutMs: this.options.helloTimeoutMs,
        nextAction: 'reconnect',
      })
      state.socket.close(4408, 'gateway hello timeout')
    }, this.options.helloTimeoutMs)
    socket.on('close', (code, reason) => detach('Gateway disconnected', code, reason.toString()))
    socket.send(JSON.stringify({
      type: 'ready',
      gatewayId: record.gatewayId,
      hermesAgentId: record.hermesAgentId,
      gatewayConnectionId: state.gatewayConnectionId,
      requestId: record.requestId,
      protocol: this.options.protocol,
      protocols: this.options.protocols
    }), error => {
      if (!error) return
      logRouter('warn', 'gateway.handshake.ready_send_failed', 'Router could not send the Gateway ready frame.', {
        gatewayId: state.gatewayId,
        hermesAgentId: state.hermesAgentId,
        gatewayConnectionId: state.gatewayConnectionId,
      }, error)
      detach('Gateway ready frame failed')
      if (socket.readyState <= 1) socket.terminate()
    })
    return this.publicState(state)
  }

  list(): GatewayState[] {
    return [...this.gateways.values()].map(item => this.publicState(item))
  }

  setSessionEventHandler(handler: (event: GatewaySessionEvent) => boolean): void {
    this.sessionEventHandler = handler
  }

  setGlobalEventHandler(handler: (event: GatewayGlobalEvent) => void): void {
    this.globalEventHandler = handler
  }

  setRuntimeSnapshotHandler(handler: (snapshot: GatewayRuntimeSnapshot) => void): void {
    this.runtimeSnapshotHandler = handler
  }

  getRuntimeSnapshotByAgentId(hermesAgentId: string, sessionId?: string): GatewayRuntimeSnapshot | null {
    const normalizedSessionId = sessionId?.trim()
    const key = this.runtimeSnapshotKey(hermesAgentId, normalizedSessionId || undefined)
    const snapshot = this.runtimeSnapshots.get(key)
    if (!snapshot) return null
    const stale = Date.now() - snapshot.receivedAt > 60_000
    return { ...snapshot, stale }
  }

  async requestRuntimeSnapshotByAgentId(
    hermesAgentId: string,
    options: { sessionId?: string; timeoutMs?: number } = {},
  ): Promise<GatewayRuntimeSnapshot> {
    const state = this.gatewayForAgent(hermesAgentId)
    if (!state?.socket || !state.online || state.socket.readyState !== 1) throw new Error('Gateway offline')
    if (!state.capabilities?.includes('runtime.status')) {
      throw Object.assign(new Error('Gateway does not advertise runtime.status'), { code: 'capability_unsupported' })
    }
    const sessionId = options.sessionId?.trim() || undefined
    const timeoutMs = Math.max(1_000, Math.min(options.timeoutMs || 6_000, 30_000))
    const id = `runtime_${randomUUID()}`
    const startedAt = Date.now()
    return new Promise<GatewayRuntimeSnapshot>((resolve, reject) => {
      const timeout = setTimeout(() => {
        state.pendingRuntimeSnapshots.delete(id)
        logRouter('warn', 'gateway.runtime_snapshot.timed_out', 'Gateway runtime snapshot did not arrive before the deadline.', {
          hermesAgentId,
          requestId: id,
          hasSession: Boolean(sessionId),
          timeoutMs,
          latencyMs: elapsedMs(startedAt),
        })
        reject(new Error('Gateway runtime snapshot timeout'))
      }, timeoutMs)
      state.pendingRuntimeSnapshots.set(id, { resolve, reject, timeout, startedAt, sessionId })
      state.socket?.send(JSON.stringify({
        type: 'runtime_snapshot_request',
        id,
        ...(sessionId ? { sessionId } : {}),
      }), error => {
        if (!error) return
        clearTimeout(timeout)
        state.pendingRuntimeSnapshots.delete(id)
        reject(error)
      })
    })
  }

  get(gatewayId: string): GatewayState | null {
    const state = this.gateways.get(gatewayId)
    return state ? this.publicState(state) : null
  }

  getByAgentId(hermesAgentId: string): GatewayState | null {
    const state = this.gatewayForAgent(hermesAgentId)
    return state ? this.publicState(state) : null
  }

  reserveCredentialActivation(hermesAgentId: string, gatewayId: string): GatewayActivationReservation {
    const candidate = this.gateways.get(gatewayId)
    if (!candidate || candidate.hermesAgentId !== hermesAgentId) {
      throw Object.assign(new Error('Gateway credential candidate is not attached to this Agent'), {
        code: 'gateway_activation_retry',
      })
    }
    if (!candidate.online || !candidate.agentOnline || candidate.socket?.readyState !== 1) {
      throw Object.assign(new Error('Gateway credential candidate Agent bridge is not online'), {
        code: 'gateway_activation_retry',
      })
    }
    return Object.freeze({
      hermesAgentId,
      gatewayId,
      gatewayConnectionId: candidate.gatewayConnectionId,
    })
  }

  synchronizeCredentialActivation(reservation: GatewayActivationReservation): GatewayActivationSyncResult {
    const quarantinedGatewayIds = new Set<string>()
    try {
      const candidate = this.gateways.get(reservation.gatewayId)
      const exactConnection = Boolean(
        candidate &&
        candidate.hermesAgentId === reservation.hermesAgentId &&
        candidate.gatewayConnectionId === reservation.gatewayConnectionId
      )
      const candidateOpen = Boolean(
        exactConnection && candidate?.online && candidate.agentOnline && candidate.socket?.readyState === 1,
      )
      const reason: GatewayActivationSyncResult['reason'] = !candidate
        ? 'candidate_missing'
        : !exactConnection
          ? 'candidate_connection_changed'
          : !candidateOpen
            ? 'candidate_not_open'
            : undefined

      if (candidateOpen && candidate) {
        candidate.gatewayCredentialState = 'active'
        candidate.routable = candidate.agentOnline
      }

      // Persistent credential state is authoritative after claim. Reconcile
      // every runtime connection for this Agent, including sockets already
      // marked revoked by an earlier failed/retried cutover. This makes the
      // operation idempotent and prevents an old live socket from remaining a
      // fallback route after the durable state changed.
      for (const state of this.gateways.values()) {
        if (state.hermesAgentId !== reservation.hermesAgentId) continue
        const isExactCandidate = candidateOpen &&
          state.gatewayId === reservation.gatewayId &&
          state.gatewayConnectionId === reservation.gatewayConnectionId
        if (isExactCandidate) continue

        quarantinedGatewayIds.add(state.gatewayId)
        state.gatewayCredentialState = state.gatewayId === reservation.gatewayId ? 'active' : 'revoked'
        state.routable = false
        state.online = false
        state.agentOnline = false
        logRouter('warn', state.gatewayId === reservation.gatewayId
          ? 'gateway.credential.activation_invalidated'
          : 'gateway.credential.connection_revoked', state.gatewayId === reservation.gatewayId
          ? 'Gateway activation reservation changed before runtime commit.'
          : 'Gateway credential connection was revoked after rotation.', {
          gatewayId: state.gatewayId,
          hermesAgentId: state.hermesAgentId,
          gatewayConnectionId: state.gatewayConnectionId,
          reservedGatewayConnectionId: reservation.gatewayConnectionId,
        })
        const socket = state.socket
        if (socket && socket.readyState <= 1) {
          try {
            socket.close(
              state.gatewayId === reservation.gatewayId ? 4410 : 4403,
              state.gatewayId === reservation.gatewayId
                ? 'gateway activation retry required'
                : 'gateway credential rotated',
            )
          } catch (error) {
            logRouter('warn', 'gateway.quarantine.close_failed', 'Router could not close the quarantined Gateway transport.', {
              gatewayId: state.gatewayId,
              hermesAgentId: state.hermesAgentId,
              gatewayConnectionId: state.gatewayConnectionId,
            }, error)
            try {
              socket.terminate()
            } catch {
              // Runtime state is already non-routable; socket cleanup remains best effort.
            }
          }
        }
      }

      if (!candidateOpen || !candidate) {
        logRouter('warn', 'gateway.credential.activation_deferred', 'Gateway credential activation requires a new claim attempt.', {
          gatewayId: reservation.gatewayId,
          hermesAgentId: reservation.hermesAgentId,
          gatewayConnectionId: reservation.gatewayConnectionId,
          reason,
          quarantinedGatewayCount: quarantinedGatewayIds.size,
        })
        return {
          activated: false,
          reservation,
          quarantinedGatewayIds: [...quarantinedGatewayIds],
          reason,
        }
      }

      this.liveness.recordSocketReady(
        candidate.hermesAgentId,
        candidate.gatewayConnectionId,
      )
      const gateway = this.publicState(candidate)
      logRouter('info', 'gateway.credential.activated', 'Gateway credential became the active route.', {
        gatewayId: candidate.gatewayId,
        hermesAgentId: candidate.hermesAgentId,
        gatewayConnectionId: candidate.gatewayConnectionId,
        quarantinedGatewayCount: quarantinedGatewayIds.size,
      })
      return {
        activated: true,
        reservation,
        gateway,
        quarantinedGatewayIds: [...quarantinedGatewayIds],
      }
    } catch (error) {
      // A durable claim must never leave an older runtime route available just
      // because runtime reconciliation hit an unexpected error. Quarantine is
      // deliberately best effort and this method never throws; the caller can
      // return a retryable response and safely repeat the exact claim.
      for (const state of this.gateways.values()) {
        if (state.hermesAgentId !== reservation.hermesAgentId) continue
        quarantinedGatewayIds.add(state.gatewayId)
        state.routable = false
        state.online = false
        state.agentOnline = false
        try {
          if (state.socket && state.socket.readyState <= 1) state.socket.close(4410, 'gateway activation retry required')
        } catch {
          try {
            state.socket?.terminate()
          } catch {
            // Runtime state is already non-routable.
          }
        }
      }
      logRouter('error', 'gateway.credential.activation_failed', 'Gateway credential activation failed without replacing the active route.', {
        gatewayId: reservation.gatewayId,
        hermesAgentId: reservation.hermesAgentId,
        gatewayConnectionId: reservation.gatewayConnectionId,
        quarantinedGatewayCount: quarantinedGatewayIds.size,
      }, error)
      return {
        activated: false,
        reservation,
        quarantinedGatewayIds: [...quarantinedGatewayIds],
        reason: 'sync_failed',
      }
    }
  }

  heartbeatSnapshotByAgentId(hermesAgentId?: string): GatewayHeartbeatResult {
    const state = hermesAgentId
      ? this.gatewayForAgent(hermesAgentId)
      : [...this.gateways.values()].find(item => item.gatewayCredentialState === 'active' && item.online && item.socket?.readyState === 1)
    const resolvedAgentId = hermesAgentId || state?.hermesAgentId
    const liveness = resolvedAgentId
      ? this.liveness.snapshot(resolvedAgentId)
      : { kind: 'offline', reason: 'Gateway offline' } as const
    const socketOpen = Boolean(
      state?.socket &&
      state.online &&
      state.socket.readyState === 1,
    )
    const online = socketOpen && liveness.kind !== 'offline'
    const agentOnline = Boolean(online && state?.agentOnline)
    const routable = Boolean(agentOnline && state?.routable)
    let error: string | undefined
    if (liveness.kind === 'suspect') error = 'Gateway heartbeat suspect'
    else if (liveness.kind === 'offline') error = liveness.reason
    else if (online && !agentOnline) error = 'Hermes Agent runtime is unavailable'
    else if (!online) error = 'Gateway offline'
    return {
      ok: routable && liveness.kind === 'healthy',
      gatewayId: state?.gatewayId,
      hermesAgentId: resolvedAgentId,
      gatewayConnectionId: state?.gatewayConnectionId,
      online,
      agentOnline,
      routable,
      lastSeenAt: state?.lastSeenAt,
      liveness: liveness.kind,
      ...(liveness.kind === 'healthy'
        ? { latencyMs: liveness.latencyMs }
        : {}),
      ...(liveness.kind === 'suspect'
        ? { consecutiveMisses: liveness.consecutiveMisses }
        : {}),
      ...(error ? { error } : {}),
    }
  }

  async heartbeatByAgentId(
    hermesAgentId?: string,
    timeoutMs = 6_000,
  ): Promise<GatewayHeartbeatResult> {
    const resolvedAgentId = hermesAgentId ||
      [...this.gateways.values()].find(
        item =>
          item.gatewayCredentialState === 'active' &&
          item.online &&
          item.socket?.readyState === 1,
      )?.hermesAgentId
    if (!resolvedAgentId) return this.heartbeatSnapshotByAgentId()
    await this.liveness.probe(resolvedAgentId, timeoutMs)
    return this.heartbeatSnapshotByAgentId(resolvedAgentId)
  }

  async requestByAgentId(hermesAgentId: string, payload: GatewayRpcRequest, timeoutMs = 10_000): Promise<GatewayRpcResponse> {
    const state = this.gatewayForAgent(hermesAgentId)
    if (!state?.socket || !state.online || state.socket.readyState !== 1) throw new Error('Gateway offline')
    if (!state.agentOnline || !state.routable) {
      throw Object.assign(new Error('Hermes Agent runtime is unavailable'), { code: 'agent_unavailable' })
    }
    const id = `rpc_${randomUUID()}`
    const startedAt = Date.now()
    const message = JSON.stringify({ type: 'rpc_request', id, ...payload, timeoutMs })
    logRouter('info', 'gateway.rpc.request_sent', 'Router dispatched an RPC to the routable Gateway.', {
      hermesAgentId,
      requestId: id,
      method: payload.method,
      path: logPath(payload.path),
      queryKeys: queryKeys(payload.path),
      timeoutMs,
      bodyBase64Bytes: payload.bodyBase64?.length,
      nextAction: 'none',
    })
    return new Promise<GatewayRpcResponse>((resolve, reject) => {
      const timeout = setTimeout(() => {
        state.pending.delete(id)
        state.inFlightRpc = state.pending.size + state.pendingNative.size
        const cancelDispatched = state.capabilities?.includes('rpc.cancel') === true
        this.requestTombstones.recordTimeout({
          hermesAgentId,
          gatewayId: state.gatewayId,
          gatewayConnectionId: state.gatewayConnectionId,
          requestId: id,
          startedAt,
          cancelDispatched,
        })
        logRouter('warn', 'gateway.rpc.failed', 'Gateway RPC timed out; generic cancellation is handled separately when supported.', {
          hermesAgentId,
          requestId: id,
          method: payload.method,
          path: logPath(payload.path),
          queryKeys: queryKeys(payload.path),
          timeoutMs,
          durationMs: elapsedMs(startedAt),
          errorCode: 'gateway_rpc_timeout',
          nextAction: cancelDispatched ? 'none' : 'user_action_required',
        })
        if (cancelDispatched) {
          const cancelMessage = JSON.stringify({ type: 'rpc_cancel', id })
          if (!state.socket || state.socket.readyState !== 1) {
            this.requestTombstones.recordCancelDispatchFailure({
              hermesAgentId,
              gatewayConnectionId: state.gatewayConnectionId,
              requestId: id,
            })
          } else {
            state.socket.send(cancelMessage, error => {
              if (!error) return
              this.requestTombstones.recordCancelDispatchFailure({
                hermesAgentId,
                gatewayConnectionId: state.gatewayConnectionId,
                requestId: id,
              })
              logRouter('warn', 'gateway.rpc.cancelled', 'Router could not dispatch the supported generic RPC cancellation.', {
                hermesAgentId,
                requestId: id,
                errorCode: 'gateway_rpc_cancel_failed',
                nextAction: 'user_action_required',
              }, error)
            })
          }
        }
        reject(Object.assign(new Error('Gateway RPC timeout'), {
          statusCode: 504,
          code: 'gateway_rpc_timeout',
        }))
      }, timeoutMs)
      state.pending.set(id, { resolve, reject, timeout, startedAt })
      state.inFlightRpc = state.pending.size + state.pendingNative.size
      state.socket?.send(message, error => {
        if (!error) return
        clearTimeout(timeout)
        state.pending.delete(id)
        state.inFlightRpc = state.pending.size + state.pendingNative.size
        logRouter('warn', 'gateway.rpc.failed', 'Router could not send the RPC to the connected Gateway.', {
          hermesAgentId,
          requestId: id,
          method: payload.method,
          path: logPath(payload.path),
          queryKeys: queryKeys(payload.path),
          durationMs: elapsedMs(startedAt),
          errorCode: 'gateway_rpc_send_failed',
          nextAction: 'reconnect',
        }, error)
        reject(error)
      })
    })
  }

  requestLifecycleMetricsByAgentId(
    hermesAgentId: string,
  ): GatewayRequestLifecycleMetrics {
    return this.requestTombstones.snapshot(hermesAgentId)
  }

  operationalMetricsByAgentId(
    hermesAgentId: string,
  ): GatewayCombinedOperationalMetrics {
    const state = this.gatewayForAgent(hermesAgentId)
    return this.operationalMetricsForState(hermesAgentId, state)
  }

  async submitSessionByAgentId(
    hermesAgentId: string,
    payload: GatewaySessionSubmit,
    timeoutMs = 10_000,
  ): Promise<GatewayNativeAck> {
    const supportsCommandPresentation = this.gatewayForAgent(
      hermesAgentId,
    )?.capabilities?.includes('session.command-presentation') === true
    return this.nativeRequestByAgentId(
      hermesAgentId,
      'session_submit',
      payload.laneId,
      {
        laneId: payload.laneId,
        submissionId: payload.submissionId,
        text: payload.text,
        deviceId: payload.deviceId,
        ...(payload.model ? { model: payload.model } : {}),
        ...(payload.provider ? { provider: payload.provider } : {}),
        ...(payload.reasoningEffort ? { reasoningEffort: payload.reasoningEffort } : {}),
        ...(payload.fast !== undefined ? { fast: payload.fast } : {}),
        ...(payload.presentation === 'command' && supportsCommandPresentation
          ? { presentation: payload.presentation }
          : {}),
        ...(payload.attachmentIds?.length ? { attachmentIds: payload.attachmentIds } : {}),
      },
      { submissionId: payload.submissionId },
      timeoutMs,
    )
  }

  async respondPromptByAgentId(
    hermesAgentId: string,
    payload: GatewayPromptResponse,
    timeoutMs = 10_000,
  ): Promise<GatewayNativeAck> {
    return this.nativeRequestByAgentId(
      hermesAgentId,
      'session_prompt_response',
      payload.laneId,
      {
        laneId: payload.laneId,
        promptId: payload.promptId,
        response: payload.response,
      },
      { promptId: payload.promptId },
      timeoutMs,
    )
  }

  private async nativeRequestByAgentId(
    hermesAgentId: string,
    requestType: GatewayNativeAck['requestType'],
    laneId: string,
    payload: Record<string, unknown>,
    correlation: { submissionId?: string; promptId?: string },
    timeoutMs: number,
  ): Promise<GatewayNativeAck> {
    const state = this.gatewayForAgent(hermesAgentId)
    if (!state?.socket || !state.online || state.socket.readyState !== 1) {
      throw Object.assign(new Error('Gateway offline'), { code: 'gateway_offline' })
    }
    if (!state.agentOnline || !state.routable) {
      throw Object.assign(new Error('Hermes Agent runtime is unavailable'), { code: 'agent_unavailable' })
    }
    const requiredCapability = requestType === 'session_submit'
      ? 'session.message'
      : 'session.prompt-response'
    if (!state.capabilities?.includes(requiredCapability)) {
      throw Object.assign(new Error(`Gateway capability is unavailable: ${requiredCapability}`), {
        code: 'gateway_capability_unsupported',
        statusCode: 501,
      })
    }
    if (
      requestType === 'session_submit' &&
      typeof payload.model === 'string' &&
      !state.capabilities?.includes('session.model-selection')
    ) {
      throw Object.assign(new Error('Gateway capability is unavailable: session.model-selection'), {
        code: 'gateway_capability_unsupported',
        statusCode: 501,
      })
    }
    if (
      requestType === 'session_submit' &&
      (typeof payload.reasoningEffort === 'string' || typeof payload.fast === 'boolean') &&
      !state.capabilities?.includes('session.runtime-controls')
    ) {
      throw Object.assign(new Error('Gateway capability is unavailable: session.runtime-controls'), {
        code: 'gateway_capability_unsupported',
        statusCode: 501,
      })
    }
    const id = `native_${randomUUID()}`
    const startedAt = Date.now()
    const message = JSON.stringify({ type: requestType, id, ...payload })
    const story = requestType === 'session_submit'
      ? 'session.submit'
      : 'session.prompt_response'
    logRouter('info', `${story}.request_sent`, requestType === 'session_submit'
      ? 'Router dispatched the native session submission to Gateway.'
      : 'Router dispatched the native prompt response to Gateway.', {
      hermesAgentId,
      requestId: id,
      requestType,
      laneId,
      submissionId: correlation.submissionId,
      promptId: correlation.promptId,
      timeoutMs,
      nextAction: 'await_gateway_ack',
    })
    return new Promise<GatewayNativeAck>((resolve, reject) => {
      const rejectAmbiguous = (reason: string): void => {
        state.pendingNative.delete(id)
        state.inFlightRpc = state.pending.size + state.pendingNative.size
        reject(Object.assign(new Error(reason), { code: 'gateway_submission_ambiguous' }))
      }
      const timeout = setTimeout(() => {
        logRouter('warn', `${story}.ambiguous`, 'Gateway acknowledgement timed out; the native request will not be replayed.', {
          hermesAgentId,
          requestId: id,
          requestType,
          laneId,
          submissionId: correlation.submissionId,
          promptId: correlation.promptId,
          durationMs: elapsedMs(startedAt),
          errorCode: 'gateway_submission_ambiguous',
          nextAction: 'hydrate',
        })
        rejectAmbiguous('Gateway native session acknowledgement timed out')
      }, timeoutMs)
      state.pendingNative.set(id, {
        resolve,
        reject,
        timeout,
        startedAt,
        requestType,
        laneId,
        ...correlation,
      })
      state.inFlightRpc = state.pending.size + state.pendingNative.size
      state.socket?.send(message, error => {
        if (!error) return
        clearTimeout(timeout)
        logRouter('warn', `${story}.ambiguous`, 'Gateway send outcome is unknown; the native request will not be replayed.', {
          hermesAgentId,
          requestId: id,
          requestType,
          laneId,
          submissionId: correlation.submissionId,
          promptId: correlation.promptId,
          errorCode: 'gateway_submission_ambiguous',
          nextAction: 'hydrate',
        }, error)
        rejectAmbiguous('Gateway native session send failed ambiguously')
      })
    })
  }

  private handleMessage(state: TrackedGateway, data: RawData): void {
    state.lastSeenAt = nowSeconds()
    const text = data.toString()
    if (text === 'ping') {
      if (!state.online) {
        state.socket?.close(4401, 'gateway hello required')
        return
      }
      state.socket?.send('pong')
      return
    }
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(text) as Record<string, unknown>
    } catch {
      if (!state.online) {
        state.socket?.close(4401, 'gateway hello required')
        return
      }
      logRouter('debug', 'gateway.message.non_json_ignored', 'Router ignored a non-JSON Gateway frame.', {
        hermesAgentId: state.hermesAgentId,
        receivedBytes: Buffer.byteLength(text)
      })
      state.socket?.send(JSON.stringify({ type: 'ack', hermesAgentId: state.hermesAgentId, receivedBytes: Buffer.byteLength(text) }))
      return
    }
    if (!state.online && parsed.type !== 'hello') {
      logRouter('warn', 'gateway.message.rejected_before_handshake', 'Router rejected a Gateway frame received before hello.', {
        gatewayId: state.gatewayId,
        hermesAgentId: state.hermesAgentId,
        gatewayConnectionId: state.gatewayConnectionId,
        messageType: typeof parsed.type === 'string' ? parsed.type : 'unknown',
      })
      state.socket?.close(4401, 'gateway hello required')
      return
    }
    if (parsed.type === 'session_submit_ack' && typeof parsed.id === 'string') {
      const pending = state.pendingNative.get(parsed.id)
      if (!pending) {
        logRouter('warn', 'session.submit.ack_unknown', 'Router ignored a native acknowledgement for an unknown request.', {
          hermesAgentId: state.hermesAgentId,
          requestId: parsed.id,
        })
        return
      }
      state.pendingNative.delete(parsed.id)
      state.inFlightRpc = state.pending.size + state.pendingNative.size
      clearTimeout(pending.timeout)
      try {
        const acknowledgement = cleanNativeAck(parsed, pending)
        const story = acknowledgement.requestType === 'session_submit'
          ? 'session.submit'
          : 'session.prompt_response'
        logRouter(
          acknowledgement.accepted ? 'info' : 'warn',
          acknowledgement.accepted ? `${story}.accepted` : `${story}.failed`,
          acknowledgement.accepted
            ? 'Gateway accepted the native session request.'
            : 'Gateway rejected the native session request before execution.',
          {
          hermesAgentId: state.hermesAgentId,
          requestId: parsed.id,
          requestType: acknowledgement.requestType,
          laneId: acknowledgement.laneId,
          submissionId: acknowledgement.submissionId,
          promptId: acknowledgement.promptId,
          sessionId: acknowledgement.sessionId,
          errorCode: acknowledgement.code,
          durationMs: elapsedMs(pending.startedAt),
          nextAction: acknowledgement.accepted ? 'await_realtime_event' : 'user_action_required',
          },
        )
        pending.resolve(acknowledgement)
      } catch (error) {
        pending.reject(error instanceof Error ? error : new Error(String(error)))
        state.socket?.close(4400, 'invalid native session acknowledgement')
      }
      return
    }
    if (parsed.type === 'session_event') {
      try {
        const event = cleanSessionEvent(parsed, state)
        if (!this.sessionEventHandler?.(event)) {
          throw new Error('Gateway session event does not match a registered lane')
        }
        const submissionKey = `${state.hermesAgentId}:${event.submissionId}`
        if (!this.firstSessionEventBySubmission.has(submissionKey)) {
          this.firstSessionEventBySubmission.add(submissionKey)
          if (this.firstSessionEventBySubmission.size > 4096) {
            const oldest = this.firstSessionEventBySubmission.values().next().value
            if (oldest !== undefined) this.firstSessionEventBySubmission.delete(oldest)
          }
          logRouter('info', 'session.event.first_received', 'Router received the first typed event for the native submission.', {
            hermesAgentId: state.hermesAgentId,
            sessionId: event.sessionId,
            submissionId: event.submissionId,
            eventId: event.eventId,
            nativeEvent: event.event,
            nextAction: 'none',
          })
        }
        if (event.event === 'processing.completed') {
          this.firstSessionEventBySubmission.delete(submissionKey)
          logRouter('info', 'session.processing.completed', 'Router observed native processing completion; the client can hydrate the canonical transcript.', {
            hermesAgentId: state.hermesAgentId,
            sessionId: event.sessionId,
            submissionId: event.submissionId,
            eventId: event.eventId,
            nextAction: 'hydrate',
          })
        }
      } catch (error) {
        logRouter('warn', 'session.event.rejected', 'Router rejected a malformed native session event.', {
          hermesAgentId: state.hermesAgentId,
          gatewayId: state.gatewayId,
          eventId: typeof parsed.eventId === 'string' ? parsed.eventId : undefined,
          event: typeof parsed.event === 'string' ? parsed.event : undefined,
        }, error)
        state.socket?.close(4400, 'invalid native session event')
      }
      return
    }
    if (parsed.type === 'runtime_snapshot') {
      try {
        const snapshot = cleanRuntimeSnapshot(parsed, state)
        this.runtimeSnapshots.set(
          this.runtimeSnapshotKey(snapshot.hermesAgentId, snapshot.scope === 'session' ? snapshot.sessionId : undefined),
          snapshot,
        )
        const requestId = typeof parsed.id === 'string' ? parsed.id : undefined
        if (requestId) {
          const pending = state.pendingRuntimeSnapshots.get(requestId)
          if (pending) {
            if (pending.sessionId && pending.sessionId !== snapshot.sessionId) {
              throw new Error('Gateway runtime snapshot request session mismatch')
            }
            state.pendingRuntimeSnapshots.delete(requestId)
            clearTimeout(pending.timeout)
            pending.resolve(snapshot)
          }
        }
        this.runtimeSnapshotHandler?.(snapshot)
        logRouter('debug', 'gateway.runtime_snapshot.accepted', 'Router accepted a Gateway runtime snapshot.', {
          hermesAgentId: snapshot.hermesAgentId,
          gatewayId: snapshot.gatewayId,
          scope: snapshot.scope,
          hasSession: Boolean(snapshot.sessionId),
          revision: snapshot.snapshot.revision,
        })
      } catch (error) {
        logRouter('warn', 'gateway.runtime_snapshot.rejected', 'Router rejected a malformed Gateway runtime snapshot.', {
          hermesAgentId: state.hermesAgentId,
          gatewayId: state.gatewayId,
        }, error)
        state.socket?.close(4400, 'invalid runtime snapshot')
      }
      return
    }
    if (parsed.type === 'operational_snapshot') {
      try {
        state.operationalSnapshot = cleanGatewayOperationalSnapshot(
          parsed,
          state,
        )
        state.operationalReceivedAt = Date.now()
        logRouter('debug', 'gateway.operational_snapshot.accepted', 'Router accepted a Gateway operational snapshot.', {
          hermesAgentId: state.hermesAgentId,
          gatewayId: state.gatewayId,
          eventLoopSignal: state.operationalSnapshot.eventLoop.signal,
          fileDescriptorSignal:
            state.operationalSnapshot.fileDescriptors.signal,
        })
      } catch (error) {
        logRouter('warn', 'gateway.operational_snapshot.rejected', 'Router rejected a malformed Gateway operational snapshot.', {
          hermesAgentId: state.hermesAgentId,
          gatewayId: state.gatewayId,
        }, error)
        state.socket?.close(4400, 'invalid operational snapshot')
      }
      return
    }
    if (parsed.type === 'agent_status') {
      const sidecarTransport = state.runtime === 'hermes-hub-gateway-sidecar' && state.mode === 'sidecar'
      const identityMatches = parsed.gatewayId === state.gatewayId && parsed.hermesAgentId === state.hermesAgentId
      if (!state.online || !sidecarTransport || !identityMatches || typeof parsed.online !== 'boolean') {
        logRouter('warn', 'gateway.agent_status.rejected', 'Router rejected a malformed Gateway Agent status.', {
          gatewayId: state.gatewayId,
          hermesAgentId: state.hermesAgentId,
          gatewayConnectionId: state.gatewayConnectionId,
        })
        state.socket?.close(4400, 'invalid sidecar agent status')
        return
      }
      const capabilities = Array.isArray(parsed.capabilities)
        ? parsed.capabilities
          .filter((item): item is string => typeof item === 'string' && item.length > 0)
          .map(item => item.slice(0, 120))
          .slice(0, 64)
        : []
      const protocols = Array.isArray(parsed.protocols)
        ? parsed.protocols.filter((item): item is string => typeof item === 'string').slice(0, 8)
        : []
      if (
        parsed.online && (
          parsed.runtime !== 'hermes-hub-gateway' ||
          parsed.mode !== 'native-session' ||
          !protocols.includes(this.options.protocol) ||
          !capabilities.includes('session.message') ||
          !capabilities.includes('session.prompt-response')
        )
      ) {
        logRouter('warn', 'gateway.agent_contract.rejected', 'Router rejected a malformed Gateway Agent contract.', {
          gatewayId: state.gatewayId,
          hermesAgentId: state.hermesAgentId,
          gatewayConnectionId: state.gatewayConnectionId,
          capabilityCount: capabilities.length,
        })
        state.socket?.close(4406, 'native session agent bridge required')
        return
      }
      state.agentOnline = parsed.online
      state.capabilities = parsed.online ? capabilities : []
      state.routable = parsed.online && state.gatewayCredentialState === 'active'
      state.lastSeenAt = nowSeconds()
      logRouter(parsed.online ? 'info' : 'warn', parsed.online
        ? 'gateway.agent_bridge.online'
        : 'gateway.agent_bridge.offline', parsed.online
        ? 'Gateway reported the Agent bridge online.'
        : 'Gateway reported the Agent bridge offline.', {
        gatewayId: state.gatewayId,
        hermesAgentId: state.hermesAgentId,
        gatewayConnectionId: state.gatewayConnectionId,
        routable: state.routable,
        capabilityCount: state.capabilities.length,
      })
      return
    }
    if (parsed.type === 'rpc_cancel_ack' && typeof parsed.id === 'string') {
      const outcome = (
        parsed.outcome === 'cancelled' ||
        parsed.outcome === 'not_found' ||
        parsed.outcome === 'already_completed'
      )
        ? parsed.outcome as GatewayRpcCancelOutcome
        : undefined
      if (!outcome) {
        logRouter('warn', 'gateway.rpc.cancel_ack_rejected', 'Router rejected a malformed RPC cancellation acknowledgement.', {
          hermesAgentId: state.hermesAgentId,
          requestId: parsed.id,
        })
        state.socket?.close(4400, 'invalid rpc cancel acknowledgement')
        return
      }
      const classification = this.requestTombstones.recordCancelAck({
        hermesAgentId: state.hermesAgentId,
        gatewayConnectionId: state.gatewayConnectionId,
        requestId: parsed.id,
        outcome,
      })
      logRouter(
        classification === 'recorded' ? 'info' : 'warn',
        classification === 'recorded'
          ? 'gateway.rpc.cancel_ack_received'
          : 'gateway.rpc.cancel_ack_ignored',
        classification === 'recorded'
          ? 'Router recorded the Gateway RPC cancellation acknowledgement.'
          : 'Router ignored an uncorrelated Gateway RPC cancellation acknowledgement.',
        {
          hermesAgentId: state.hermesAgentId,
          requestId: parsed.id,
          outcome,
          classification,
        },
      )
      return
    }
    if (parsed.type === 'rpc_response_start' && typeof parsed.id === 'string') {
      const pending = state.pending.get(parsed.id)
      if (!pending) return
      const status = typeof parsed.status === 'number' && parsed.status >= 100 && parsed.status <= 599
        ? parsed.status
        : 502
      const totalBytes = typeof parsed.totalBytes === 'number' ? parsed.totalBytes : -1
      const chunkCount = typeof parsed.chunkCount === 'number' ? parsed.chunkCount : -1
      const sha256 = typeof parsed.sha256 === 'string' ? parsed.sha256 : ''
      if (
        !Number.isSafeInteger(totalBytes) || totalBytes < 0 || totalBytes > maxGatewayRpcResponseBytes ||
        !Number.isSafeInteger(chunkCount) || chunkCount < 1 || chunkCount > maxGatewayRpcResponseChunks ||
        !/^[a-f0-9]{64}$/.test(sha256)
      ) {
        state.pending.delete(parsed.id)
        state.inFlightRpc = state.pending.size + state.pendingNative.size
        clearTimeout(pending.timeout)
        pending.reject(Object.assign(new Error('Gateway RPC response is too large or malformed'), {
          statusCode: 413,
          code: 'response_too_large',
        }))
        return
      }
      pending.chunked = {
        status,
        headers: cleanHeaders(parsed.headers),
        totalBytes,
        chunkCount,
        sha256,
        nextIndex: 0,
        receivedBytes: 0,
        chunks: [],
      }
      return
    }
    if (parsed.type === 'global_event') {
      try {
        const event = cleanGlobalEvent(parsed, state)
        this.globalEventHandler?.(event)
        logRouter('debug', 'gateway.global_event.accepted', 'Router accepted a typed global event.', {
          hermesAgentId: state.hermesAgentId,
          gatewayId: state.gatewayId,
          eventId: event.eventId,
            nativeEvent: event.event,
        })
      } catch (error) {
        logRouter('warn', 'gateway.global_event.rejected', 'Router rejected a malformed global event.', {
          hermesAgentId: state.hermesAgentId,
          gatewayId: state.gatewayId,
          eventId: typeof parsed.eventId === 'string' ? parsed.eventId : undefined,
          event: typeof parsed.event === 'string' ? parsed.event : undefined,
        }, error)
        state.socket?.close(4400, 'invalid global event')
      }
      return
    }
    if (parsed.type === 'rpc_response_chunk' && typeof parsed.id === 'string') {
      const pending = state.pending.get(parsed.id)
      const chunked = pending?.chunked
      if (!pending || !chunked) return
      try {
        if (parsed.index !== chunked.nextIndex) throw new Error('Gateway RPC response chunks are out of order')
        const chunk = decodeStrictBase64(parsed.bodyBase64)
        if (chunk.length === 0 || chunked.receivedBytes + chunk.length > chunked.totalBytes) {
          throw new Error('Gateway RPC response chunk size is invalid')
        }
        chunked.chunks.push(chunk)
        chunked.receivedBytes += chunk.length
        chunked.nextIndex += 1
      } catch (error) {
        state.pending.delete(parsed.id)
        state.inFlightRpc = state.pending.size + state.pendingNative.size
        clearTimeout(pending.timeout)
        pending.reject(error instanceof Error ? error : new Error(String(error)))
      }
      return
    }
    if (parsed.type === 'rpc_response_end' && typeof parsed.id === 'string') {
      const pending = state.pending.get(parsed.id)
      const chunked = pending?.chunked
      if (!pending || !chunked) return
      state.pending.delete(parsed.id)
      state.inFlightRpc = state.pending.size + state.pendingNative.size
      clearTimeout(pending.timeout)
      try {
        if (
          chunked.nextIndex !== chunked.chunkCount ||
          chunked.receivedBytes !== chunked.totalBytes ||
          parsed.sha256 !== chunked.sha256
        ) throw new Error('Gateway RPC response chunks are incomplete')
        const body = Buffer.concat(chunked.chunks, chunked.receivedBytes)
        if (createHash('sha256').update(body).digest('hex') !== chunked.sha256) {
          throw new Error('Gateway RPC response digest mismatch')
        }
        logRouter(chunked.status >= 400 ? 'warn' : 'info', 'gateway.rpc.chunk_received', 'Router received one chunk of a Gateway RPC response.', {
          hermesAgentId: state.hermesAgentId,
          requestId: parsed.id,
          status: chunked.status,
          responseBytes: body.length,
          chunkCount: chunked.chunkCount,
          latencyMs: elapsedMs(pending.startedAt),
        })
        pending.resolve({
          status: chunked.status,
          headers: chunked.headers,
          bodyBase64: body.toString('base64'),
          metrics: { requestId: parsed.id, gatewayDispatchMs: elapsedMs(pending.startedAt), totalLatencyMs: elapsedMs(pending.startedAt), via: 'hermes-hub-gateway' },
        })
      } catch (error) {
        pending.reject(error instanceof Error ? error : new Error(String(error)))
      }
      return
    }
    if (parsed.type === 'rpc_response' && typeof parsed.id === 'string') {
      const pending = state.pending.get(parsed.id)
      if (!pending) {
        const classification = this.requestTombstones.classifyResponse({
          hermesAgentId: state.hermesAgentId,
          gatewayConnectionId: state.gatewayConnectionId,
          requestId: parsed.id,
        })
        logRouter(
          classification === 'late_after_timeout' ? 'info' : 'warn',
          classification === 'late_after_timeout'
            ? 'gateway.rpc.late_response_ignored'
            : 'gateway.rpc.unknown_response_ignored',
          classification === 'late_after_timeout'
            ? 'Router ignored a Gateway RPC response that arrived after its timeout.'
            : 'Router ignored a Gateway RPC response for an unknown request.',
          {
            hermesAgentId: state.hermesAgentId,
            requestId: parsed.id,
            classification,
          },
        )
        return
      }
      state.pending.delete(parsed.id)
      state.inFlightRpc = state.pending.size + state.pendingNative.size
      clearTimeout(pending.timeout)
      try {
        const response = cleanRpcResponse(parsed)
        logRouter(response.status >= 400 ? 'warn' : 'info', 'gateway.rpc.completed', 'Router received the complete Gateway RPC response.', {
          hermesAgentId: state.hermesAgentId,
          requestId: parsed.id,
          status: response.status,
          latencyMs: elapsedMs(pending.startedAt)
        })
        pending.resolve({
          ...response,
          metrics: { requestId: parsed.id, gatewayDispatchMs: elapsedMs(pending.startedAt), totalLatencyMs: elapsedMs(pending.startedAt), via: 'hermes-hub-gateway' }
        })
      } catch (error) {
        logRouter('warn', 'gateway.rpc.response_rejected', 'Router rejected a malformed Gateway RPC response.', {
          hermesAgentId: state.hermesAgentId,
          requestId: parsed.id
        }, error)
        pending.reject(error instanceof Error ? error : new Error(String(error)))
      }
      return
    }
    if (parsed.type === 'heartbeat_ack' && typeof parsed.id === 'string') {
      const pending = state.pendingHeartbeats.get(parsed.id)
      if (!pending) {
        logRouter('debug', 'gateway.heartbeat.ack_unknown', 'Router ignored a heartbeat acknowledgement for an unknown request.', {
          hermesAgentId: state.hermesAgentId,
          requestId: parsed.id
        })
        return
      }
      if (parsed.gatewayId !== state.gatewayId || parsed.hermesAgentId !== state.hermesAgentId) {
        state.pendingHeartbeats.delete(parsed.id)
        clearTimeout(pending.timeout)
        state.online = false
        state.agentOnline = false
        state.routable = false
        state.lastSeenAt = nowSeconds()
        logRouter('warn', 'gateway.heartbeat.identity_rejected', 'Router rejected a heartbeat acknowledgement with mismatched identity.', {
          gatewayId: state.gatewayId,
          hermesAgentId: state.hermesAgentId,
          gatewayConnectionId: state.gatewayConnectionId,
          requestId: parsed.id,
        })
        pending.resolve({
          ok: false,
          reason: 'Gateway heartbeat identity mismatch',
          fatal: true,
        })
        state.socket?.close(4403, 'gateway heartbeat identity mismatch')
        return
      }
      state.pendingHeartbeats.delete(parsed.id)
      clearTimeout(pending.timeout)
      logRouter('debug', 'gateway.heartbeat.ack_received', 'Router received a valid Gateway heartbeat acknowledgement.', {
        hermesAgentId: state.hermesAgentId,
        requestId: parsed.id,
        latencyMs: Date.now() - pending.startedAt
      })
      pending.resolve({
        ok: true,
        latencyMs: Date.now() - pending.startedAt,
      })
      return
    }
    if (parsed.type === 'hello') {
      if (state.online) {
        state.socket?.close(4400, 'duplicate gateway hello')
        return
      }
      if (parsed.gatewayId !== state.gatewayId || parsed.hermesAgentId !== state.hermesAgentId) {
        logRouter('warn', 'gateway.handshake.identity_rejected', 'Router rejected Gateway hello identity.', {
          gatewayId: state.gatewayId,
          hermesAgentId: state.hermesAgentId,
          gatewayConnectionId: state.gatewayConnectionId,
        })
        state.socket?.close(4403, 'gateway identity mismatch')
        return
      }
      const protocols = Array.isArray(parsed.protocols)
        ? parsed.protocols.filter((item): item is string => typeof item === 'string').slice(0, 8)
        : []
      if (!protocols.includes(this.options.protocol)) {
        logRouter('warn', 'gateway.handshake.protocol_rejected', 'Router rejected an unsupported Gateway protocol.', {
          gatewayId: state.gatewayId,
          hermesAgentId: state.hermesAgentId,
          gatewayConnectionId: state.gatewayConnectionId,
          protocols,
        })
        state.socket?.close(4406, 'gateway protocol mismatch')
        return
      }
      state.runtime = typeof parsed.runtime === 'string' && parsed.runtime.trim() ? parsed.runtime.trim().slice(0, 80) : 'unknown'
      state.mode = typeof parsed.mode === 'string' && parsed.mode.trim() ? parsed.mode.trim().slice(0, 80) : 'unknown'
      state.protocols = protocols
      const capabilities = Array.isArray(parsed.capabilities)
        ? parsed.capabilities
          .filter((item): item is string => typeof item === 'string' && item.length > 0)
          .map(item => item.slice(0, 120))
          .slice(0, 64)
        : []
      state.capabilities = capabilities
      const sidecarTransport = state.runtime === 'hermes-hub-gateway-sidecar' && state.mode === 'sidecar'
      if (sidecarTransport && (capabilities.length > 0 || parsed.agentOnline === true)) {
        logRouter('warn', 'gateway.handshake.contract_rejected', 'Router rejected an unsupported Gateway Sidecar contract.', {
          gatewayId: state.gatewayId,
          hermesAgentId: state.hermesAgentId,
          gatewayConnectionId: state.gatewayConnectionId,
        })
        state.socket?.close(4406, 'sidecar transport hello must start Agent-offline')
        return
      }
      if (!sidecarTransport && (
        state.mode !== 'native-session' ||
        !state.capabilities?.includes('session.message') ||
        !state.capabilities.includes('session.prompt-response')
      )) {
        logRouter('warn', 'gateway.handshake.native_contract_rejected', 'Router rejected an unsupported native session contract.', {
          gatewayId: state.gatewayId,
          hermesAgentId: state.hermesAgentId,
          gatewayConnectionId: state.gatewayConnectionId,
          mode: state.mode,
          capabilities: state.capabilities,
        })
        state.socket?.close(4406, 'native session gateway required')
        return
      }
      if (state.helloTimeout) clearTimeout(state.helloTimeout)
      state.helloTimeout = undefined
      state.online = true
      state.agentOnline = !sidecarTransport
      state.routable = state.gatewayCredentialState === 'active' && state.agentOnline
      if (state.gatewayCredentialState === 'active') {
        this.liveness.recordSocketReady(
          state.hermesAgentId,
          state.gatewayConnectionId,
        )
      }
      logRouter('info', 'gateway.handshake.completed', 'Router authenticated the Gateway hello.', {
        gatewayId: state.gatewayId,
        hermesAgentId: state.hermesAgentId,
        gatewayConnectionId: state.gatewayConnectionId,
        connectionKind: state.connectionKind,
        gatewayCredentialState: state.gatewayCredentialState,
        routable: state.routable,
        runtime: state.runtime,
        mode: state.mode,
        protocols: state.protocols,
        capabilities: state.capabilities,
        agentOnline: state.agentOnline,
      })
      state.socket?.send(JSON.stringify({
        type: 'hello_ack',
        gatewayId: state.gatewayId,
        hermesAgentId: state.hermesAgentId,
        gatewayConnectionId: state.gatewayConnectionId,
        protocol: this.options.protocol,
        protocols: this.options.protocols,
        gatewayCredentialState: state.gatewayCredentialState,
        routable: state.routable,
        agentOnline: state.agentOnline,
      }))
      return
    }
    logRouter('debug', 'gateway.message.acknowledged', 'Router acknowledged the Gateway frame.', {
      hermesAgentId: state.hermesAgentId,
      connectionKind: state.connectionKind,
      messageType: typeof parsed.type === 'string' ? parsed.type : 'unknown',
      receivedBytes: Buffer.byteLength(text)
    })
    state.socket?.send(JSON.stringify({
      type: 'ack',
      gatewayId: state.gatewayId,
      hermesAgentId: state.hermesAgentId,
      gatewayConnectionId: state.gatewayConnectionId,
      receivedBytes: Buffer.byteLength(text),
    }))
  }

  private livenessProbeFor(
    hermesAgentId: string,
    timeoutMs: number,
  ): GatewayLivenessProbe | null {
    const state = this.gatewayForAgent(hermesAgentId)
    if (!state?.socket || !state.online || state.socket.readyState !== 1) {
      return null
    }
    const gatewayConnectionId = state.gatewayConnectionId
    return {
      gatewayConnectionId,
      run: () => this.sendHeartbeatProbe(state, timeoutMs),
      close: reason => {
        const current = this.gatewayForAgent(hermesAgentId)
        if (!current ||
            current.gatewayConnectionId !== gatewayConnectionId) {
          return
        }
        current.online = false
        current.agentOnline = false
        current.routable = false
        current.lastSeenAt = nowSeconds()
        logRouter('warn', 'gateway.liveness.offline', 'Router marked the Gateway offline after bounded liveness misses.', {
          gatewayId: current.gatewayId,
          hermesAgentId,
          gatewayConnectionId,
          reason,
        })
        if (current.socket && current.socket.readyState <= 1) {
          current.socket.terminate()
        }
      },
    }
  }

  private sendHeartbeatProbe(
    state: TrackedGateway,
    timeoutMs: number,
  ): Promise<GatewayLivenessProbeOutcome> {
    const current = this.gatewayForAgent(state.hermesAgentId)
    if (!state.socket ||
        state.socket.readyState !== 1 ||
        current?.gatewayConnectionId !== state.gatewayConnectionId) {
      return Promise.resolve({
        ok: false,
        reason: 'Gateway offline',
      })
    }
    const id = `hb_${randomUUID()}`
    const startedAt = Date.now()
    return new Promise<GatewayLivenessProbeOutcome>(resolve => {
      const timeout = setTimeout(() => {
        state.pendingHeartbeats.delete(id)
        logRouter('warn', 'gateway.heartbeat.timed_out', 'Gateway heartbeat acknowledgement did not arrive before the deadline.', {
          gatewayId: state.gatewayId,
          hermesAgentId: state.hermesAgentId,
          gatewayConnectionId: state.gatewayConnectionId,
          requestId: id,
          timeoutMs,
        })
        resolve({
          ok: false,
          reason: 'Gateway heartbeat timeout',
        })
      }, timeoutMs)
      state.pendingHeartbeats.set(id, { resolve, timeout, startedAt })
      state.socket?.send(
        JSON.stringify({ type: 'heartbeat', id, sentAt: startedAt }),
        error => {
          if (!error || !state.pendingHeartbeats.has(id)) return
          clearTimeout(timeout)
          state.pendingHeartbeats.delete(id)
          logRouter('warn', 'gateway.heartbeat.send_failed', 'Router could not send a Gateway heartbeat probe.', {
            gatewayId: state.gatewayId,
            hermesAgentId: state.hermesAgentId,
            gatewayConnectionId: state.gatewayConnectionId,
            requestId: id,
          }, error)
          resolve({
            ok: false,
            reason: 'Gateway heartbeat send failed',
          })
        },
      )
    })
  }

  private probeOnlineGateways(): void {
    const agentIds = new Set(
      [...this.gateways.values()]
        .filter(state =>
          state.gatewayCredentialState === 'active' &&
          state.online &&
          state.socket?.readyState === 1)
        .map(state => state.hermesAgentId),
    )
    for (const hermesAgentId of agentIds) {
      void this.liveness.probe(hermesAgentId).catch(error => {
        logRouter('warn', 'gateway.liveness.probe_failed', 'Gateway liveness supervisor could not complete its probe.', {
          hermesAgentId,
        }, error)
      })
    }
  }

  private gatewayForAgent(hermesAgentId: string): TrackedGateway | undefined {
    return [...this.gateways.values()]
      .filter(item => item.hermesAgentId === hermesAgentId && item.gatewayCredentialState === 'active')
      .sort((left, right) => {
        const leftReady = left.online && left.socket?.readyState === 1 ? 1 : 0
        const rightReady = right.online && right.socket?.readyState === 1 ? 1 : 0
        return rightReady - leftReady || right.connectedAt - left.connectedAt
      })[0]
  }

  private runtimeSnapshotKey(hermesAgentId: string, sessionId?: string): string {
    return `${hermesAgentId}:${sessionId ? `session:${sessionId}` : 'agent'}`
  }

  private publicState(state: TrackedGateway): GatewayState {
    return {
      gatewayId: state.gatewayId,
      hermesAgentId: state.hermesAgentId,
      gatewayConnectionId: state.gatewayConnectionId,
      connectionKind: state.connectionKind,
      gatewayCredentialState: state.gatewayCredentialState,
      routable: state.routable,
      connectedAt: state.connectedAt,
      lastSeenAt: state.lastSeenAt,
      online: state.online,
      agentOnline: state.agentOnline,
      inFlightRpc: state.inFlightRpc,
      runtime: state.runtime,
      mode: state.mode,
      ...(state.protocols?.length ? { protocols: state.protocols } : {}),
      ...(state.capabilities?.length ? { capabilities: state.capabilities } : {}),
      operational: this.operationalMetricsForState(
        state.hermesAgentId,
        state,
      ),
    }
  }

  private operationalMetricsForState(
    hermesAgentId: string,
    state?: TrackedGateway,
  ): GatewayCombinedOperationalMetrics {
    const heartbeat = this.liveness.snapshot(hermesAgentId)
    return {
      ...(state?.operationalSnapshot
        ? {
            gateway: state.operationalSnapshot,
            gatewayReceivedAt: state.operationalReceivedAt,
          }
        : {}),
      router: {
        heartbeat: {
          state: heartbeat.kind,
          ...(heartbeat.kind === 'healthy'
            ? { rttMs: heartbeat.latencyMs }
            : {}),
          missStreak: heartbeat.kind === 'healthy'
            ? 0
            : heartbeat.kind === 'suspect'
              ? 1
              : 2,
        },
        rpc: this.requestTombstones.snapshot(hermesAgentId),
      },
    }
  }
}
