import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { SessionMetadataStore } from './sessionMetadataStore.js'

const root = mkdtempSync(join(tmpdir(), 'hermes-hub-session-metadata-'))
const path = join(root, 'session-metadata.json')

try {
  const store = new SessionMetadataStore(path)
  const sharedSessionId = 'session_same_id'

  store.set('agent_alpha', sharedSessionId, { categoryId: 'chat-link' })
  store.set('agent_beta', sharedSessionId, { categoryId: 'projects' })

  assert.equal(store.get('agent_alpha', sharedSessionId)?.categoryId, 'chat-link')
  assert.equal(store.get('agent_beta', sharedSessionId)?.categoryId, 'projects')
  assert.equal(store.get('agent_gamma', sharedSessionId), undefined)

  const alpha = store.applyToPayload('agent_alpha', {
    sessions: [{ id: sharedSessionId }],
  }) as { sessions: Array<{ categoryId?: string }> }
  const beta = store.applyToPayload('agent_beta', {
    sessions: [{ id: sharedSessionId }],
  }) as { sessions: Array<{ categoryId?: string }> }
  assert.equal(alpha.sessions[0]?.categoryId, 'chat-link')
  assert.equal(beta.sessions[0]?.categoryId, 'projects')

  store.copy('agent_alpha', sharedSessionId, 'session_fork')
  assert.equal(store.get('agent_alpha', 'session_fork')?.categoryId, 'chat-link')
  assert.equal(store.get('agent_beta', 'session_fork'), undefined)

  store.delete('agent_alpha', sharedSessionId)
  assert.equal(store.get('agent_alpha', sharedSessionId), undefined)
  assert.equal(store.get('agent_beta', sharedSessionId)?.categoryId, 'projects')

  const reloaded = new SessionMetadataStore(path)
  assert.equal(reloaded.get('agent_beta', sharedSessionId)?.categoryId, 'projects')
  assert.equal(reloaded.get('agent_alpha', 'session_fork')?.categoryId, 'chat-link')

  // Legacy unscoped records cannot be attributed safely in a multi-Agent
  // Router, so startup must ignore them instead of assigning them globally.
  writeFileSync(path, JSON.stringify({
    records: [{
      sessionId: sharedSessionId,
      categoryId: 'drafts',
      updatedAt: new Date().toISOString(),
    }],
  }))
  const migrated = new SessionMetadataStore(path)
  assert.equal(migrated.get('agent_alpha', sharedSessionId), undefined)
  assert.equal(migrated.get('agent_beta', sharedSessionId), undefined)
} finally {
  rmSync(root, { recursive: true, force: true })
}

console.log('Session metadata multi-Agent isolation smoke passed.')
