import assert from 'node:assert/strict'
import {
  decodeSessionHistoryCursor,
  encodeSessionHistoryCursor,
} from './sessionHistoryCursor.js'
import { nativeSessionLineagesFromPayload } from './sessionLineage.js'

function lineage(payload: unknown, rootSessionId: string) {
  const found = nativeSessionLineagesFromPayload(payload)
    .find(item => item.rootSessionId === rootSessionId)
  assert.ok(found, `missing lineage ${rootSessionId}`)
  return found
}

const compression = lineage({ sessions: [
  {
    id: 'session_parent',
    source: 'cli',
    profile: 'main',
    end_reason: 'compression',
    ended_at: 20,
    started_at: 10,
    actual_message_count: 3,
  },
  {
    id: 'session_child',
    parent_session_id: 'session_parent',
    source: 'cli',
    profile: 'main',
    started_at: 20,
    last_activity: 30,
    actual_message_count: 2,
  },
] }, 'session_parent')
assert.equal(compression.tipSessionId, 'session_child')
assert.deepEqual(compression.pathSessionIds, ['session_parent', 'session_child'])

const multiHop = lineage({ sessions: [
  {
    id: 'session_root',
    source: 'cli',
    end_reason: 'compression',
    ended_at: 20,
    actual_message_count: 1,
  },
  {
    id: 'session_branch_fresh',
    parent_session_id: 'session_root',
    source: 'cli',
    started_at: 20,
    last_activity: 35,
    actual_message_count: 1,
  },
  {
    id: 'session_branch_deep',
    parent_session_id: 'session_root',
    source: 'cli',
    started_at: 20,
    end_reason: 'cli_close',
    ended_at: 30,
    last_activity: 25,
    actual_message_count: 1,
  },
  {
    id: 'session_deep_tip',
    parent_session_id: 'session_branch_deep',
    source: 'cli',
    started_at: 30,
    last_activity: 40,
    actual_message_count: 1,
  },
] }, 'session_root')
assert.equal(multiHop.tipSessionId, 'session_deep_tip')
assert.deepEqual(multiHop.pathSessionIds, [
  'session_root',
  'session_branch_deep',
  'session_deep_tip',
])
assert.deepEqual(new Set(multiHop.allSessionIds), new Set([
  'session_root',
  'session_branch_fresh',
  'session_branch_deep',
  'session_deep_tip',
]))

const excludedRows = [
  {
    id: 'session_excluded_root',
    source: 'cli',
    profile: 'main',
    end_reason: 'compression',
    ended_at: 50,
    actual_message_count: 1,
  },
  {
    id: 'session_fork',
    parent_session_id: 'session_excluded_root',
    source: 'cli',
    profile: 'main',
    session_source: 'fork',
    started_at: 60,
    actual_message_count: 1,
  },
  {
    id: 'session_cross_source',
    parent_session_id: 'session_excluded_root',
    source: 'webui',
    profile: 'main',
    started_at: 60,
    actual_message_count: 1,
  },
  {
    id: 'session_cross_profile',
    parent_session_id: 'session_excluded_root',
    source: 'cli',
    profile: 'other',
    started_at: 60,
    actual_message_count: 1,
  },
  {
    id: 'session_before_end',
    parent_session_id: 'session_excluded_root',
    source: 'cli',
    profile: 'main',
    started_at: 49,
    actual_message_count: 1,
  },
]
const excluded = nativeSessionLineagesFromPayload({ sessions: excludedRows })
assert.equal(excluded.length, excludedRows.length)
for (const row of excludedRows) {
  const standalone = excluded.find(item => item.rootSessionId === row.id)
  assert.ok(standalone)
  assert.equal(standalone.tipSessionId, row.id)
}

const hinted = nativeSessionLineagesFromPayload({ sessions: [{
  id: 'session_projected_tip',
  _lineage_root_id: 'session_hidden_root',
  _lineage_tip_id: 'session_projected_tip',
  actual_message_count: 2,
}] })
assert.equal(hinted.length, 1)
assert.equal(hinted[0].rootSessionId, 'session_hidden_root')
assert.equal(hinted[0].tipSessionId, 'session_projected_tip')
assert.deepEqual(hinted[0].pathSessionIds, ['session_hidden_root', 'session_projected_tip'])

const historyRevision = 'a'.repeat(64)
const historyCursor = encodeSessionHistoryCursor(50, historyRevision)
assert.deepEqual(decodeSessionHistoryCursor(historyCursor), {
  offset: 50,
  snapshotRevision: historyRevision,
})
assert.deepEqual(
  decodeSessionHistoryCursor(Buffer.from('100', 'utf8').toString('base64url')),
  { offset: 100 },
)
assert.throws(() => decodeSessionHistoryCursor(Buffer.from(JSON.stringify({
  offset: 50,
  snapshotRevision: 'stale',
}), 'utf8').toString('base64url')))

console.log(JSON.stringify({
  ok: true,
  checks: [
    'compression and cli-close descendants form one lineage',
    'freshest importable descendant wins across competing continuation branches',
    'fork, cross-source, cross-profile, and pre-end children remain independent',
    'upstream root/tip hints replace the projected-row singleton',
    'history cursors bind subsequent pages to one transcript snapshot',
  ],
}, null, 2))
