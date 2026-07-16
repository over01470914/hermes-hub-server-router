import type {
  GatewayHeartbeatResult,
  GatewayRpcRequest,
  GatewayRpcResponse,
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

function rpcMethod(payload: GatewayRpcRequest): string {
  if (normalizedPath(payload.path) !== '/api/ws' || !payload.bodyBase64) return ''
  try {
    const parsed = JSON.parse(Buffer.from(payload.bodyBase64, 'base64').toString('utf8')) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return ''
    const method = (parsed as Record<string, unknown>).method
    return typeof method === 'string' ? method.trim() : ''
  } catch {
    return ''
  }
}

export function requiredGatewayCapability(payload: GatewayRpcRequest): string | null {
  const path = normalizedPath(payload.path)
  if (path === '/api/sessions' || path.startsWith('/api/sessions/')) return 'sessions'
  if (path === '/api/session/usage') return 'sessions.usage'
  if (path === '/api/model/options' || path === '/v1/models') return 'models'
  if (path === '/api/jobs' || path.startsWith('/api/jobs/')) return 'cron'
  if (path === '/v1/capabilities' || path === '/v1/health' || path === '/health') return 'health'
  if (path !== '/api/ws') return null

  const method = rpcMethod(payload)
  if (method === 'model.options') return 'models'
  if (method === 'session.usage' || method === 'session.context_breakdown') return 'sessions.usage'
  return null
}

/**
 * The Router's only host-transport seam. It never falls back to a second
 * host transport or local Agent URL: an operation is either advertised by the
 * lifecycle-owned Gateway, or it is unavailable.
 */
export class HermesGatewayRepository {
  constructor(private readonly gateways: GatewayRegistry) {}

  private requireOnline(hermesAgentId: string): GatewayState {
    const gateway = this.gateways.getByAgentId(hermesAgentId)
    if (!gateway?.online) {
      throw gatewayUnavailable('Hermes Hub Gateway offline', 503, 'gateway_offline')
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

  async heartbeat(hermesAgentId?: string, timeoutMs = 3_000): Promise<GatewayHeartbeatResult> {
    return this.gateways.heartbeatByAgentId(hermesAgentId, timeoutMs)
  }
}
