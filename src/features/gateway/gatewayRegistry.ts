
import { randomUUID } from 'node:crypto'
import type { RawData, WebSocket } from 'ws'
import { elapsedMs, type GatewayRequestMetrics } from '../../core/protocol/bridgeProtocol.js'
import { logRouter } from '../../core/observability/routerLogger.js'
import type { GatewayCredentialState } from '../pairing/pairingStore.js'

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
  inFlightRpc: number
  runtime: string
  mode: string
  protocols?: string[]
  capabilities?: string[]
}

export type ConnectionKind = 'hermes-hub-gateway'

export interface GatewayRegistryOptions {
  connectionKind: ConnectionKind
  protocol: string
  protocols: string[]
  helloTimeoutMs: number
}

const defaultRegistryOptions: GatewayRegistryOptions = {
  connectionKind: 'hermes-hub-gateway',
  protocol: 'hermes-hub-gateway-rpc/v2',
  protocols: ['hermes-hub-gateway-rpc/v2'],
  helloTimeoutMs: 10_000,
}

export interface GatewaySessionSubmit {
  laneId: string
  submissionId: string
  text: string
  deviceId: string
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
  lastSeenAt?: number
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
}

interface PendingHeartbeat {
  resolve: (result: GatewayHeartbeatResult) => void
  reject: (error: Error) => void
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
  requestId: string
  user: string
  deviceName: string
  socket?: WebSocket
  pending: Map<string, PendingRpc>
  pendingHeartbeats: Map<string, PendingHeartbeat>
  pendingNative: Map<string, PendingNative>
  pendingRuntimeSnapshots: Map<string, PendingRuntimeSnapshot>
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
  'message.complete',
  'assistant.delta',
  'assistant.live_input',
  'processing.started',
  'processing.completed',
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

function cleanNativeAck(value: Record<string, unknown>, pending: PendingNative): GatewayNativeAck {
  if (value.requestType !== pending.requestType || typeof value.accepted !== 'boolean') {
    throw new Error('Gateway native acknowledgement shape is invalid')
  }
  if (value.laneId !== pending.laneId) {
    throw new Error('Gateway native acknowledgement lane mismatch')
  }
  if (pending.submissionId && value.submissionId !== pending.submissionId) {
    throw new Error('Gateway native acknowledgement submission mismatch')
  }
  if (pending.promptId && value.promptId !== pending.promptId) {
    throw new Error('Gateway native acknowledgement prompt mismatch')
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
  const data = asRecord(value.data)
  if (!eventId || !laneId || !event || !data) {
    throw new Error('Gateway session event shape is invalid')
  }
  const sessionId = typeof value.sessionId === 'string' && value.sessionId.length <= 256
    ? value.sessionId
    : undefined
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
  private sessionEventHandler?: (event: GatewaySessionEvent) => boolean
  private runtimeSnapshotHandler?: (snapshot: GatewayRuntimeSnapshot) => void
  private readonly runtimeSnapshots = new Map<string, GatewayRuntimeSnapshot>()

  constructor(private readonly options: GatewayRegistryOptions = defaultRegistryOptions) {}

  attach(socket: WebSocket, record: { gatewayId?: string; hermesAgentId?: string; gatewayCredentialState?: GatewayCredentialState; requestId: string; user: string; deviceName: string }): GatewayState {
    if (!record.gatewayId) throw new Error('Gateway id missing')
    if (!record.hermesAgentId) throw new Error('Hermes Agent id missing')
    const now = nowSeconds()
    const existing = this.gateways.get(record.gatewayId)
    if (existing?.socket && existing.socket.readyState <= 1) {
      logRouter('warn', 'Gateway socket superseded', {
        gatewayId: record.gatewayId,
        hermesAgentId: record.hermesAgentId,
        gatewayConnectionId: existing.gatewayConnectionId,
        previousInFlightRpc: existing.inFlightRpc
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
    logRouter('info', 'Gateway attached', {
      gatewayId: record.gatewayId,
      hermesAgentId: record.hermesAgentId,
      gatewayConnectionId: state.gatewayConnectionId,
      gatewayCredentialState: state.gatewayCredentialState,
      requestId: record.requestId,
      user: record.user,
      deviceName: record.deviceName
    })
    let detached = false
    const detach = (reason: string, closeCode?: number, closeReason?: string): void => {
      if (detached) return
      detached = true
      if (state.helloTimeout) clearTimeout(state.helloTimeout)
      state.helloTimeout = undefined
      state.online = false
      state.routable = false
      state.lastSeenAt = nowSeconds()
      state.socket = undefined
      logRouter('warn', 'Gateway disconnected', {
        gatewayId: state.gatewayId,
        hermesAgentId: state.hermesAgentId,
        gatewayConnectionId: state.gatewayConnectionId,
        closeCode,
        closeReason,
        pendingRpc: state.pending.size,
        pendingHeartbeats: state.pendingHeartbeats.size,
        pendingNative: state.pendingNative.size,
        pendingRuntimeSnapshots: state.pendingRuntimeSnapshots.size,
      })
      for (const [id, pending] of state.pending.entries()) {
        clearTimeout(pending.timeout)
        pending.reject(new Error(reason))
        state.pending.delete(id)
      }
      for (const [id, pending] of state.pendingHeartbeats.entries()) {
        clearTimeout(pending.timeout)
        pending.reject(new Error(reason))
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
        pending.reject(new Error(reason))
        state.pendingRuntimeSnapshots.delete(id)
      }
      state.inFlightRpc = 0
    }
    socket.on('message', (data: RawData) => {
      try {
        this.handleMessage(state, data)
      } catch (error) {
        logRouter('warn', 'Gateway message handler failed', {
          gatewayId: state.gatewayId,
          hermesAgentId: state.hermesAgentId,
          gatewayConnectionId: state.gatewayConnectionId,
        }, error)
        detach('Gateway message handler failed')
        if (socket.readyState <= 1) socket.terminate()
      }
    })
    socket.on('error', error => {
      logRouter('warn', 'Gateway socket error', {
        gatewayId: state.gatewayId,
        hermesAgentId: state.hermesAgentId,
        gatewayConnectionId: state.gatewayConnectionId,
      }, error)
      detach('Gateway socket error')
      if (socket.readyState <= 1) socket.terminate()
    })
    state.helloTimeout = setTimeout(() => {
      if (state.online || state.socket?.readyState !== 1) return
      logRouter('warn', 'Gateway hello timed out', {
        gatewayId: state.gatewayId,
        hermesAgentId: state.hermesAgentId,
        gatewayConnectionId: state.gatewayConnectionId,
        timeoutMs: this.options.helloTimeoutMs,
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
      logRouter('warn', 'Gateway ready frame failed', {
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
        logRouter('warn', 'Gateway runtime snapshot timed out', {
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
    if (!candidate.online || candidate.socket?.readyState !== 1) {
      throw Object.assign(new Error('Gateway credential candidate is not online'), {
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
      const candidateOpen = Boolean(exactConnection && candidate?.online && candidate.socket?.readyState === 1)
      const reason: GatewayActivationSyncResult['reason'] = !candidate
        ? 'candidate_missing'
        : !exactConnection
          ? 'candidate_connection_changed'
          : !candidateOpen
            ? 'candidate_not_open'
            : undefined

      if (candidateOpen && candidate) {
        candidate.gatewayCredentialState = 'active'
        candidate.routable = true
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
        logRouter('warn', state.gatewayId === reservation.gatewayId
          ? 'Gateway activation reservation changed before runtime commit'
          : 'Gateway credential connection revoked after rotation', {
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
            logRouter('warn', 'Gateway quarantine close failed', {
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
        logRouter('warn', 'Gateway credential runtime activation requires claim retry', {
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

      const gateway = this.publicState(candidate)
      logRouter('info', 'Gateway credential promoted to active route', {
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
      logRouter('error', 'Gateway credential runtime activation failed safely', {
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

  async heartbeatByAgentId(hermesAgentId?: string, timeoutMs = 3000): Promise<GatewayHeartbeatResult> {
    const state = hermesAgentId
      ? this.gatewayForAgent(hermesAgentId)
      : [...this.gateways.values()].find(item => item.gatewayCredentialState === 'active' && item.online && item.socket?.readyState === 1)
    if (!state?.socket || !state.online || state.socket.readyState !== 1) {
      logRouter('warn', 'Gateway heartbeat skipped because gateway is offline', {
        hermesAgentId: hermesAgentId || state?.hermesAgentId,
        lastSeenAt: state?.lastSeenAt
      })
      return {
        ok: false,
        gatewayId: state?.gatewayId,
        hermesAgentId: hermesAgentId || state?.hermesAgentId,
        gatewayConnectionId: state?.gatewayConnectionId,
        online: false,
        lastSeenAt: state?.lastSeenAt,
        error: 'Gateway offline'
      }
    }
    const id = `hb_${randomUUID()}`
    const startedAt = Date.now()
    return new Promise<GatewayHeartbeatResult>((resolve, reject) => {
      const timeout = setTimeout(() => {
        state.pendingHeartbeats.delete(id)
        state.online = false
        state.routable = false
        state.lastSeenAt = nowSeconds()
        state.socket?.terminate()
        state.socket = undefined
        logRouter('warn', 'Gateway heartbeat timed out', {
          hermesAgentId: state.hermesAgentId,
          requestId: id,
          timeoutMs
        })
        resolve({ ok: false, gatewayId: state.gatewayId, hermesAgentId: state.hermesAgentId, gatewayConnectionId: state.gatewayConnectionId, online: false, lastSeenAt: state.lastSeenAt, error: 'Gateway heartbeat timeout' })
      }, timeoutMs)
      state.pendingHeartbeats.set(id, { resolve, reject, timeout, startedAt })
      state.socket?.send(JSON.stringify({ type: 'heartbeat', id, sentAt: startedAt }), error => {
        if (!error) return
        clearTimeout(timeout)
        state.pendingHeartbeats.delete(id)
        logRouter('warn', 'Gateway heartbeat send failed', {
          hermesAgentId: state.hermesAgentId,
          requestId: id
        }, error)
        reject(error)
      })
    })
  }

  async requestByAgentId(hermesAgentId: string, payload: GatewayRpcRequest, timeoutMs = 10_000): Promise<GatewayRpcResponse> {
    const state = this.gatewayForAgent(hermesAgentId)
    if (!state?.socket || !state.online || state.socket.readyState !== 1) throw new Error('Gateway offline')
    const id = `rpc_${randomUUID()}`
    const startedAt = Date.now()
    const message = JSON.stringify({ type: 'rpc_request', id, ...payload, timeoutMs })
    logRouter('info', 'Gateway RPC request sent', {
      hermesAgentId,
      requestId: id,
      method: payload.method,
      path: logPath(payload.path),
      queryKeys: queryKeys(payload.path),
      timeoutMs,
      bodyBase64Bytes: payload.bodyBase64?.length
    })
    return new Promise<GatewayRpcResponse>((resolve, reject) => {
      const timeout = setTimeout(() => {
        state.pending.delete(id)
        state.inFlightRpc = state.pending.size + state.pendingNative.size
        logRouter('warn', 'Gateway RPC timed out', {
          hermesAgentId,
          requestId: id,
          method: payload.method,
          path: logPath(payload.path),
          queryKeys: queryKeys(payload.path),
          timeoutMs,
          latencyMs: elapsedMs(startedAt)
        })
        reject(new Error('Gateway RPC timeout'))
      }, timeoutMs)
      state.pending.set(id, { resolve, reject, timeout, startedAt })
      state.inFlightRpc = state.pending.size + state.pendingNative.size
      state.socket?.send(message, error => {
        if (!error) return
        clearTimeout(timeout)
        state.pending.delete(id)
        state.inFlightRpc = state.pending.size + state.pendingNative.size
        logRouter('warn', 'Gateway RPC send failed', {
          hermesAgentId,
          requestId: id,
          method: payload.method,
          path: logPath(payload.path),
          queryKeys: queryKeys(payload.path)
        }, error)
        reject(error)
      })
    })
  }

  async submitSessionByAgentId(
    hermesAgentId: string,
    payload: GatewaySessionSubmit,
    timeoutMs = 10_000,
  ): Promise<GatewayNativeAck> {
    return this.nativeRequestByAgentId(
      hermesAgentId,
      'session_submit',
      payload.laneId,
      {
        laneId: payload.laneId,
        submissionId: payload.submissionId,
        text: payload.text,
        deviceId: payload.deviceId,
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
    const requiredCapability = requestType === 'session_submit'
      ? 'session.message'
      : 'session.prompt-response'
    if (!state.capabilities?.includes(requiredCapability)) {
      throw Object.assign(new Error(`Gateway capability is unavailable: ${requiredCapability}`), {
        code: 'gateway_capability_unsupported',
      })
    }
    const id = `native_${randomUUID()}`
    const startedAt = Date.now()
    const message = JSON.stringify({ type: requestType, id, ...payload })
    logRouter('info', 'Gateway native session request sent', {
      hermesAgentId,
      requestId: id,
      requestType,
      laneId,
      submissionId: correlation.submissionId,
      promptId: correlation.promptId,
      timeoutMs,
    })
    return new Promise<GatewayNativeAck>((resolve, reject) => {
      const rejectAmbiguous = (reason: string): void => {
        state.pendingNative.delete(id)
        state.inFlightRpc = state.pending.size + state.pendingNative.size
        reject(Object.assign(new Error(reason), { code: 'gateway_submission_ambiguous' }))
      }
      const timeout = setTimeout(() => {
        logRouter('warn', 'Gateway native session request timed out ambiguously', {
          hermesAgentId,
          requestId: id,
          requestType,
          laneId,
          submissionId: correlation.submissionId,
          promptId: correlation.promptId,
          latencyMs: elapsedMs(startedAt),
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
        logRouter('warn', 'Gateway native session send became ambiguous', {
          hermesAgentId,
          requestId: id,
          requestType,
          laneId,
          submissionId: correlation.submissionId,
          promptId: correlation.promptId,
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
      logRouter('debug', 'Gateway non-JSON message acknowledged', {
        hermesAgentId: state.hermesAgentId,
        receivedBytes: Buffer.byteLength(text)
      })
      state.socket?.send(JSON.stringify({ type: 'ack', hermesAgentId: state.hermesAgentId, receivedBytes: Buffer.byteLength(text) }))
      return
    }
    if (!state.online && parsed.type !== 'hello') {
      logRouter('warn', 'Gateway message rejected before hello', {
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
        logRouter('warn', 'Gateway native acknowledgement ignored because request is unknown', {
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
        logRouter(acknowledgement.accepted ? 'info' : 'warn', 'Gateway native acknowledgement received', {
          hermesAgentId: state.hermesAgentId,
          requestId: parsed.id,
          requestType: acknowledgement.requestType,
          laneId: acknowledgement.laneId,
          submissionId: acknowledgement.submissionId,
          promptId: acknowledgement.promptId,
          sessionId: acknowledgement.sessionId,
          code: acknowledgement.code,
          latencyMs: elapsedMs(pending.startedAt),
        })
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
        logRouter('debug', 'Gateway native session event accepted', {
          hermesAgentId: state.hermesAgentId,
          gatewayId: state.gatewayId,
          laneId: event.laneId,
          sessionId: event.sessionId,
          submissionId: event.submissionId,
          eventId: event.eventId,
          event: event.event,
        })
      } catch (error) {
        logRouter('warn', 'Gateway native session event rejected', {
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
        logRouter('debug', 'Gateway runtime snapshot accepted', {
          hermesAgentId: snapshot.hermesAgentId,
          gatewayId: snapshot.gatewayId,
          scope: snapshot.scope,
          hasSession: Boolean(snapshot.sessionId),
          revision: snapshot.snapshot.revision,
        })
      } catch (error) {
        logRouter('warn', 'Gateway runtime snapshot rejected', {
          hermesAgentId: state.hermesAgentId,
          gatewayId: state.gatewayId,
        }, error)
        state.socket?.close(4400, 'invalid runtime snapshot')
      }
      return
    }
    if (parsed.type === 'rpc_response' && typeof parsed.id === 'string') {
      const pending = state.pending.get(parsed.id)
      if (!pending) {
        logRouter('warn', 'Gateway RPC response ignored because request is unknown', {
          hermesAgentId: state.hermesAgentId,
          requestId: parsed.id
        })
        return
      }
      state.pending.delete(parsed.id)
      state.inFlightRpc = state.pending.size + state.pendingNative.size
      clearTimeout(pending.timeout)
      try {
        const response = cleanRpcResponse(parsed)
        logRouter(response.status >= 400 ? 'warn' : 'info', 'Gateway RPC response received', {
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
        logRouter('warn', 'Gateway RPC response rejected', {
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
        logRouter('debug', 'Gateway heartbeat ack ignored because request is unknown', {
          hermesAgentId: state.hermesAgentId,
          requestId: parsed.id
        })
        return
      }
      if (parsed.gatewayId !== state.gatewayId || parsed.hermesAgentId !== state.hermesAgentId) {
        state.pendingHeartbeats.delete(parsed.id)
        clearTimeout(pending.timeout)
        state.online = false
        state.routable = false
        state.lastSeenAt = nowSeconds()
        logRouter('warn', 'Gateway heartbeat identity rejected', {
          gatewayId: state.gatewayId,
          hermesAgentId: state.hermesAgentId,
          gatewayConnectionId: state.gatewayConnectionId,
          requestId: parsed.id,
        })
        pending.resolve({
          ok: false,
          gatewayId: state.gatewayId,
          hermesAgentId: state.hermesAgentId,
          gatewayConnectionId: state.gatewayConnectionId,
          online: false,
          lastSeenAt: state.lastSeenAt,
          error: 'Gateway heartbeat identity mismatch',
        })
        state.socket?.close(4403, 'gateway heartbeat identity mismatch')
        return
      }
      state.pendingHeartbeats.delete(parsed.id)
      clearTimeout(pending.timeout)
      logRouter('debug', 'Gateway heartbeat ack received', {
        hermesAgentId: state.hermesAgentId,
        requestId: parsed.id,
        latencyMs: Date.now() - pending.startedAt
      })
      pending.resolve({
        ok: true,
        gatewayId: state.gatewayId,
        hermesAgentId: state.hermesAgentId,
        gatewayConnectionId: state.gatewayConnectionId,
        online: true,
        lastSeenAt: state.lastSeenAt,
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
        logRouter('warn', 'Gateway hello identity rejected', {
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
        logRouter('warn', 'Gateway hello protocol rejected', {
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
      if (Array.isArray(parsed.capabilities)) {
        state.capabilities = parsed.capabilities
          .filter((item): item is string => typeof item === 'string' && item.length > 0)
          .map(item => item.slice(0, 120))
          .slice(0, 64)
      }
      if (
        state.mode !== 'native-session' ||
        !state.capabilities?.includes('session.message') ||
        !state.capabilities.includes('session.prompt-response')
      ) {
        logRouter('warn', 'Gateway native session contract rejected', {
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
      state.routable = state.gatewayCredentialState === 'active'
      logRouter('info', 'Gateway hello received', {
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
      }))
      return
    }
    logRouter('debug', 'Gateway message acknowledged', {
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
      inFlightRpc: state.inFlightRpc,
      runtime: state.runtime,
      mode: state.mode,
      ...(state.protocols?.length ? { protocols: state.protocols } : {}),
      ...(state.capabilities?.length ? { capabilities: state.capabilities } : {}),
    }
  }
}
