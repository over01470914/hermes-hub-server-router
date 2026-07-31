import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import type { WebSocket } from 'ws'
import { GatewayRegistry } from './gatewayRegistry.js'

class FakeGatewaySocket extends EventEmitter {
  readyState = 1
  readonly sent: Record<string, unknown>[] = []

  send(data: string, callback?: (error?: Error) => void): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>)
    callback?.()
  }

  close(code = 1000, reason = ''): void {
    if (this.readyState === 3) return
    this.readyState = 3
    this.emit('close', code, Buffer.from(reason))
  }

  terminate(): void {
    this.close(1006, 'terminated')
  }

  receive(frame: Record<string, unknown>): void {
    this.emit('message', Buffer.from(JSON.stringify(frame)))
  }

  hello(
    gatewayId: string,
    hermesAgentId: string,
    capabilities: string[],
  ): void {
    this.receive({
      type: 'hello',
      gatewayId,
      hermesAgentId,
      runtime: 'hermes-hub-gateway',
      mode: 'native-session',
      protocols: ['hermes-hub-gateway-rpc/v2'],
      capabilities: [
        'session.message',
        'session.prompt-response',
        ...capabilities,
      ],
    })
  }
}

function attach(
  registry: GatewayRegistry,
  hermesAgentId: string,
  gatewayId: string,
  capabilities: string[],
): FakeGatewaySocket {
  const socket = new FakeGatewaySocket()
  registry.attach(socket as unknown as WebSocket, {
    gatewayId,
    hermesAgentId,
    gatewayCredentialState: 'active',
    requestId: `pair_${gatewayId}`,
    user: 'smoke',
    deviceName: gatewayId,
  })
  socket.hello(gatewayId, hermesAgentId, capabilities)
  return socket
}

function frameByType(
  socket: FakeGatewaySocket,
  type: string,
): Record<string, unknown>[] {
  return socket.sent.filter(frame => frame.type === type)
}

const capableRegistry = new GatewayRegistry()
const capableSocket = attach(
  capableRegistry,
  'agent_rpc_cancel_capable',
  'gw_rpc_cancel_capable',
  ['sessions', 'rpc.cancel'],
)

await assert.rejects(
  capableRegistry.requestByAgentId(
    'agent_rpc_cancel_capable',
    { method: 'GET', path: '/api/sessions' },
    20,
  ),
  /Gateway RPC timeout/,
)

const capableRequests = frameByType(capableSocket, 'rpc_request')
const capableCancels = frameByType(capableSocket, 'rpc_cancel')
assert.equal(capableRequests.length, 1)
assert.equal(capableCancels.length, 1)
assert.equal(capableCancels[0]?.id, capableRequests[0]?.id)

capableSocket.receive({
  type: 'rpc_cancel_ack',
  id: capableRequests[0]?.id,
  outcome: 'cancelled',
})
capableSocket.receive({
  type: 'rpc_response',
  id: capableRequests[0]?.id,
  status: 200,
  headers: {},
  bodyBase64: '',
})
capableSocket.receive({
  type: 'rpc_response',
  id: 'rpc_truly_unknown',
  status: 200,
  headers: {},
  bodyBase64: '',
})

const capableMetrics = capableRegistry.requestLifecycleMetricsByAgentId(
  'agent_rpc_cancel_capable',
)
assert.equal(capableMetrics.timedOut, 1)
assert.equal(capableMetrics.activeTombstones, 1)
assert.equal(capableMetrics.cancelDispatched, 1)
assert.equal(capableMetrics.cancelAcknowledged.cancelled, 1)
assert.equal(capableMetrics.lateAfterTimeout, 1)
assert.equal(capableMetrics.unknownResponses, 1)

capableSocket.receive({
  type: 'operational_snapshot',
  hermesAgentId: 'agent_rpc_cancel_capable',
  gatewayId: 'gw_rpc_cancel_capable',
  snapshot: {
    object: 'hermes-hub.gateway.operational',
    version: 1,
    sampledAt: Date.now(),
    eventLoop: {
      sampleCount: 60,
      lastMs: 20,
      p50Ms: 10,
      p95Ms: 20,
      p99Ms: 20,
      signal: 'ok',
    },
    fileDescriptors: {
      count: 10,
      softLimit: 100,
      ratioPercent: 10,
      consecutiveHighSamples: 0,
      signal: 'ok',
    },
    tasks: {
      request: { count: 0, oldestAgeMs: 0 },
      native: { count: 0, oldestAgeMs: 0 },
      transcript: { count: 0, oldestAgeMs: 0 },
      cancel: { count: 0, oldestAgeMs: 0 },
    },
    semaphore: {
      waitingCount: 0,
      lastWaitMs: 0,
      p95WaitMs: 0,
    },
    outbound: {
      control: { depth: 0, oldestAgeMs: 0 },
      data: { depth: 0, oldestAgeMs: 0 },
    },
    rpcCancel: {
      cancelled: 1,
      notFound: 0,
      alreadyCompleted: 0,
    },
    reconnect: {
      lastAt: Date.now(),
      reason: 'router_disconnected',
    },
  },
})
const operational = capableRegistry.operationalMetricsByAgentId(
  'agent_rpc_cancel_capable',
)
assert.equal(operational.gateway?.eventLoop.p95Ms, 20)
assert.equal(operational.gateway?.fileDescriptors.ratioPercent, 10)
assert.equal(operational.router.heartbeat.state, 'healthy')
assert.equal(operational.router.heartbeat.missStreak, 0)
assert.equal(operational.router.rpc.lateAfterTimeout, 1)
assert.equal(JSON.stringify(operational).includes('bodyBase64'), false)

const legacyRegistry = new GatewayRegistry()
const legacySocket = attach(
  legacyRegistry,
  'agent_rpc_cancel_legacy',
  'gw_rpc_cancel_legacy',
  ['sessions'],
)

await assert.rejects(
  legacyRegistry.requestByAgentId(
    'agent_rpc_cancel_legacy',
    { method: 'GET', path: '/api/sessions' },
    20,
  ),
  /Gateway RPC timeout/,
)

assert.equal(frameByType(legacySocket, 'rpc_request').length, 1)
assert.equal(frameByType(legacySocket, 'rpc_cancel').length, 0)
const legacyMetrics = legacyRegistry.requestLifecycleMetricsByAgentId(
  'agent_rpc_cancel_legacy',
)
assert.equal(legacyMetrics.timedOut, 1)
assert.equal(legacyMetrics.activeTombstones, 1)
assert.equal(legacyMetrics.cancelDispatched, 0)

console.log(JSON.stringify({
  ok: true,
  checks: {
    capableGatewayReceivesExactlyOneCancel: true,
    legacyGatewayReceivesNoCancel: true,
    lateAfterTimeoutIsClassified: true,
    trulyUnknownResponseRemainsUnknown: true,
    operationalMetricsAreRedactedAndCombined: true,
  },
}, null, 2))
