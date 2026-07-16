import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'

import type { WebSocket } from 'ws'
import { GatewayRegistry } from './gatewayRegistry.js'

class FakeGatewaySocket extends EventEmitter {
  readyState = 1
  readonly sent: Record<string, unknown>[] = []
  readonly closeCalls: Array<{ code?: number; reason?: string }> = []

  send(data: string, callback?: (error?: Error) => void): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>)
    callback?.()
  }

  close(code?: number, reason?: string): void {
    this.closeCalls.push({ code, reason })
    this.readyState = 3
    this.emit('close', code || 1000, Buffer.from(reason || ''))
  }

  terminate(): void {
    this.close(1006, 'terminated')
  }

  hello(gatewayId: string, hermesAgentId: string): void {
    this.emit('message', Buffer.from(JSON.stringify({
      type: 'hello',
      gatewayId,
      hermesAgentId,
      runtime: 'hermes-hub-gateway',
      mode: 'native-session',
      protocols: ['hermes-hub-gateway-rpc/v2'],
      capabilities: ['sessions', 'session.message', 'session.prompt-response'],
    })))
  }
}

const registry = new GatewayRegistry()
const hermesAgentId = 'agent_registry_rotation'
const oldGatewayId = 'gw_registry_old'
const candidateGatewayId = 'gw_registry_candidate'

const oldSocket = new FakeGatewaySocket()
registry.attach(oldSocket as unknown as WebSocket, {
  gatewayId: oldGatewayId,
  hermesAgentId,
  gatewayCredentialState: 'active',
  requestId: 'pair_registry_old',
  user: 'smoke',
  deviceName: 'old-host',
})
oldSocket.hello(oldGatewayId, hermesAgentId)
assert.equal(registry.get(oldGatewayId)?.routable, true)
assert.equal(registry.getByAgentId(hermesAgentId)?.gatewayId, oldGatewayId)

const candidateSocket = new FakeGatewaySocket()
registry.attach(candidateSocket as unknown as WebSocket, {
  gatewayId: candidateGatewayId,
  hermesAgentId,
  gatewayCredentialState: 'provisional',
  requestId: 'pair_registry_candidate',
  user: 'smoke',
  deviceName: 'candidate-host',
})
candidateSocket.hello(candidateGatewayId, hermesAgentId)

assert.equal(registry.get(candidateGatewayId)?.online, true)
assert.equal(registry.get(candidateGatewayId)?.routable, false)
assert.equal(
  registry.getByAgentId(hermesAgentId)?.gatewayId,
  oldGatewayId,
  'a provisional Gateway must not replace the active Agent route',
)

const reservation = registry.reserveCredentialActivation(hermesAgentId, candidateGatewayId)
const activation = registry.synchronizeCredentialActivation(reservation)
assert.equal(activation.activated, true)
assert.equal(activation.gateway?.gatewayCredentialState, 'active')
assert.equal(activation.gateway?.routable, true)
assert.equal(registry.getByAgentId(hermesAgentId)?.gatewayId, candidateGatewayId)
assert.deepEqual(oldSocket.closeCalls[0], {
  code: 4403,
  reason: 'gateway credential rotated',
})
assert.equal(registry.get(oldGatewayId)?.gatewayCredentialState, 'revoked')
assert.equal(registry.get(oldGatewayId)?.online, false)
assert.equal(registry.get(oldGatewayId)?.routable, false)

const retryRegistry = new GatewayRegistry()
const retryOldSocket = new FakeGatewaySocket()
retryRegistry.attach(retryOldSocket as unknown as WebSocket, {
  gatewayId: oldGatewayId,
  hermesAgentId,
  gatewayCredentialState: 'active',
  requestId: 'pair_registry_retry_old',
  user: 'smoke',
  deviceName: 'retry-old-host',
})
retryOldSocket.hello(oldGatewayId, hermesAgentId)
const retryCandidateSocket = new FakeGatewaySocket()
retryRegistry.attach(retryCandidateSocket as unknown as WebSocket, {
  gatewayId: candidateGatewayId,
  hermesAgentId,
  gatewayCredentialState: 'provisional',
  requestId: 'pair_registry_retry_candidate',
  user: 'smoke',
  deviceName: 'retry-candidate-host',
})
retryCandidateSocket.hello(candidateGatewayId, hermesAgentId)
const staleReservation = retryRegistry.reserveCredentialActivation(hermesAgentId, candidateGatewayId)
retryCandidateSocket.readyState = 2
const retryRequired = retryRegistry.synchronizeCredentialActivation(staleReservation)
assert.equal(retryRequired.activated, false)
assert.equal(retryRequired.reason, 'candidate_not_open')
assert.equal(retryRegistry.get(oldGatewayId)?.gatewayCredentialState, 'revoked')
assert.equal(retryRegistry.get(oldGatewayId)?.online, false)
assert.equal(retryRegistry.get(oldGatewayId)?.routable, false)
assert.deepEqual(retryOldSocket.closeCalls[0], {
  code: 4403,
  reason: 'gateway credential rotated',
})

const retryCandidateReplacement = new FakeGatewaySocket()
retryRegistry.attach(retryCandidateReplacement as unknown as WebSocket, {
  gatewayId: candidateGatewayId,
  hermesAgentId,
  gatewayCredentialState: 'active',
  requestId: 'pair_registry_retry_candidate',
  user: 'smoke',
  deviceName: 'retry-candidate-host',
})
retryCandidateReplacement.hello(candidateGatewayId, hermesAgentId)
const recoveredReservation = retryRegistry.reserveCredentialActivation(hermesAgentId, candidateGatewayId)
const recoveredActivation = retryRegistry.synchronizeCredentialActivation(recoveredReservation)
assert.equal(recoveredActivation.activated, true)
assert.equal(recoveredActivation.gateway?.gatewayConnectionId, recoveredReservation.gatewayConnectionId)
assert.equal(retryRegistry.getByAgentId(hermesAgentId)?.gatewayId, candidateGatewayId)

console.log(JSON.stringify({
  ok: true,
  checks: [
    'provisional Gateway hello is visible but not routable',
    'Agent traffic stays on the active Gateway before claim',
    'promotion switches the Agent route to the candidate',
    'rotation closes and quarantines the old Gateway socket',
    'a stale exact-connection reservation quarantines old routes and recovers idempotently',
  ],
}, null, 2))
