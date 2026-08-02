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
    this.readyState = 3
    this.emit('close', code, Buffer.from(reason))
  }

  terminate(): void { this.close(1006, 'terminated') }

  receive(frame: Record<string, unknown>): void {
    this.emit('message', Buffer.from(JSON.stringify(frame)))
  }
}

const registry = new GatewayRegistry()
const socket = new FakeGatewaySocket()
const gatewayId = 'gw_sidecar_router_smoke'
const hermesAgentId = 'agent_sidecar_router_smoke'
registry.attach(socket as unknown as WebSocket, {
  gatewayId,
  hermesAgentId,
  gatewayCredentialState: 'active',
  requestId: 'pair_sidecar_router_smoke',
  user: 'smoke',
  deviceName: 'Sidecar smoke',
})
socket.receive({
  type: 'hello',
  gatewayId,
  hermesAgentId,
  runtime: 'hermes-hub-gateway-sidecar',
  mode: 'sidecar',
  protocols: ['hermes-hub-gateway-rpc/v2'],
  capabilities: [],
  agentOnline: false,
})

assert.equal(socket.readyState, 1)
assert.equal(registry.getByAgentId(hermesAgentId)?.online, true)
assert.equal(registry.getByAgentId(hermesAgentId)?.agentOnline, false)
assert.equal(registry.getByAgentId(hermesAgentId)?.routable, false)
const transportOnlyHeartbeat = registry.heartbeatSnapshotByAgentId(hermesAgentId)
assert.equal(transportOnlyHeartbeat.online, true)
assert.equal(transportOnlyHeartbeat.agentOnline, false)
assert.equal(transportOnlyHeartbeat.ok, false)
assert.throws(
  () => registry.reserveCredentialActivation(hermesAgentId, gatewayId),
  /Agent bridge is not online/,
)
await assert.rejects(
  registry.submitSessionByAgentId(hermesAgentId, {
    laneId: 'lane_sidecar_smoke',
    submissionId: 'sub_sidecar_smoke',
    text: 'must not be routed while Agent is offline',
    deviceId: 'device_sidecar_smoke',
  }),
  /Hermes Agent runtime is unavailable/,
)

socket.receive({
  type: 'agent_status',
  gatewayId,
  hermesAgentId,
  online: true,
  runtime: 'hermes-hub-gateway',
  mode: 'native-session',
  protocols: ['hermes-hub-gateway-rpc/v2'],
  capabilities: ['health', 'session.message', 'session.prompt-response'],
  changedAt: Date.now(),
})
assert.equal(registry.getByAgentId(hermesAgentId)?.agentOnline, true)
assert.equal(registry.getByAgentId(hermesAgentId)?.routable, true)

const submission = registry.submitSessionByAgentId(hermesAgentId, {
  laneId: 'lane_sidecar_smoke',
  submissionId: 'sub_sidecar_smoke',
  text: 'routed only after the Agent bridge is online',
  deviceId: 'device_sidecar_smoke',
})
const request = socket.sent.find(frame => frame.type === 'session_submit')
assert.ok(request)
socket.receive({
  type: 'session_submit_ack',
  id: request.id,
  requestType: 'session_submit',
  accepted: true,
  laneId: 'lane_sidecar_smoke',
  submissionId: 'sub_sidecar_smoke',
  sessionId: 'session_sidecar_smoke',
})
assert.equal((await submission).sessionId, 'session_sidecar_smoke')

socket.receive({
  type: 'agent_status',
  gatewayId,
  hermesAgentId,
  online: false,
  runtime: 'hermes-hub-gateway',
  mode: 'native-session',
  protocols: ['hermes-hub-gateway-rpc/v2'],
  capabilities: [],
  changedAt: Date.now(),
})
assert.equal(registry.getByAgentId(hermesAgentId)?.online, true)
assert.equal(registry.getByAgentId(hermesAgentId)?.agentOnline, false)
assert.equal(registry.getByAgentId(hermesAgentId)?.routable, false)

socket.close()
console.log('Gateway Registry Sidecar smoke passed.')
