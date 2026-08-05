import type {
  GatewayHeartbeatResult,
  GatewayRpcRequest,
  GatewayRpcResponse,
  GatewayRuntimeSnapshot,
  GatewayState,
} from './gatewayRegistry.js'
import { GatewayRegistry } from './gatewayRegistry.js'

export interface HermesGatewayResponse {
  kind: 'hermes-hub-gateway'
  response: GatewayRpcResponse
}

function gatewayUnavailable(message: string, statusCode: number, code: string): Error {
  return Object.assign(new Error(message), { statusCode, code })
}

function normalizedPath(path: string): string {
  return `/${path.replace(/^\/+/, '').split('?')[0]}`
}

function rpcPayload(payload: GatewayRpcRequest): Record<string, unknown> | null {
  if (normalizedPath(payload.path) !== '/api/ws' || !payload.bodyBase64) return null
  try {
    const parsed = JSON.parse(Buffer.from(payload.bodyBase64, 'base64').toString('utf8')) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    return parsed as Record<string, unknown>
  } catch {
    return null
  }
}

function rpcMethod(payload: GatewayRpcRequest): string {
  const method = rpcPayload(payload)?.method
  return typeof method === 'string' ? method.trim() : ''
}

function enabledFlag(value: unknown): boolean {
  if (value === true) return true
  return typeof value === 'string' && ['1', 'true', 'yes'].includes(value.trim().toLowerCase())
}

function modelProbeRequested(payload: GatewayRpcRequest): boolean {
  const path = normalizedPath(payload.path)
  if (path === '/api/model/options') {
    const query = payload.path.split('?', 2)[1]
    return enabledFlag(query ? new URLSearchParams(query).get('probe') : null)
  }
  if (path !== '/api/ws') return false
  const params = rpcPayload(payload)?.params
  return Boolean(params && typeof params === 'object' && !Array.isArray(params)
    && enabledFlag((params as Record<string, unknown>).probe))
}

export function requiredGatewayCapability(payload: GatewayRpcRequest): string | null {
  const path = normalizedPath(payload.path)
  const httpMethod = (payload.method || 'GET').toUpperCase()
  if (path === '/api/sessions' || path.startsWith('/api/sessions/')) return 'sessions'
  if (path === '/api/session/usage') return 'sessions.usage'
  if (path === '/api/model/options') return modelProbeRequested(payload) ? 'models.probe' : 'models'
  if (path === '/v1/models') return 'models'
  if (path === '/api/jobs') {
    if (httpMethod === 'GET' || httpMethod === 'POST') return 'cron'
    return null
  }
  if (/^\/api\/jobs\/[^/]+$/.test(path)) {
    if (httpMethod === 'GET' || httpMethod === 'PATCH' || httpMethod === 'DELETE') return 'cron'
    return null
  }
  if (/^\/api\/jobs\/[^/]+\/(pause|resume)$/.test(path)) {
    return httpMethod === 'POST' ? 'cron' : null
  }
  if (/^\/api\/jobs\/[^/]+\/run$/.test(path)) {
    return httpMethod === 'POST' ? 'cron' : null
  }
  if (/^\/api\/jobs\/[^/]+\/runs(?:\/[^/]+)?$/.test(path)) {
    return httpMethod === 'GET' ? 'cron' : null
  }
  if (path === '/api/kanban/boards' || path === '/api/kanban/board') {
    return httpMethod === 'GET' ? 'kanban.read' : null
  }
  if (/^\/api\/kanban\/tasks\/[^/]+$/.test(path)) {
    if (httpMethod === 'GET') return 'kanban.read'
    if (httpMethod === 'PATCH') return 'kanban.write'
    return null
  }
  if (path === '/api/kanban/tasks') {
    return httpMethod === 'POST' ? 'kanban.write' : null
  }
  if (/^\/api\/kanban\/tasks\/[^/]+\/(block|unblock|comments)$/.test(path)) {
    return httpMethod === 'POST' ? 'kanban.write' : null
  }
  if (path === '/api/kanban/links') {
    return httpMethod === 'POST' || httpMethod === 'DELETE' ? 'kanban.write' : null
  }
  if (path === '/api/kanban/dispatch') {
    return httpMethod === 'POST' ? 'kanban.execute' : null
  }
  if (path === '/v1/capabilities' || path === '/v1/health' || path === '/health') return 'health'
  if (path !== '/api/ws') return null

  const method = rpcMethod(payload)
  if (method === 'model.options') return modelProbeRequested(payload) ? 'models.probe' : 'models'
  if (method === 'attachment.stage') return 'attachments.write'
  if (method === 'artifact.fetch') return 'artifacts.read'
  if (method === 'session.usage' || method === 'session.context_breakdown') return 'sessions.usage'
  return null
}

