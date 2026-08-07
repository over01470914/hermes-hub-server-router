import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionDirectoryCacheStore } from './sessionDirectoryCacheStore.js'

const root = mkdtempSync(join(tmpdir(), 'hermes-hub-session-directory-'))
const path = join(root, 'session-directory.json')

try {
  const store = new SessionDirectoryCacheStore(path)
  const entry = store.put('agent_cache_a', 'limit=30', {
    object: 'list',
    limit: 30,
    offset: 0,
    has_more: false,
    sessions: [{
      id: 'conv_cache_a',
      title: 'Cached title',
      preview: 'message body must never persist',
      user_id: 'user must never persist',
      system_prompt: 'prompt must never persist',
      model_config: { secret: 'config must never persist' },
      source: 'cli',
      model: 'model-a',
      message_count: 7,
      last_active: 42,
      native: true,
      readOnly: false,
      topology: {
        relation: 'branch',
        parentConversationId: 'conv_parent_a',
        childCount: 2,
        ignored: 'never persist',
      },
    }],
  })
  assert.ok(entry)
  assert.equal(entry.rows.length, 1)
  assert.equal(entry.rows[0].title, 'Cached title')
  assert.equal(entry.rows[0].preview, undefined)
  assert.deepEqual(entry.rows[0].topology, {
    relation: 'branch',
    parentConversationId: 'conv_parent_a',
    childCount: 2,
  })
  assert.equal(
    store.put('agent_cache_a', 'malformed=1', { object: 'list' }),
    undefined,
  )

  const reloaded = new SessionDirectoryCacheStore(path)
  const cached = reloaded.get('agent_cache_a', 'limit=30')
  assert.equal(cached?.revision, entry.revision)
  assert.equal(cached?.rows[0].id, 'conv_cache_a')
  assert.equal(reloaded.get('agent_cache_b', 'limit=30'), undefined)
  const persisted = readFileSync(path, 'utf8')
  for (const forbidden of [
    'message body must never persist',
    'user must never persist',
    'prompt must never persist',
    'config must never persist',
  ]) assert.equal(persisted.includes(forbidden), false)

  reloaded.invalidateAgent('agent_cache_a')
  assert.equal(reloaded.get('agent_cache_a', 'limit=30'), undefined)

  console.log(JSON.stringify({
    ok: true,
    checks: [
      'directory cache is isolated by stable Agent scope and query',
      'only the bounded Session List card projection persists',
      'message preview, user id, prompt, and model config are excluded',
      'topology summary survives reload without raw Hermes fields',
      'malformed successful payloads are not cached as empty directories',
      'Agent invalidation removes every cached query',
    ],
  }, null, 2))
} finally {
  rmSync(root, { recursive: true, force: true })
}
