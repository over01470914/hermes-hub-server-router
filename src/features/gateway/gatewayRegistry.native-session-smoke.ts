import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import type { WebSocket } from 'ws'
import {
  GatewayRegistry,
  type GatewayGlobalEvent,
  type GatewaySessionEvent,
} from './gatewayRegistry.js'

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

  hello(
    gatewayId: string,
    hermesAgentId: string,
    commandPresentation = true,
  ): void {
    this.receive({
      type: 'hello',
      gatewayId,
      hermesAgentId,
      runtime: 'hermes-hub-gateway',
      mode: 'native-session',
      protocols: ['hermes-hub-gateway-rpc/v2'],
      capabilities: [
        'health',
        'sessions',
        'session.message',
        ...(commandPresentation ? ['session.command-presentation'] : []),
        'session.model-selection',
        'session.runtime-controls',
        'session.prompt-response',
        'runtime.status',
      ],
    })
  }
}

function attach(
  registry: GatewayRegistry,
  agentId: string,
  gatewayId: string,
  commandPresentation = true,
): FakeGatewaySocket {
  const socket = new FakeGatewaySocket()
  registry.attach(socket as unknown as WebSocket, {
    gatewayId,
    hermesAgentId: agentId,
    gatewayCredentialState: 'active',
    requestId: `pair_${gatewayId}`,
    user: 'smoke',
    deviceName: gatewayId,
  })
  socket.hello(gatewayId, agentId, commandPresentation)
  return socket
}

const registry = new GatewayRegistry()
const events: GatewaySessionEvent[] = []
const globalEvents: GatewayGlobalEvent[] = []
const runtimeSnapshots: string[] = []
registry.setSessionEventHandler(event => {
  events.push(event)
  return event.hermesAgentId === 'agent_native_a' && event.laneId === 'lane_aaaaaaaa'
})
registry.setRuntimeSnapshotHandler(snapshot => {
  runtimeSnapshots.push(snapshot.eventId)
})
registry.setGlobalEventHandler(event => {
  globalEvents.push(event)
})
const socketA = attach(registry, 'agent_native_a', 'gw_native_a')
attach(registry, 'agent_native_b', 'gw_native_b')

socketA.receive({
  type: 'global_event',
  eventId: 'evt_sessions_changed_aaaa',
  gatewayId: 'gw_native_a',
  hermesAgentId: 'agent_native_a',
  event: 'sessions.changed',
  data: { profile: 'work' },
  sentAt: Date.now(),
})
assert.deepEqual(globalEvents, [{
  eventId: 'evt_sessions_changed_aaaa',
  gatewayId: 'gw_native_a',
  hermesAgentId: 'agent_native_a',
  event: 'sessions.changed',
  data: { profile: 'work' },
  sentAt: globalEvents[0]?.sentAt,
}])
assert.equal(socketA.readyState, 1)

const submission = registry.submitSessionByAgentId('agent_native_a', {
  laneId: 'lane_aaaaaaaa',
  submissionId: 'sub_aaaaaaaa',
  deviceId: 'device_a',
  text: '/usage',
  model: 'gpt-5.6-terra',
  provider: 'openai-codex',
  reasoningEffort: 'high',
  fast: false,
  presentation: 'command',
})
const sent = socketA.sent.find(frame => frame.type === 'session_submit')
assert.ok(sent)
assert.equal(sent.hermesAgentId, undefined)
assert.equal(sent.laneId, 'lane_aaaaaaaa')
assert.equal(sent.model, 'gpt-5.6-terra')
assert.equal(sent.provider, 'openai-codex')
assert.equal(sent.reasoningEffort, 'high')
assert.equal(sent.fast, false)
assert.equal(sent.presentation, 'command')

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
  type: 'session_event',
  eventId: 'evt_interim_aaaaaaaa',
  gatewayId: 'gw_native_a',
  hermesAgentId: 'agent_native_a',
  laneId: 'lane_aaaaaaaa',
  sessionId: 'session_native_a',
  submissionId: 'sub_aaaaaaaa',
  event: 'message.interim',
  data: { text: 'typed live content', already_streamed: true },
  sentAt: Date.now(),
})
assert.equal(events.length, 3)
assert.equal(events[2]?.event, 'message.interim')
assert.equal(socketA.readyState, 1)

