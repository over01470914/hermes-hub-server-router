import assert from 'node:assert/strict'

import type {
  GatewayHeartbeatResult,
  GatewayRpcRequest,
  GatewayRpcResponse,
  GatewayState,
} from './gatewayRegistry.js'
import { GatewayRegistry } from './gatewayRegistry.js'
import { HermesGatewayRepository, requiredGatewayCapability } from './hermesGatewayRepository.js'

const hermesAgentId = 'agent_gateway_only_smoke'

function state(capabilities: string[] = []): GatewayState {
  return {
    gatewayId: 'gw_gateway_only_smoke',
    hermesAgentId,
    gatewayConnectionId: 'gwc_gateway_only_smoke',
    connectionKind: 'hermes-hub-gateway',
    gatewayCredentialState: 'active',
    routable: true,
    connectedAt: 1,
    lastSeenAt: 1,
    online: true,
    inFlightRpc: 0,
    runtime: 'hermes-hub-gateway',
    mode: 'native-session',
    protocols: ['hermes-hub-gateway-rpc/v2'],
    capabilities,
  }
}

class FakeRegistry {
  requestCalls = 0
  heartbeatCalls = 0
  lastRequest: GatewayRpcRequest | null = null
  response: GatewayRpcResponse = { status: 200, headers: {}, bodyBase64: '' }

  constructor(readonly connection: GatewayState | null) {}

  getByAgentId(id: string): GatewayState | null {
    return id === hermesAgentId ? this.connection : null
  }

  list(): GatewayState[] {
    return this.connection ? [this.connection] : []
  }

  async requestByAgentId(_id: string, payload: GatewayRpcRequest): Promise<GatewayRpcResponse> {
    this.requestCalls += 1
    this.lastRequest = payload
    return this.response
  }

  async heartbeatByAgentId(): Promise<GatewayHeartbeatResult> {
    this.heartbeatCalls += 1
    return { ok: true, hermesAgentId, online: true, latencyMs: 1 }
  }
}

function repository(gateway: FakeRegistry): HermesGatewayRepository {
  return new HermesGatewayRepository(gateway as unknown as GatewayRegistry)
}

function rpc(method: string, params: Record<string, unknown> = {}): GatewayRpcRequest {
  return {
    method: 'POST',
    path: '/api/ws',
    bodyBase64: Buffer.from(JSON.stringify({ method, params })).toString('base64'),
  }
}

assert.equal(
  requiredGatewayCapability({ method: 'GET', path: '/api/model/options?refresh=1&probe=1' }),
  'models.probe',
)
assert.equal(requiredGatewayCapability(rpc('model.options', { probe: true })), 'models.probe')
assert.equal(requiredGatewayCapability({ method: 'GET', path: '/api/model/options' }), 'models')

{
  const gateway = new FakeRegistry(state(['models.probe']))
  const connections = repository(gateway)
  await connections.request(hermesAgentId, {
    method: 'GET',
    path: '/api/model/options?refresh=1&probe=1',
  })
  assert.equal(gateway.requestCalls, 1)
  await assert.rejects(
    connections.request(hermesAgentId, { method: 'GET', path: '/api/model/options' }),
    /required capability: models/,
  )
}

{
  const gateway = new FakeRegistry(state(['sessions', 'session.message', 'session.prompt-response']))
  const connections = repository(gateway)

  await connections.request(hermesAgentId, { method: 'GET', path: '/api/sessions' })
  assert.equal(gateway.requestCalls, 1)
  await assert.rejects(
    connections.request(hermesAgentId, rpc('session.interrupt')),
    /does not expose this operation/,
  )
}

{
  const gateway = new FakeRegistry(state(['sessions']))
  const connections = repository(gateway)
  await assert.rejects(
    connections.request(hermesAgentId, rpc('config.set')),
    /does not expose this operation/,
  )
  await connections.heartbeat(hermesAgentId)
  assert.equal(gateway.heartbeatCalls, 1)
}

{
  const gateway = new FakeRegistry(state(['sessions']))
  const connections = repository(gateway)

  await connections.request(hermesAgentId, {
    method: 'PATCH',
    path: '/api/sessions/session_1',
  })
  assert.equal(gateway.lastRequest?.method, 'PATCH')
  assert.equal(gateway.lastRequest?.path, '/api/sessions/session_1')

  await connections.request(hermesAgentId, {
    method: 'DELETE',
    path: '/api/sessions/session_1',
  })
  assert.equal(gateway.lastRequest?.method, 'DELETE')

  await connections.request(hermesAgentId, {
    method: 'POST',
    path: '/api/sessions/session_1/fork',
  })
  assert.equal(gateway.lastRequest?.path, '/api/sessions/session_1/fork')
}

{
  const gateway = new FakeRegistry(state([]))
  const connections = repository(gateway)
  await assert.rejects(
    connections.request(hermesAgentId, {
      method: 'PATCH',
      path: '/api/sessions/session_1',
    }),
    /required capability: sessions/,
  )
  assert.equal(gateway.requestCalls, 0)
}

console.log('HermesGatewayRepository smoke passed.')
