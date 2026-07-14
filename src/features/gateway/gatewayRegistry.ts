
import { randomUUID } from 'node:crypto'
import type { RawData, WebSocket } from 'ws'
import { cleanStreamFrame, elapsedMs, type GatewayRequestMetrics, type RpcStreamFrame, type RpcStreamRequest } from '../../core/protocol/bridgeProtocol.js'
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
  protocol: 'hermes-hub-gateway-rpc/v1',
  protocols: ['hermes-hub-gateway-rpc/v1'],
  helloTimeoutMs: 10_000,
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

export interface GatewayStreamResult {
  response: GatewayRpcResponse
  metrics: GatewayRequestMetrics
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

interface PendingStream {
  resolve: (result: GatewayStreamResult) => void
  reject: (error: Error) => void
  timeout: NodeJS.Timeout
  startedAt: number
  onFrame: (frame: RpcStreamFrame) => void
  terminalResult?: GatewayStreamResult
  cleanup?: () => void
}

interface PendingHeartbeat {
  resolve: (result: GatewayHeartbeatResult) => void
  reject: (error: Error) => void
  timeout: NodeJS.Timeout
  startedAt: number
}

interface TrackedGateway extends GatewayState {
  requestId: string
  user: string
  deviceName: string
  socket?: WebSocket
  pending: Map<string, PendingRpc>
  pendingStreams: Map<string, PendingStream>
  pendingHeartbeats: Map<string, PendingHeartbeat>
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
      pendingStreams: new Map(),
      pendingHeartbeats: new Map()
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
        pendingStreams: state.pendingStreams.size,
        pendingHeartbeats: state.pendingHeartbeats.size
      })
      for (const [id, pending] of state.pending.entries()) {
        clearTimeout(pending.timeout)
        pending.reject(new Error(reason))
        state.pending.delete(id)
      }
      for (const [id, pending] of state.pendingStreams.entries()) {
        clearTimeout(pending.timeout)
        pending.cleanup?.()
        if (pending.terminalResult) pending.resolve(pending.terminalResult)
        else pending.reject(new Error(reason))
        state.pendingStreams.delete(id)
      }
      for (const [id, pending] of state.pendingHeartbeats.entries()) {
        clearTimeout(pending.timeout)
        pending.reject(new Error(reason))
        state.pendingHeartbeats.delete(id)
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
        state.inFlightRpc = state.pending.size + state.pendingStreams.size
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
      state.inFlightRpc = state.pending.size + state.pendingStreams.size
      state.socket?.send(message, error => {
        if (!error) return
        clearTimeout(timeout)
        state.pending.delete(id)
        state.inFlightRpc = state.pending.size + state.pendingStreams.size
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

  async streamRequestByAgentId(
    hermesAgentId: string,
    payload: Omit<RpcStreamRequest, 'type' | 'id'>,
    options: {
      onFrame: (frame: RpcStreamFrame) => void
      signal?: AbortSignal
      upstreamTimeoutMs?: number
    },
    timeoutMs = 10_000,
  ): Promise<GatewayStreamResult> {
    const state = this.gatewayForAgent(hermesAgentId)
    if (!state?.socket || !state.online || state.socket.readyState !== 1) throw new Error('Gateway offline')
    if (options.signal?.aborted) throw new Error('Client stream disconnected')
    const id = `stream_${randomUUID()}`
    const startedAt = Date.now()
    const upstreamTimeoutMs = options.upstreamTimeoutMs ?? timeoutMs
    const message = JSON.stringify({ type: 'rpc_stream_request', id, ...payload, timeoutMs: upstreamTimeoutMs } satisfies RpcStreamRequest & { timeoutMs: number })
    logRouter('info', 'Gateway stream request sent', {
      hermesAgentId,
      requestId: id,
      method: payload.method,
      path: logPath(payload.path),
      queryKeys: queryKeys(payload.path),
      timeoutMs,
      upstreamTimeoutMs,
      bodyBase64Bytes: payload.bodyBase64?.length
    })
    return new Promise<GatewayStreamResult>((resolve, reject) => {
      const timeout = setTimeout(() => {
        const pending = state.pendingStreams.get(id)
        state.pendingStreams.delete(id)
        pending?.cleanup?.()
        state.inFlightRpc = state.pending.size + state.pendingStreams.size
        if (state.socket?.readyState === 1) {
          state.socket.send(JSON.stringify({
            type: 'rpc_stream_cancel',
            id,
            reason: 'router_timeout'
          }))
        }
        logRouter('warn', 'Gateway stream timed out', {
          hermesAgentId,
          requestId: id,
          method: payload.method,
          path: logPath(payload.path),
          queryKeys: queryKeys(payload.path),
          timeoutMs,
          latencyMs: elapsedMs(startedAt)
        })
        reject(new Error('Gateway stream timeout'))
      }, timeoutMs)
      const abort = () => {
        const pending = state.pendingStreams.get(id)
        if (!pending) return
        const signalReason = options.signal?.reason
        const signalCode = signalReason && typeof signalReason === 'object' && 'code' in signalReason && typeof signalReason.code === 'string'
          ? signalReason.code
          : undefined
        const cancelReason = signalCode?.startsWith('downstream_') ? signalCode : 'client_disconnected'
        const abortError = signalReason instanceof Error ? signalReason : new Error('Client stream disconnected')
        clearTimeout(pending.timeout)
        pending.cleanup?.()
        state.pendingStreams.delete(id)
        state.inFlightRpc = state.pending.size + state.pendingStreams.size
        if (state.socket?.readyState === 1) {
          state.socket.send(JSON.stringify({
            type: 'rpc_stream_cancel',
            id,
            reason: cancelReason
          }))
        }
        logRouter('warn', 'Gateway stream cancelled by downstream', {
          hermesAgentId,
          requestId: id,
          method: payload.method,
          path: logPath(payload.path),
          reason: cancelReason,
          latencyMs: elapsedMs(startedAt)
        })
        reject(abortError)
      }
      const cleanup = options.signal
        ? () => options.signal?.removeEventListener('abort', abort)
        : undefined
      state.pendingStreams.set(id, { resolve, reject, timeout, startedAt, onFrame: options.onFrame, cleanup })
      options.signal?.addEventListener('abort', abort, { once: true })
      if (options.signal?.aborted) {
        abort()
        return
      }
      state.inFlightRpc = state.pending.size + state.pendingStreams.size
      state.socket?.send(message, error => {
        if (!error) return
        clearTimeout(timeout)
        cleanup?.()
        state.pendingStreams.delete(id)
        state.inFlightRpc = state.pending.size + state.pendingStreams.size
        logRouter('warn', 'Gateway stream send failed', {
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
      state.inFlightRpc = state.pending.size + state.pendingStreams.size
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
    if (typeof parsed.id === 'string' && (parsed.type === 'rpc_stream_chunk' || parsed.type === 'rpc_stream_end' || parsed.type === 'rpc_stream_error')) {
      const pending = state.pendingStreams.get(parsed.id)
      if (!pending) {
        if (parsed.type !== 'rpc_stream_chunk') {
          logRouter('warn', 'Gateway stream frame ignored because request is unknown', {
            hermesAgentId: state.hermesAgentId,
            requestId: parsed.id,
            frameType: parsed.type
          })
        }
        return
      }
      let frame: RpcStreamFrame
      try {
        frame = cleanStreamFrame(parsed)
      } catch (error) {
        logRouter('warn', 'Gateway stream frame rejected', {
          hermesAgentId: state.hermesAgentId,
          requestId: parsed.id,
          frameType: parsed.type
        }, error)
        state.pendingStreams.delete(parsed.id)
        state.inFlightRpc = state.pending.size + state.pendingStreams.size
        clearTimeout(pending.timeout)
        pending.cleanup?.()
        pending.reject(error instanceof Error ? error : new Error(String(error)))
        return
      }
      if (frame.type === 'rpc_stream_chunk') {
        pending.onFrame(frame)
        return
      }
      state.pendingStreams.delete(parsed.id)
      state.inFlightRpc = state.pending.size + state.pendingStreams.size
      clearTimeout(pending.timeout)
      pending.cleanup?.()
      if (frame.type === 'rpc_stream_error') {
        pending.onFrame(frame)
        logRouter('warn', 'Gateway stream error received', {
          hermesAgentId: state.hermesAgentId,
          requestId: parsed.id,
          error: frame.error,
          latencyMs: elapsedMs(pending.startedAt)
        })
        pending.reject(new Error(frame.error))
        return
      }
      const metrics: GatewayRequestMetrics = {
        requestId: parsed.id,
        gatewayDispatchMs: elapsedMs(pending.startedAt),
        totalLatencyMs: elapsedMs(pending.startedAt),
        via: 'hermes-hub-gateway',
        ...(frame.metrics || {})
      }
      pending.terminalResult = {
        response: {
          status: frame.status,
          headers: frame.headers || {},
          bodyBase64: frame.bodyBase64 || '',
          metrics
        },
        metrics
      }
      pending.resolve(pending.terminalResult)
      pending.onFrame(frame)
      logRouter(frame.status >= 400 ? 'warn' : 'info', 'Gateway stream completed', {
        hermesAgentId: state.hermesAgentId,
        requestId: parsed.id,
        status: frame.status,
        latencyMs: elapsedMs(pending.startedAt)
      })
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
