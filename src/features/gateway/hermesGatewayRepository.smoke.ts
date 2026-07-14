import assert from 'node:assert/strict'

import type { RpcStreamRequest } from '../../core/protocol/bridgeProtocol.js'
import type {
  GatewayHeartbeatResult,
  GatewayRpcRequest,
  GatewayRpcResponse,
  GatewayState,
  GatewayStreamResult,
} from './gatewayRegistry.js'
import { GatewayRegistry } from './gatewayRegistry.js'
import { HermesGatewayRepository } from './hermesGatewayRepository.js'

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
    mode: 'api-server',
    protocols: ['hermes-hub-gateway-rpc/v1'],
    capabilities,
  }
}

class FakeRegistry {
  requestCalls = 0
  streamCalls = 0
  heartbeatCalls = 0
  response: GatewayRpcResponse = { status: 200, headers: {}, bodyBase64: '' }

  constructor(readonly connection: GatewayState | null) {}

  getByAgentId(id: string): GatewayState | null {
    return id === hermesAgentId ? this.connection : null
  }

  list(): GatewayState[] {
    return this.connection ? [this.connection] : []
  }

  async requestByAgentId(_id: string, _payload: GatewayRpcRequest): Promise<GatewayRpcResponse> {
    this.requestCalls += 1
    return this.response
  }

  async streamRequestByAgentId(): Promise<GatewayStreamResult> {
    this.streamCalls += 1
    return {
      response: this.response,
      metrics: {
        requestId: 'stream_smoke',
        gatewayDispatchMs: 1,
        totalLatencyMs: 1,
        via: 'hermes-hub-gateway',
      },
    }
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

{
  const gateway = new FakeRegistry(state(['sessions', 'chat.stream', 'run.stop']))
  const connections = repository(gateway)

  await connections.request(hermesAgentId, { method: 'GET', path: '/api/sessions' })
  assert.equal(gateway.requestCalls, 1)
  await connections.request(hermesAgentId, rpc('session.interrupt'))
  assert.equal(gateway.requestCalls, 2)
  await assert.rejects(
    connections.request(hermesAgentId, rpc('session.steer')),
    /does not expose this operation/,
  )
}

{
  const gateway = new FakeRegistry(state(['chat.stream']))
  const connections = repository(gateway)
  const streamPayload: Omit<RpcStreamRequest, 'type' | 'id'> = {
    method: 'POST',
    path: '/api/chat-run/runs',
    headers: {},
    bodyBase64: '',
  }

  const result = await connections.streamRequest(
    hermesAgentId,
    streamPayload,
    { onFrame: () => undefined },
  )
  assert.equal(result.kind, 'hermes-hub-gateway')
  assert.equal(gateway.streamCalls, 1)
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

console.log('HermesGatewayRepository smoke passed.')
