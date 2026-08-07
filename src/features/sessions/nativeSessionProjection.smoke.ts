import assert from 'node:assert/strict'
import type { NativeConversationRecord } from './nativeConversationStore.js'
import { projectNativeSessionDetailPayload, projectNativeSessionListPayload } from './nativeSessionProjection.js'

const conversation: NativeConversationRecord = {
  hermesAgentId: 'agent_native_a',
  conversationId: 'conv_aaaaaaaa',
  laneId: 'lane_aaaaaaaa',
  sessionId: 'session_native_a',
  native: true,
  readOnly: false,
  createdAt: '2026-07-17T01:00:00.000Z',
  updatedAt: '2026-07-17T03:00:00.000Z',
}

const staleConversation: NativeConversationRecord = {
  ...conversation,
  conversationId: 'conv_stale_aaaaaaaa',
  laneId: 'lane_stale_aaaaaaaa',
  sessionId: 'session_not_listed',
}

const projected = projectNativeSessionListPayload({
  sessions: [
    {
      id: 'session_native_a',
      title: 'Hermes supplied title',
      preview: 'Hermes supplied preview',
      model: 'native-model',
      profile: 'native-profile',
      message_count: 7,
      created_at: '2026-07-17T00:30:00.000Z',
      updated_at: '2026-07-17T02:00:00.000Z',
      last_active: Date.parse('2026-07-17T02:30:00.000Z'),
    },
    {
      id: 'session_legacy_a',
      title: 'Legacy title',
    },
  ],
}, [conversation, staleConversation]) as { sessions: Array<Record<string, unknown>> }

const [native, legacy] = projected.sessions
assert.equal(native.id, conversation.conversationId)
assert.equal(native.session_id, conversation.conversationId)
assert.equal(native.conversation_id, conversation.conversationId)
assert.equal(native.hermes_session_id, conversation.sessionId)
assert.equal(native.title, 'Hermes supplied title')
assert.equal(native.preview, 'Hermes supplied preview')
assert.equal(native.model, 'native-model')
assert.equal(native.profile, 'native-profile')
assert.equal(native.message_count, 7)
assert.equal(native.created_at, '2026-07-17T00:30:00.000Z')
assert.equal(native.updated_at, '2026-07-17T02:00:00.000Z')
assert.equal(native.last_active, Math.floor(Date.parse('2026-07-17T02:30:00.000Z') / 1000))
assert.equal(native.native, true)
assert.equal(native.readOnly, false)
assert.deepEqual(native.topology, { relation: 'root', childCount: 0 })
assert.equal(legacy.id, 'session_legacy_a')
assert.equal(legacy.native, false)
assert.equal(legacy.readOnly, true)
assert.equal(projected.sessions.some(session => session.id === staleConversation.conversationId), false)

const noActivityProjection = projectNativeSessionListPayload({
  sessions: [{ id: 'session_native_a', title: 'No upstream activity' }],
}, [conversation]) as { sessions: Array<Record<string, unknown>> }
assert.equal(noActivityProjection.sessions[0].last_active, undefined)

const lineageConversation: NativeConversationRecord = {
  ...conversation,
  conversationId: 'conv_lineage_aaaaaaaa',
  laneId: 'lane_lineage_aaaaaaaa',
  sessionId: 'session_lineage_tip',
  lineageRootSessionId: 'session_lineage_root',
  lineageSessionIds: [
    'session_lineage_root',
    'session_lineage_middle',
    'session_lineage_tip',
  ],
  lineagePathSessionIds: [
    'session_lineage_root',
    'session_lineage_middle',
    'session_lineage_tip',
  ],
}
const lineageProjection = projectNativeSessionListPayload({ sessions: [
  {
    id: 'session_lineage_root',
    title: 'Original lineage title',
    source: 'cli',
    created_at: '2026-07-16T01:00:00.000Z',
    last_active: Date.parse('2026-07-16T02:00:00.000Z'),
  },
  {
    id: 'session_lineage_middle',
    title: 'Hidden middle segment',
    source: 'cli',
  },
  {
    id: 'session_lineage_tip',
    title: 'Continuation title',
    source: 'cli',
    preview: 'Newest continuation preview',
    updated_at: '2026-07-17T04:00:00.000Z',
    last_active: Date.parse('2026-07-17T04:30:00.000Z'),
  },
] }, [lineageConversation]) as { sessions: Array<Record<string, unknown>> }
assert.equal(lineageProjection.sessions.length, 1)
assert.equal(lineageProjection.sessions[0].id, lineageConversation.conversationId)
assert.equal(lineageProjection.sessions[0].hermes_session_id, 'session_lineage_tip')
assert.equal(lineageProjection.sessions[0].title, 'Original lineage title')
assert.equal(lineageProjection.sessions[0].created_at, '2026-07-16T01:00:00.000Z')
assert.equal(lineageProjection.sessions[0].preview, 'Newest continuation preview')
assert.equal(
  lineageProjection.sessions[0].last_active,
  Math.floor(Date.parse('2026-07-17T04:30:00.000Z') / 1000),
)

const parentConversation: NativeConversationRecord = {
  ...conversation,
  conversationId: 'conv_branch_parent',
  laneId: 'lane_branch_parent',
  sessionId: 'session_branch_parent',
}
const branchConversation: NativeConversationRecord = {
  ...conversation,
  conversationId: 'conv_branch_child',
  laneId: 'lane_branch_child',
  sessionId: 'session_branch_child',
}
const branchProjection = projectNativeSessionListPayload({ sessions: [
  { id: 'session_branch_parent', title: 'Parent' },
  {
    id: 'session_branch_child',
    title: 'Branch',
    parent_session_id: 'session_branch_parent',
  },
] }, [parentConversation, branchConversation]) as { sessions: Array<Record<string, unknown>> }
assert.deepEqual(branchProjection.sessions[0].topology, {
  relation: 'root',
  childCount: 1,
})
assert.deepEqual(branchProjection.sessions[1].topology, {
  relation: 'branch',
  parentConversationId: 'conv_branch_parent',
  childCount: 0,
})

const nativeDetail = projectNativeSessionDetailPayload({
  data: {
    id: 'session_native_a',
    title: 'Native detail',
  },
}, conversation) as { session: Record<string, unknown> }
assert.equal(nativeDetail.session.id, conversation.conversationId)
assert.equal(nativeDetail.session.hermes_session_id, conversation.sessionId)
assert.equal(nativeDetail.session.native, true)
assert.equal(nativeDetail.session.readOnly, false)

const legacyDetail = projectNativeSessionDetailPayload({
  session: {
    id: 'api_legacy_session',
    title: 'Legacy detail',
  },
}) as { session: Record<string, unknown> }
assert.equal(legacyDetail.session.id, 'api_legacy_session')
assert.equal(legacyDetail.session.native, false)
assert.equal(legacyDetail.session.readOnly, true)

console.log(JSON.stringify({
  ok: true,
  checks: [
    'native conversation identity remains stable',
    'Hermes session metadata is preserved',
    'only upstream transcript activity timestamps populate last_active',
    'lineage rows preserve root identity and tip activity without duplicate segments',
    'visible branch rows reference stable Router conversation ids',
    'stale persisted conversation mappings are not projected',
    'legacy sessions remain read-only',
    'detail responses use the same native and legacy identity policy',
  ],
}, null, 2))
