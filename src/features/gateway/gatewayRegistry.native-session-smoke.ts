import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import type { WebSocket } from 'ws'
import { GatewayRegistry, type GatewaySessionEvent } from './gatewayRegistry.js'

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

  terminate(): void { this.close(1006, 'terminated') }

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
      capabilities: ['health', 'sessions', 'session.message', 'session.prompt-response', 'runtime.status'],
    })
  }
}

function attach(registry: GatewayRegistry, agentId: string, gatewayId: string): FakeGatewaySocket {
  const socket = new FakeGatewaySocket()
  registry.attach(socket as unknown as WebSocket, {
    gatewayId,
    hermesAgentId: agentId,
    gatewayCredentialState: 'active',
    requestId: `pair_${gatewayId}`,
    user: 'smoke',
    deviceName: gatewayId,
  })
  socket.hello(gatewayId, agentId)
  return socket
}

const registry = new GatewayRegistry()
const events: GatewaySessionEvent[] = []
const runtimeSnapshots: string[] = []
registry.setSessionEventHandler(event => {
  events.push(event)
  return event.hermesAgentId === 'agent_native_a' && event.laneId === 'lane_aaaaaaaa'
})
registry.setRuntimeSnapshotHandler(snapshot => {
  runtimeSnapshots.push(snapshot.eventId)
})
const socketA = attach(registry, 'agent_native_a', 'gw_native_a')
attach(registry, 'agent_native_b', 'gw_native_b')

const submission = registry.submitSessionByAgentId('agent_native_a', {
  laneId: 'lane_aaaaaaaa',
  submissionId: 'sub_aaaaaaaa',
  deviceId: 'device_a',
  text: 'body visible only on the wire',
})
const sent = socketA.sent.find(frame => frame.type === 'session_submit')
assert.ok(sent)
assert.equal(sent.hermesAgentId, undefined)
assert.equal(sent.laneId, 'lane_aaaaaaaa')

socketA.receive({
  type: 'session_event',
  eventId: 'evt_aaaaaaaa',
  gatewayId: 'gw_native_a',
  hermesAgentId: 'agent_native_a',
  laneId: 'lane_aaaaaaaa',
  sessionId: 'session_native_a',
  submissionId: 'sub_aaaaaaaa',
  event: 'message.created',
  data: { role: 'user', content: 'body visible only on the wire' },
  sentAt: Date.now(),
})
assert.equal(events.length, 1)

socketA.receive({
  type: 'session_event',
  eventId: 'evt_delta_aaaaaaaa',
  gatewayId: 'gw_native_a',
  hermesAgentId: 'agent_native_a',
  laneId: 'lane_aaaaaaaa',
  sessionId: 'session_native_a',
  submissionId: 'sub_aaaaaaaa',
  event: 'message.delta',
  data: { delta: 'typed live content' },
  sentAt: Date.now(),
})
assert.equal(events.length, 2)
assert.equal(events[1]?.event, 'message.delta')
assert.equal(socketA.readyState, 1)

socketA.receive({
  type: 'session_submit_ack',
  id: sent.id,
  requestType: 'session_submit',
  accepted: true,
  laneId: 'lane_aaaaaaaa',
  submissionId: 'sub_aaaaaaaa',
  sessionId: 'session_native_a',
})
const acknowledged = await submission
assert.equal(acknowledged.sessionId, 'session_native_a')

const runtimePromise = registry.requestRuntimeSnapshotByAgentId('agent_native_a', {
  sessionId: 'session_native_a',
})
const runtimeRequest = socketA.sent.find(frame => frame.type === 'runtime_snapshot_request')
assert.ok(runtimeRequest)
socketA.receive({
  type: 'runtime_snapshot',
  id: runtimeRequest.id,
  gatewayId: 'gw_native_a',
  hermesAgentId: 'agent_native_a',
  sessionId: 'session_native_a',
  laneId: 'lane_aaaaaaaa',
  snapshot: {
    object: 'hermes.runtime.status',
    version: 1,
    scope: 'session',
    session_id: 'session_native_a',
    model: 'model-a',
    usage: { total_tokens: 48 },
    context: { context_used: 48, accuracy: 'estimated' },
    compression: { status: 'idle', available: false },
    debug_prompt: 'must not cross the Router cache boundary',
  },
})
const runtime = await runtimePromise
assert.equal(runtime.sessionId, 'session_native_a')
assert.equal(runtimeSnapshots.length, 1)
assert.equal(runtime.snapshot.model, 'model-a')
assert.equal('debug_prompt' in runtime.snapshot, false)
assert.equal(registry.getRuntimeSnapshotByAgentId('agent_native_a', 'session_native_a')?.snapshot.model, 'model-a')

const ambiguousSocket = attach(registry, 'agent_native_ambiguous', 'gw_native_ambiguous')
const ambiguous = registry.submitSessionByAgentId('agent_native_ambiguous', {
  laneId: 'lane_bbbbbbbb',
  submissionId: 'sub_bbbbbbbb',
  deviceId: 'device_b',
  text: 'do not resend me',
})
ambiguousSocket.close(1006, 'network lost')
await assert.rejects(ambiguous, error => (
  (error as { code?: string }).code === 'gateway_submission_ambiguous'
))

console.log(JSON.stringify({
  ok: true,
  checks: [
    'native submission is routed only to the selected Agent Gateway',
    'unsolicited native session events are accepted through the lane validator',
    'typed native message deltas preserve the Gateway connection',
    'native acknowledgement returns the Hermes session id',
    'versioned runtime snapshots are requested separately, cached, and redacted by the Router',
    'Gateway disconnect produces an ambiguous result and no retry',
  ],
}, null, 2))
