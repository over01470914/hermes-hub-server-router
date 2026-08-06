import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { NativeConversationStore } from './nativeConversationStore.js'

const root = mkdtempSync(join(tmpdir(), 'hermes-hub-native-conversations-'))
const path = join(root, 'native-conversations.json')

try {
  const store = new NativeConversationStore(path)
  const existingSessions = store.ensureForSessions('agent_native_a', [
    'session_existing_a',
    'session_existing_a',
  ])
  const existingConversation = store.getBySessionId('agent_native_a', 'session_existing_a')
  assert.equal(existingSessions.length, 1)
  assert.ok(existingConversation)
  assert.equal(
    store.ensureForSessions('agent_native_a', ['session_existing_a']).length,
    1,
  )
  assert.equal(store.getBySessionId('agent_native_b', 'session_existing_a'), undefined)

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

  const continued = store.acceptSessionEvent(
    'agent_native_a',
    first.conversation.laneId,
    'session_native_continuation',
    'session_native_a',
  )
  assert.ok(continued)
  assert.equal(continued.conversationId, first.conversation.conversationId)
  assert.equal(continued.sessionId, 'session_native_continuation')
  store.updateSubmission('agent_native_a', 'sub_aaaaaaaa', 'accepted', {
    sessionId: continued.sessionId,
  })
  const staleParentEvent = store.acceptSessionEvent(
    'agent_native_a',
    first.conversation.laneId,
    'session_native_a',
  )
  assert.equal(staleParentEvent?.sessionId, 'session_native_continuation')
  const staleParentAcknowledgement = store.updateSubmission(
    'agent_native_a',
    'sub_aaaaaaaa',
    'accepted',
    { sessionId: 'session_native_a' },
  )
  assert.equal(staleParentAcknowledgement.sessionId, 'session_native_continuation')
  const continuedDuplicate = store.beginSubmission(
    'agent_native_a',
    'sub_aaaaaaaa',
    first.conversation.conversationId,
  )
  assert.equal(continuedDuplicate.conversation.conversationId, first.conversation.conversationId)
  assert.equal(continuedDuplicate.submission.sessionId, 'session_native_continuation')

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
    'session_native_continuation',
  )
  assert.equal(reloaded.getByLane('agent_native_b', first.conversation.laneId), undefined)

  const legacyRows = store.ensureForSessions('agent_native_legacy', [
    'session_legacy_parent',
    'session_legacy_child',
  ])
  assert.equal(legacyRows.length, 2)
  const legacyParent = store.getBySessionId('agent_native_legacy', 'session_legacy_parent')!
  const legacyChild = store.getBySessionId('agent_native_legacy', 'session_legacy_child')!
  store.beginSubmission(
    'agent_native_legacy',
    'sub_legacy_child',
    legacyChild.conversationId,
  )
  store.updateSubmission('agent_native_legacy', 'sub_legacy_child', 'accepted', {
    sessionId: 'session_legacy_child',
  })
  assert.ok(store.registerPrompt(
    'agent_native_legacy',
    legacyChild.laneId,
    'prompt_legacy_child',
    'session_legacy_child',
  ))

  const legacyLineage = {
    rootSessionId: 'session_legacy_parent',
    tipSessionId: 'session_legacy_child',
    pathSessionIds: ['session_legacy_parent', 'session_legacy_child'],
    allSessionIds: ['session_legacy_parent', 'session_legacy_child'],
  }
  const reconciled = store.reconcileSessionLineages('agent_native_legacy', [legacyLineage])
  assert.equal(reconciled.length, 1)
  assert.equal(reconciled[0].conversationId, legacyParent.conversationId)
  assert.equal(reconciled[0].sessionId, 'session_legacy_child')
  assert.deepEqual(reconciled[0].lineagePathSessionIds, legacyLineage.pathSessionIds)
  assert.equal(
    store.getByConversationId('agent_native_legacy', legacyChild.conversationId)?.conversationId,
    legacyParent.conversationId,
  )
  assert.equal(
    store.getByLane('agent_native_legacy', legacyChild.laneId)?.conversationId,
    legacyParent.conversationId,
  )
  assert.equal(
    store.getSubmission('agent_native_legacy', 'sub_legacy_child')?.conversationId,
    legacyParent.conversationId,
  )
  assert.equal(
    store.pendingPrompt('agent_native_legacy', 'prompt_legacy_child')?.conversationId,
    legacyParent.conversationId,
  )

  const afterFirstReconciliation = readFileSync(path, 'utf8')
  store.reconcileSessionLineages('agent_native_legacy', [legacyLineage])
  assert.equal(readFileSync(path, 'utf8'), afterFirstReconciliation)

  const legacyDuplicate = store.beginSubmission(
    'agent_native_legacy',
    'sub_legacy_child',
    legacyChild.conversationId,
  )
  assert.equal(legacyDuplicate.duplicate, true)
  assert.equal(legacyDuplicate.conversation.conversationId, legacyParent.conversationId)
  const lateLegacyParentEvent = store.acceptSessionEvent(
    'agent_native_legacy',
    legacyChild.laneId,
    'session_legacy_parent',
  )
  assert.equal(lateLegacyParentEvent?.sessionId, 'session_legacy_child')
  const nextLegacyContinuation = store.acceptSessionEvent(
    'agent_native_legacy',
    legacyChild.laneId,
    'session_legacy_next',
    'session_legacy_child',
  )
  assert.equal(nextLegacyContinuation?.sessionId, 'session_legacy_next')
  assert.equal(
    store.getByLane('agent_native_legacy', legacyParent.laneId)?.sessionId,
    'session_legacy_next',
  )
  store.reconcileSessionLineages('agent_native_legacy', [legacyLineage])
  assert.equal(
    store.getByConversationId('agent_native_legacy', legacyParent.conversationId)?.sessionId,
    'session_legacy_next',
  )

  const legacyReloaded = new NativeConversationStore(path)
  assert.equal(
    legacyReloaded.getByConversationId(
      'agent_native_legacy',
      legacyChild.conversationId,
    )?.conversationId,
    legacyParent.conversationId,
  )
  assert.equal(
    legacyReloaded.getByLane('agent_native_legacy', legacyChild.laneId)?.conversationId,
    legacyParent.conversationId,
  )
  assert.equal(
    legacyReloaded.needsLegacyLineageReconciliation('agent_native_legacy'),
    true,
  )
  legacyReloaded.markLegacyLineageReconciled('agent_native_legacy')
  const afterLineageMark = readFileSync(path, 'utf8')
  legacyReloaded.markLegacyLineageReconciled('agent_native_legacy')
  assert.equal(readFileSync(path, 'utf8'), afterLineageMark)
  assert.equal(
    new NativeConversationStore(path).needsLegacyLineageReconciliation(
      'agent_native_legacy',
    ),
    false,
  )

  const persisted = readFileSync(path, 'utf8')
  assert.equal(persisted.includes('message body must never persist'), false)
  assert.equal(persisted.includes('text'), false)
  assert.equal(persisted.includes('token'), false)

  console.log(JSON.stringify({
    ok: true,
    checks: [
      'conversation and submission keys are Agent-scoped',
      'existing Hermes sessions receive stable Agent-scoped native conversations',
      'accepted submission idempotency survives reload',
      'compression continuation keeps conversation identity and advances the native read target',
      'late parent events and acknowledgements cannot roll a continuation binding back',
      'every accepted native event advances conversation activity',
      'prompt scope does not cross Agents',
      'legacy parent and compression-child conversations collapse to the parent conversation id',
      'legacy conversation and lane ids remain aliases after reload',
      'legacy submissions and prompts migrate to the continuation tip',
      'lineage reconciliation is persistence-idempotent',
      'one-time legacy lineage scan markers survive reload idempotently',
      'registry persistence contains identifiers and state only',
    ],
  }, null, 2))
} finally {
  rmSync(root, { recursive: true, force: true })
}