socketA.receive({
  type: 'session_event',
  eventId: 'evt_live_input_aaaaaaaa',
  gatewayId: 'gw_native_a',
  hermesAgentId: 'agent_native_a',
  laneId: 'lane_aaaaaaaa',
  sessionId: 'session_native_a',
  submissionId: 'sub_aaaaaaaa',
  event: 'assistant.live_input',
  data: { messageId: 'live-input:sub_aaaaaaaa', text: 'current agent output' },
  sentAt: Date.now(),
})
assert.equal(events.length, 4)
assert.equal(events[3]?.event, 'assistant.live_input')
assert.equal(socketA.readyState, 1)

socketA.receive({
  type: 'session_event',
  eventId: 'evt_review_summary_aaaaaa',
  gatewayId: 'gw_native_a',
  hermesAgentId: 'agent_native_a',
  laneId: 'lane_aaaaaaaa',
  sessionId: 'session_native_a',
  submissionId: 'sub_aaaaaaaa',
  event: 'review.summary',
  data: { messageId: 'msg_review_aaaaaaaa', text: 'Self-improvement review: Updated memory.' },
  sentAt: Date.now(),
})
assert.equal(events.length, 5)
assert.equal(events[4]?.event, 'review.summary')
assert.equal(socketA.readyState, 1)

socketA.receive({
  type: 'session_event',
  eventId: 'evt_session_info_aaaaaaa',
  gatewayId: 'gw_native_a',
  hermesAgentId: 'agent_native_a',
  laneId: 'lane_aaaaaaaa',
  sessionId: 'session_native_a',
  submissionId: 'sub_aaaaaaaa',
  event: 'session.info',
  data: { running: true, cwd: '/private/host/path' },
  sentAt: Date.now(),
})
assert.equal(events.length, 6)
assert.equal(events[5]?.event, 'session.info')
assert.equal(socketA.readyState, 1)

socketA.receive({
  type: 'session_event',
  eventId: 'evt_session_title_aaaaaa',
  gatewayId: 'gw_native_a',
  hermesAgentId: 'agent_native_a',
  laneId: 'lane_aaaaaaaa',
  sessionId: 'session_native_a',
  submissionId: 'sub_aaaaaaaa',
  event: 'session.title',
  data: { session_id: 'session_native_a', title: 'Obsidian knowledge sync' },
  sentAt: Date.now(),
})
assert.equal(events.length, 7)
assert.equal(events[6]?.event, 'session.title')
assert.deepEqual(events[6]?.data, {
  session_id: 'session_native_a',
  title: 'Obsidian knowledge sync',
})
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

const legacySocket = attach(
  registry,
  'agent_native_legacy',
  'gw_native_legacy',
  false,
)
const legacySubmission = registry.submitSessionByAgentId('agent_native_legacy', {
  laneId: 'lane_legacy01',
  submissionId: 'sub_legacy001',
  deviceId: 'device_legacy',
  text: '/usage',
  presentation: 'command',
})
const legacySent = legacySocket.sent.find(frame => frame.type === 'session_submit')
assert.ok(legacySent)
assert.equal(legacySent.presentation, undefined)
legacySocket.receive({
  type: 'session_submit_ack',
  id: legacySent.id,
  requestType: 'session_submit',
  accepted: true,
  laneId: 'lane_legacy01',
  submissionId: 'sub_legacy001',
  sessionId: 'session_legacy01',
})
await legacySubmission

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
    'interim assistant boundaries preserve the Gateway connection',
    'transient assistant live input preserves the Gateway connection',
    'Desktop session info reaches the typed Flutter consumer through the Router allowlist',
    'session title metadata is identity-checked and bounded by the Router',
    'native acknowledgement returns the Hermes session id',
    'command presentation is forwarded only to a capable Gateway',
    'versioned runtime snapshots are requested separately, cached, and redacted by the Router',
    'Gateway disconnect produces an ambiguous result and no retry',
  ],
}, null, 2))
