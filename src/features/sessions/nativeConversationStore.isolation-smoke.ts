import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { NativeConversationStore } from './nativeConversationStore.js'

const root = mkdtempSync(join(tmpdir(), 'hermes-hub-native-conversations-'))
const path = join(root, 'native-conversations.json')

try {
  const store = new NativeConversationStore(path)
  const first = store.beginSubmission('agent_native_a', 'sub_aaaaaaaa', undefined)
  const secondAgent = store.beginSubmission('agent_native_b', 'sub_aaaaaaaa', undefined)
  assert.notEqual(first.conversation.conversationId, secondAgent.conversation.conversationId)
  assert.notEqual(first.conversation.laneId, secondAgent.conversation.laneId)

  store.updateSubmission('agent_native_a', 'sub_aaaaaaaa', 'accepted', {
    sessionId: 'session_native_a',
  })
  const duplicate = store.beginSubmission(
    'agent_native_a',
    'sub_aaaaaaaa',
    first.conversation.conversationId,
  )
  assert.equal(duplicate.duplicate, true)
  assert.equal(duplicate.submission.state, 'accepted')
  assert.equal(duplicate.submission.sessionId, 'session_native_a')

  const beforeEventActivity = store.getByConversationId(
    'agent_native_a',
    first.conversation.conversationId,
  )?.updatedAt
  const touched = store.acceptSessionEvent(
    'agent_native_a',
    first.conversation.laneId,
    'session_native_a',
  )
  assert.ok(beforeEventActivity)
  assert.ok(touched)
  assert.ok(touched.updatedAt > beforeEventActivity)

  assert.ok(store.registerPrompt(
    'agent_native_a',
    first.conversation.laneId,
    'prompt_aaaaaaaa',
    'session_native_a',
  ))
  assert.equal(store.pendingPrompt('agent_native_b', 'prompt_aaaaaaaa'), undefined)

  const reloaded = new NativeConversationStore(path)
  assert.equal(
    reloaded.getByConversationId('agent_native_a', first.conversation.conversationId)?.sessionId,
    'session_native_a',
  )
  assert.equal(reloaded.getByLane('agent_native_b', first.conversation.laneId), undefined)

  const persisted = readFileSync(path, 'utf8')
  assert.equal(persisted.includes('message body must never persist'), false)
  assert.equal(persisted.includes('text'), false)
  assert.equal(persisted.includes('token'), false)

  console.log(JSON.stringify({
    ok: true,
    checks: [
      'conversation and submission keys are Agent-scoped',
      'accepted submission idempotency survives reload',
      'every accepted native event advances conversation activity',
      'prompt scope does not cross Agents',
      'registry persistence contains identifiers and state only',
    ],
  }, null, 2))
} finally {
  rmSync(root, { recursive: true, force: true })
}
