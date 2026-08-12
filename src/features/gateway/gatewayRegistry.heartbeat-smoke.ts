import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import type { WebSocket } from 'ws'
import { GatewayRegistry } from './gatewayRegistry.js'

class FakeGatewaySocket extends EventEmitter {
  readyState = 1
  readonly sent: Record<string, unknown>[] = []
  terminateCount = 0

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
    this.terminateCount += 1
    this.close(1006, 'terminated')
  }

  receive(frame: Record<string, unknown>): void {
    this.emit('message', Buffer.from(JSON.stringify(frame)))
  }

  hello(gatewayId: string, hermesAgentId: string): void {
    this.receive({
      type: 'hello',
      gatewayId,
      hermesAgentId,
      runtime: 'hermes-hub-gateway',
      mode: 'native-session',
      protocols: ['hermes-hub-gateway-rpc/v2'],
      capabilities: ['health', 'sessions', 'session.message', 'session.prompt-response'],
    })
  }
}

function attach(
  registry: GatewayRegistry,
  agentId: string,
  gatewayId: string,
  gatewayCredentialState: 'active' | 'provisional' = 'active',
): FakeGatewaySocket {
  const socket = new FakeGatewaySocket()
  registry.attach(socket as unknown as WebSocket, {
    gatewayId,
    hermesAgentId: agentId,
    gatewayCredentialState,
    requestId: `pair_${gatewayId}`,
    user: 'smoke',
    deviceName: gatewayId,
  })
  socket.hello(gatewayId, agentId)
  return socket
}

const concurrentRegistry = new GatewayRegistry()
const concurrentSocket = attach(concurrentRegistry, 'agent_heartbeat_a', 'gw_heartbeat_a')
const concurrentHeartbeats = Array.from(
  { length: 20 },
  () => concurrentRegistry.heartbeatByAgentId('agent_heartbeat_a', 250),
)
const heartbeatFrames = concurrentSocket.sent.filter(frame => frame.type === 'heartbeat')

assert.equal(heartbeatFrames.length, 1)
concurrentSocket.receive({
  type: 'heartbeat_ack',
  id: heartbeatFrames[0]?.id,
  gatewayId: 'gw_heartbeat_a',
  hermesAgentId: 'agent_heartbeat_a',
})
assert.ok((await Promise.all(concurrentHeartbeats)).every(result => result.ok))
const framesAfterActiveProbe = concurrentSocket.sent.length
const cachedReads = Array.from(
  { length: 20 },
  () => concurrentRegistry.heartbeatSnapshotByAgentId('agent_heartbeat_a'),
)
assert.ok(cachedReads.every(result => result.ok && result.liveness === 'healthy'))
assert.equal(concurrentSocket.sent.length, framesAfterActiveProbe)

const operationalBase = {
  object: 'hermes-hub.gateway.operational',
  sampledAt: Date.now(),
  eventLoop: { sampleCount: 1, lastMs: 1, p50Ms: 1, p95Ms: 1, p99Ms: 1, signal: 'ok' },
  fileDescriptors: { consecutiveHighSamples: 0, signal: 'ok' },
  tasks: {},
  semaphore: {},
  outbound: { control: {}, data: {} },
  rpcCancel: {},
}
concurrentSocket.receive({
  type: 'operational_snapshot',
  gatewayId: 'gw_heartbeat_a',
  hermesAgentId: 'agent_heartbeat_a',
  snapshot: {
    ...operationalBase,
    version: 2,
    reconnect: {
      count: 3,
      lastHandshakeDurationMs: 42,
      lastHandshakeOutcome: 'reconnected',
    },
  },
})
const v2Operational = concurrentRegistry.getByAgentId('agent_heartbeat_a')?.operational?.gateway
assert.equal(v2Operational?.reconnect.lastHandshakeOutcome, 'reconnected')
assert.equal(v2Operational?.reconnect.lastHandshakeDurationMs, 42)
concurrentSocket.receive({
  type: 'operational_snapshot',
  gatewayId: 'gw_heartbeat_a',
  hermesAgentId: 'agent_heartbeat_a',
  snapshot: {
    ...operationalBase,
    version: 1,
    reconnect: { lastHandshakeDurationMs: 99, lastHandshakeOutcome: 'reconnected' },
  },
})
const v1Operational = concurrentRegistry.getByAgentId('agent_heartbeat_a')?.operational?.gateway
assert.equal(v1Operational?.reconnect.lastHandshakeOutcome, undefined)
assert.equal(v1Operational?.reconnect.lastHandshakeDurationMs, undefined)

const timeoutRegistry = new GatewayRegistry()
const timeoutSocket = attach(timeoutRegistry, 'agent_heartbeat_timeout', 'gw_heartbeat_timeout')
const firstMiss = await timeoutRegistry.heartbeatByAgentId('agent_heartbeat_timeout', 20)

