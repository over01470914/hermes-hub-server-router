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
}, [conversation]) as { sessions: Array<Record<string, unknown>> }

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
assert.equal(native.updated_at, conversation.updatedAt)
assert.equal(native.last_active, Math.floor(Date.parse(conversation.updatedAt) / 1000))
assert.equal(native.native, true)
assert.equal(native.readOnly, false)
assert.equal(legacy.id, 'session_legacy_a')
assert.equal(legacy.native, false)
assert.equal(legacy.readOnly, true)

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
    'newest ISO and Unix activity timestamps win',
    'legacy sessions remain read-only',
    'detail responses use the same native and legacy identity policy',
  ],
}, null, 2))
