import assert from 'node:assert/strict'
import {
  decodeSessionHistoryCursor,
  encodeSessionHistoryCursor,
} from './sessionHistoryCursor.js'
import { projectSessionMessagePage } from './sessionMessagePage.js'

const rows = Array.from({ length: 105 }, (_, index) => ({
  id: index + 1,
  role: index % 2 === 0 ? 'user' : 'assistant',
  content: `message-${index + 1}`,
}))

const latest = projectSessionMessagePage(rows, 0, 20, 512 * 1024)
assert.deepEqual(latest.items, rows.slice(85))
assert.equal(latest.loadedCount, 20)
assert.equal(latest.totalCount, 105)
assert.equal(latest.hasMoreOlder, true)
assert.equal(latest.nextOffset, 20)

const middle = projectSessionMessagePage(rows, latest.nextOffset!, 50, 512 * 1024)
assert.deepEqual(middle.items, rows.slice(35, 85))
assert.equal(middle.loadedCount, 70)
assert.equal(middle.hasMoreOlder, true)
assert.equal(middle.nextOffset, 70)
assert.equal(middle.transcriptRevision, latest.transcriptRevision)
assert.deepEqual(
  decodeSessionHistoryCursor(
    encodeSessionHistoryCursor(middle.nextOffset!, middle.transcriptRevision),
  ),
  {
    offset: 70,
    snapshotRevision: latest.transcriptRevision,
  },
)

const oldest = projectSessionMessagePage(rows, middle.nextOffset!, 50, 512 * 1024)
assert.deepEqual(oldest.items, rows.slice(0, 35))
assert.equal(oldest.loadedCount, 105)
assert.equal(oldest.hasMoreOlder, false)
assert.equal(oldest.nextOffset, undefined)

const reconstructed = [...oldest.items, ...middle.items, ...latest.items]
assert.deepEqual(reconstructed, rows)

const byteBounded = projectSessionMessagePage([
  { id: 1, content: 'a'.repeat(80) },
  { id: 2, content: 'b'.repeat(80) },
], 0, 20, 100)
assert.deepEqual(byteBounded.items, [{ id: 2, content: 'b'.repeat(80) }])
assert.equal(byteBounded.hasMoreOlder, true)

console.log(JSON.stringify({
  ok: true,
  checks: [
    'initial fallback page starts at the newest transcript edge',
    'older cursors reconstruct the chronological physical transcript exactly once',
    'revision is stable across pages',
    'fallback cursors bind later pages to the physical transcript revision',
    'response byte limits preserve cursor progress',
  ],
}, null, 2))
