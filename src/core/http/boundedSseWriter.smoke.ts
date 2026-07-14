import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import type { ServerResponse } from 'node:http'
import { BoundedSseWriter, type DownstreamBackpressureError } from './boundedSseWriter.js'

class FakeResponse extends EventEmitter {
  destroyed = false
  writableEnded = false
  readonly writes: string[] = []
  blockNextWrite = false

  write(value: string): boolean {
    this.writes.push(value)
    if (!this.blockNextWrite) return true
    this.blockNextWrite = false
    return false
  }
}

const response = new FakeResponse()
const failures: DownstreamBackpressureError[] = []
const writer = new BoundedSseWriter(response as unknown as ServerResponse, {
  maxQueuedItems: 2,
  maxQueuedBytes: 32,
  drainTimeoutMs: 1000,
  onFailure: error => failures.push(error),
})

response.blockNextWrite = true
assert.equal(writer.write('first'), true)
assert.equal(writer.write('second'), true)
assert.equal(writer.write('third'), true)
assert.deepEqual(writer.stats, { blocked: true, queuedBytes: 11, queuedItems: 2 })
const flushed = writer.flush()
response.emit('drain')
await flushed
assert.deepEqual(response.writes, ['first', 'second', 'third'])
assert.deepEqual(writer.stats, { blocked: false, queuedBytes: 0, queuedItems: 0 })
writer.dispose()

const overflowResponse = new FakeResponse()
const overflowFailures: DownstreamBackpressureError[] = []
const overflowWriter = new BoundedSseWriter(overflowResponse as unknown as ServerResponse, {
  maxQueuedItems: 1,
  maxQueuedBytes: 16,
  drainTimeoutMs: 1000,
  onFailure: error => overflowFailures.push(error),
})
overflowResponse.blockNextWrite = true
assert.equal(overflowWriter.write('first'), true)
assert.equal(overflowWriter.write('queued'), true)
assert.equal(overflowWriter.write('overflow'), false)
assert.equal(overflowFailures.length, 1)
assert.equal(overflowFailures[0]?.code, 'downstream_queue_overflow')
await assert.rejects(overflowWriter.flush(), /queue exceeded/i)
assert.deepEqual(overflowWriter.stats, { blocked: false, queuedBytes: 0, queuedItems: 0 })
overflowWriter.dispose()

console.log('Bounded SSE writer OK: drain ordering, bounded queue, and isolated overflow failure')
