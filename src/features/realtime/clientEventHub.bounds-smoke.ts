import { EventEmitter } from 'node:events'
import type { WebSocket } from 'ws'
import { ClientEventHub } from './clientEventHub.js'
import { PendingRealtimeFrameBuffer } from './pendingRealtimeFrames.js'

class FakeSocket extends EventEmitter {
  readyState = 1
  bufferedAmount = 0
  closeCode?: number
  readonly sent: unknown[] = []

  send(data: string): void {
    this.sent.push(JSON.parse(data) as unknown)
  }

  ping(): void {}

  close(code = 1000): void {
    if (this.readyState === 3) return
    this.closeCode = code
    this.readyState = 3
    this.emit('close', code, Buffer.alloc(0))
  }

  terminate(): void {
    this.close(1006)
  }

  asWebSocket(): WebSocket {
    return this as unknown as WebSocket
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function publish(hub: ClientEventHub, scope: string, value: string): void {
  hub.publish({
    scope,
    conversationId: `conversation-${scope}`,
    sessionId: `session-${scope}`,
    submissionId: `submission-${scope}`,
    event: 'message.updated',
    data: { content: value },
  })
}

const byteBoundHub = new ClientEventHub({
  maxReplayEventsPerScope: 16,
  maxReplayBytesPerScope: 128,
  maxJournalScopes: 4,
  heartbeatIntervalMs: 60_000
})
publish(byteBoundHub, 'byte-bound', 'x'.repeat(512))
const byteBoundSocket = new FakeSocket()
const byteBoundAttach = byteBoundHub.attach(byteBoundSocket.asWebSocket(), {
  scope: 'byte-bound',
  clientId: 'byte-bound-client',
  afterCursor: 0
})
assert(byteBoundAttach.resyncRequired, 'byte-trimmed journal did not require resync')
assert(
  byteBoundSocket.sent.some(message => (message as { type?: string }).type === 'bridge.resync_required'),
  'byte-trimmed journal did not emit bridge.resync_required'
)
byteBoundHub.reset()

const scopeBoundHub = new ClientEventHub({
  maxReplayEventsPerScope: 16,
  maxReplayBytesPerScope: 64 * 1024,
  maxJournalScopes: 2,
  heartbeatIntervalMs: 60_000
})
publish(scopeBoundHub, 'scope-a', 'a')
const activeScopeSocket = new FakeSocket()
scopeBoundHub.attach(activeScopeSocket.asWebSocket(), {
  scope: 'scope-a',
  clientId: 'scope-a-active'
})
publish(scopeBoundHub, 'scope-b', 'b')
publish(scopeBoundHub, 'scope-c', 'c')
const evictedScopeSocket = new FakeSocket()
const evictedScopeAttach = scopeBoundHub.attach(evictedScopeSocket.asWebSocket(), {
  scope: 'scope-b',
  clientId: 'scope-b-reconnect',
  afterCursor: 0
})
assert(evictedScopeAttach.resyncRequired, 'idle LRU journal eviction did not require resync')
const activeReplaySocket = new FakeSocket()
const activeReplayAttach = scopeBoundHub.attach(activeReplaySocket.asWebSocket(), {
  scope: 'scope-a',
  clientId: 'scope-a-replay',
  afterCursor: 0
})
assert(!activeReplayAttach.resyncRequired, 'active scope journal was evicted')
assert(activeReplayAttach.replayed === 1, 'active scope replay was not retained')
scopeBoundHub.reset()

const slowHub = new ClientEventHub({
  maxSubscriberBufferedBytes: 512,
  heartbeatIntervalMs: 60_000
})
const slowSocket = new FakeSocket()
slowHub.attach(slowSocket.asWebSocket(), {
  scope: 'slow-scope',
  clientId: 'slow-client'
})
publish(slowHub, 'slow-scope', 'x'.repeat(1024))
assert(slowSocket.closeCode === 1013, 'slow subscriber was not closed with code 1013')
slowHub.reset()

const originHub = new ClientEventHub({ heartbeatIntervalMs: 60_000 })
const originSocket = new FakeSocket()
const peerSocket = new FakeSocket()
originHub.attach(originSocket.asWebSocket(), { scope: 'origin-scope', clientId: 'origin' })
originHub.attach(peerSocket.asWebSocket(), { scope: 'origin-scope', clientId: 'peer' })
const first = originHub.publish({
  scope: 'origin-scope',
  conversationId: 'conv_origin',
  eventId: 'evt_origin_dedup',
  event: 'message.created',
  data: { role: 'assistant', content: 'shared' },
  originClientId: 'origin',
})
const duplicate = originHub.publish({
  scope: 'origin-scope',
  conversationId: 'conv_origin',
  eventId: 'evt_origin_dedup',
  event: 'message.created',
  data: { role: 'assistant', content: 'shared' },
})
assert(first.cursor === duplicate.cursor, 'Gateway event id was not deduplicated')
assert(
  originSocket.sent.some(message => (message as { event_id?: string }).event_id === 'evt_origin_dedup'),
  'origin client did not receive its native session event',
)
assert(
  peerSocket.sent.some(message => (message as { event_id?: string }).event_id === 'evt_origin_dedup'),
  'peer client did not receive the native session event',
)
originHub.reset()

const tailBuffer = new PendingRealtimeFrameBuffer(3, 64 * 1024)
for (let index = 1; index <= 5; index += 1) {
  tailBuffer.push({
    type: 'rpc_stream_chunk',
    id: 'fresh-stream',
    event: 'message.delta',
    data: { index, delta: String(index) },
    sentAt: index
  })
}
const tailFrames = tailBuffer.drain()
assert(tailFrames.length === 3, 'pending frame count bound was not applied')
assert(
  tailFrames.map(frame => (frame.type === 'rpc_stream_chunk' ? (frame.data as { index: number }).index : 0)).join(',') === '3,4,5',
  'pending frame buffer did not retain the newest tail'
)

const terminalBuffer = new PendingRealtimeFrameBuffer(2, 128)
terminalBuffer.push({
  type: 'rpc_stream_end',
  id: 'fresh-terminal',
  status: 200,
  bodyBase64: Buffer.from('terminal-body'.repeat(32), 'utf8').toString('base64')
})
terminalBuffer.push({
  type: 'rpc_stream_chunk',
  id: 'fresh-terminal',
  event: 'message.delta',
  data: { delta: 'late'.repeat(64) }
})
const terminalFrames = terminalBuffer.drain()
assert(terminalFrames.length === 1, 'oversized terminal exception retained extra frames')
assert(terminalFrames[0]?.type === 'rpc_stream_end', 'pending byte trim discarded terminal frame')

console.log(JSON.stringify({
  ok: true,
  checks: {
    byteTrimRequiresResync: byteBoundAttach.resyncRequired,
    idleScopeEvictionRequiresResync: evictedScopeAttach.resyncRequired,
    activeScopeReplayRetained: activeReplayAttach.replayed,
    slowSubscriberCloseCode: slowSocket.closeCode,
    originAndPeerReceivedTypedEvent: true,
    pendingTailFrames: tailFrames.length,
    pendingTerminalRetained: terminalFrames[0]?.type === 'rpc_stream_end'
  }
}, null, 2))