assert.equal(firstMiss.ok, false)
assert.equal(firstMiss.error, 'Gateway heartbeat suspect')
assert.equal(firstMiss.liveness, 'suspect')
assert.equal(firstMiss.consecutiveMisses, 1)
assert.equal(timeoutSocket.terminateCount, 0)
assert.equal(timeoutSocket.readyState, 1)
assert.equal(timeoutRegistry.getByAgentId('agent_heartbeat_timeout')?.online, true)
assert.equal(timeoutRegistry.getByAgentId('agent_heartbeat_timeout')?.routable, true)

const secondMiss = await timeoutRegistry.heartbeatByAgentId('agent_heartbeat_timeout', 20)

assert.equal(secondMiss.ok, false)
assert.equal(secondMiss.error, 'Gateway heartbeat timeout')
assert.equal(secondMiss.liveness, 'offline')
assert.equal(timeoutSocket.terminateCount, 1)
assert.equal(timeoutSocket.readyState, 3)
assert.equal(timeoutRegistry.getByAgentId('agent_heartbeat_timeout')?.online, false)
assert.equal(timeoutRegistry.getByAgentId('agent_heartbeat_timeout')?.routable, false)

const timedOutFrames = timeoutSocket.sent.filter(frame => frame.type === 'heartbeat')
assert.equal(timedOutFrames.length, 2)
timeoutSocket.receive({
  type: 'heartbeat_ack',
  id: timedOutFrames[0]?.id,
  gatewayId: 'gw_heartbeat_timeout',
  hermesAgentId: 'agent_heartbeat_timeout',
})
assert.equal(timeoutRegistry.getByAgentId('agent_heartbeat_timeout')?.online, false)

const timedOutConnectionId = secondMiss.gatewayConnectionId
const replacementSocket = attach(
  timeoutRegistry,
  'agent_heartbeat_timeout',
  'gw_heartbeat_timeout',
)
const replacement = timeoutRegistry.getByAgentId('agent_heartbeat_timeout')
assert.notEqual(replacement?.gatewayConnectionId, timedOutConnectionId)
timeoutSocket.receive({
  type: 'heartbeat_ack',
  id: timedOutFrames[1]?.id,
  gatewayId: 'gw_heartbeat_timeout',
  hermesAgentId: 'agent_heartbeat_timeout',
})
assert.equal(
  timeoutRegistry.getByAgentId('agent_heartbeat_timeout')?.gatewayConnectionId,
  replacement?.gatewayConnectionId,
)
assert.equal(timeoutRegistry.getByAgentId('agent_heartbeat_timeout')?.online, true)
assert.equal(replacementSocket.readyState, 1)

const rotationRegistry = new GatewayRegistry()
const rotationActiveSocket = attach(
  rotationRegistry,
  'agent_heartbeat_rotation',
  'gw_heartbeat_rotation_active',
)
const rotationCandidateSocket = attach(
  rotationRegistry,
  'agent_heartbeat_rotation',
  'gw_heartbeat_rotation_candidate',
  'provisional',
)
const rotationFirstMiss = await rotationRegistry.heartbeatByAgentId(
  'agent_heartbeat_rotation',
  20,
)

assert.equal(rotationFirstMiss.ok, false)
assert.equal(rotationFirstMiss.liveness, 'suspect')
assert.equal(rotationFirstMiss.consecutiveMisses, 1)
assert.equal(rotationActiveSocket.readyState, 1)
assert.equal(rotationCandidateSocket.readyState, 1)

const rotationReservation = rotationRegistry.reserveCredentialActivation(
  'agent_heartbeat_rotation',
  'gw_heartbeat_rotation_candidate',
)
const rotationActivation = rotationRegistry.synchronizeCredentialActivation(
  rotationReservation,
)
const rotationSnapshot = rotationRegistry.heartbeatSnapshotByAgentId(
  'agent_heartbeat_rotation',
)

assert.equal(rotationActivation.activated, true)
assert.equal(rotationSnapshot.ok, true)
assert.equal(rotationSnapshot.liveness, 'healthy')
assert.equal(rotationSnapshot.gatewayId, 'gw_heartbeat_rotation_candidate')
assert.equal(rotationActiveSocket.readyState, 3)
assert.equal(rotationCandidateSocket.readyState, 1)

console.log(JSON.stringify({
  ok: true,
  target: {
    concurrentCallerCount: concurrentHeartbeats.length,
    heartbeatFrameCount: heartbeatFrames.length,
    cachedReadCount: cachedReads.length,
    cachedReadAdditionalFrameCount:
      concurrentSocket.sent.length - framesAfterActiveProbe,
    firstTimeoutTerminatesSocket: false,
    secondTimeoutTerminatesSocket: true,
    lateAckRestoresSocket: false,
    provisionalSocketMasksActiveMiss: false,
    activatedSocketOwnsLiveness: true,
  },
}, null, 2))