/**
 * The Router's only host-transport seam. It never falls back to a second
 * host transport or local Agent URL: an operation is either advertised by the
 * Sidecar/Plugin Gateway path, or it is unavailable.
 */
export class HermesGatewayRepository {
  constructor(private readonly gateways: GatewayRegistry) {}

  private requireOnline(hermesAgentId: string): GatewayState {
    const gateway = this.gateways.getByAgentId(hermesAgentId)
    if (!gateway?.online) {
      throw gatewayUnavailable('Hermes Hub Gateway offline', 503, 'gateway_offline')
    }
    if (!gateway.agentOnline || !gateway.routable) {
      throw gatewayUnavailable('Hermes Agent runtime is unavailable', 503, 'agent_unavailable')
    }
    return gateway
  }

  private requireCapability(hermesAgentId: string, payload: GatewayRpcRequest): GatewayState {
    const gateway = this.requireOnline(hermesAgentId)
    const capability = requiredGatewayCapability(payload)
    if (!capability) {
      throw gatewayUnavailable(
        'Hermes Hub Gateway does not expose this operation',
        501,
        'gateway_capability_unsupported',
      )
    }
    if (!gateway.capabilities?.includes(capability)) {
      throw gatewayUnavailable(
        `Hermes Hub Gateway does not advertise required capability: ${capability}`,
        501,
        'gateway_capability_unavailable',
      )
    }
    return gateway
  }

  async request(
    hermesAgentId: string,
    payload: GatewayRpcRequest,
    timeoutMs?: number,
  ): Promise<HermesGatewayResponse> {
    this.requireCapability(hermesAgentId, payload)
    return {
      kind: 'hermes-hub-gateway',
      response: await this.gateways.requestByAgentId(hermesAgentId, payload, timeoutMs),
    }
  }

  get(hermesAgentId: string): GatewayState | null {
    return this.gateways.getByAgentId(hermesAgentId)
  }

  list(): GatewayState[] {
    return this.gateways.list()
  }

  async heartbeat(
    hermesAgentId?: string,
    _timeoutMs = 3_000,
  ): Promise<GatewayHeartbeatResult> {
    return this.gateways.heartbeatSnapshotByAgentId(hermesAgentId)
  }

  async runtimeSnapshot(
    hermesAgentId: string,
    options: { sessionId?: string; timeoutMs?: number } = {},
  ): Promise<GatewayRuntimeSnapshot> {
    const gateway = this.requireOnline(hermesAgentId)
    if (!gateway.capabilities?.includes('runtime.status')) {
      throw gatewayUnavailable(
        'Hermes Hub Gateway does not advertise required capability: runtime.status',
        501,
        'gateway_capability_unavailable',
      )
    }
    return this.gateways.requestRuntimeSnapshotByAgentId(hermesAgentId, options)
  }

  cachedRuntimeSnapshot(hermesAgentId: string, sessionId?: string): GatewayRuntimeSnapshot | null {
    return this.gateways.getRuntimeSnapshotByAgentId(hermesAgentId, sessionId)
  }
}
