import { createHash } from 'node:crypto'
import { dirname } from 'node:path'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { logRouter } from '../../core/observability/routerLogger.js'

type JsonRecord = Record<string, unknown>

export type SessionDirectoryCacheState = 'fresh' | 'refreshed' | 'stale-fallback'

export interface SessionDirectoryCacheEntry {
  hermesAgentId: string
  queryKey: string
  rows: JsonRecord[]
  object?: string
  limit?: number
  offset?: number
  hasMore?: boolean
  revision: string
  refreshedAt: string
}

interface SessionDirectoryCacheFile {
  entries?: SessionDirectoryCacheEntry[]
}

const agentIdPattern = /^agent_[A-Za-z0-9._:-]{2,154}$/
const maxEntriesPerAgent = 12
const maxRowsPerEntry = 200

function asRecord(value: unknown): JsonRecord | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : undefined
}

function boundedString(value: unknown, maximum: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > maximum || /[\r\n\0]/.test(trimmed)) return undefined
  return trimmed
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function safeTopology(value: unknown): JsonRecord | undefined {
  const topology = asRecord(value)
  if (!topology) return undefined
  const relation = boundedString(topology.relation, 32)
  const parentConversationId = boundedString(topology.parentConversationId, 256)
  const childCount = finiteNumber(topology.childCount)
  if (!relation && !parentConversationId && childCount === undefined) return undefined
  return {
    ...(relation ? { relation } : {}),
    ...(parentConversationId ? { parentConversationId } : {}),
    ...(childCount !== undefined ? { childCount: Math.max(0, Math.floor(childCount)) } : {}),
  }
}

/**
 * Persist only the bounded Session List card projection needed for a fast
 * Resume directory. Message previews/bodies, user ids, prompts, model config,
 * cost/token details, and raw Hermes rows are deliberately excluded.
 */
function safeSessionRow(value: unknown): JsonRecord | undefined {
  const row = asRecord(value)
  if (!row) return undefined
  const id = boundedString(row.id ?? row.session_id, 256)
  if (!id) return undefined
  const title = boundedString(row.title, 512)
  const source = boundedString(row.source, 128)
  const model = boundedString(row.model, 256)
  const provider = boundedString(row.provider ?? row.model_provider, 128)
  const profile = boundedString(row.profile ?? row.profile_name, 128)
  const workspace = boundedString(row.workspace, 256)
  const categoryId = boundedString(row.categoryId ?? row.category_id, 128)
  const topology = safeTopology(row.topology)
  const messageCount = finiteNumber(row.message_count ?? row.messageCount)
  const lastActive = finiteNumber(row.last_active ?? row.lastActive)
  const startedAt = finiteNumber(row.started_at ?? row.startedAt)
  const endedAt = finiteNumber(row.ended_at ?? row.endedAt)
  const native = row.native === true
  const readOnly = !native || row.readOnly === true || row.read_only === true
  return {
    id,
    session_id: id,
    conversation_id: id,
    ...(title ? { title } : {}),
    ...(source ? { source } : {}),
    ...(model ? { model } : {}),
    ...(provider ? { provider } : {}),
    ...(profile ? { profile } : {}),
    ...(workspace ? { workspace } : {}),
    ...(categoryId ? { categoryId } : {}),
    ...(messageCount !== undefined ? { message_count: Math.max(0, Math.floor(messageCount)) } : {}),
    ...(lastActive !== undefined ? { last_active: lastActive } : {}),
    ...(startedAt !== undefined ? { started_at: startedAt } : {}),
    ...(endedAt !== undefined ? { ended_at: endedAt } : {}),
    ...(topology ? { topology } : {}),
    native,
    readOnly,
    read_only: readOnly,
  }
}

export class SessionDirectoryCacheStore {
  private readonly entries = new Map<string, SessionDirectoryCacheEntry>()

  constructor(private readonly path: string) {
    this.load()
  }

  get(hermesAgentId: string, queryKey: string): SessionDirectoryCacheEntry | undefined {
    this.assertAgentId(hermesAgentId)
    return this.entries.get(this.key(hermesAgentId, queryKey))
  }

  put(hermesAgentId: string, queryKey: string, payload: unknown): SessionDirectoryCacheEntry | undefined {
    this.assertAgentId(hermesAgentId)
    const record = asRecord(payload)
    if (!record) return undefined
    const values = Array.isArray(record.sessions)
      ? record.sessions
      : Array.isArray(record.data)
        ? record.data
        : undefined
    if (!values) return undefined
    const rows = values
      .flatMap(value => {
        const row = safeSessionRow(value)
        return row ? [row] : []
      })
      .slice(0, maxRowsPerEntry)
    const refreshedAt = new Date().toISOString()
    const revision = createHash('sha256')
      .update(JSON.stringify(rows))
      .digest('hex')
    const entry: SessionDirectoryCacheEntry = {
      hermesAgentId,
      queryKey,
      rows,
      object: boundedString(record.object, 32),
      limit: finiteNumber(record.limit),
      offset: finiteNumber(record.offset),
      hasMore: record.has_more === true || record.hasMore === true,
      revision,
      refreshedAt,
    }
    this.entries.set(this.key(hermesAgentId, queryKey), entry)
    this.prune(hermesAgentId)
    this.save()
    return entry
  }

  invalidateAgent(hermesAgentId: string): void {
    this.assertAgentId(hermesAgentId)
    let changed = false
    for (const [key, entry] of this.entries) {
      if (entry.hermesAgentId !== hermesAgentId) continue
      this.entries.delete(key)
      changed = true
    }
    if (changed) this.save()
  }

  response(entry: SessionDirectoryCacheEntry, state: SessionDirectoryCacheState): JsonRecord {
    return {
      object: entry.object || 'list',
      sessions: entry.rows,
      data: entry.rows,
      ...(entry.limit !== undefined ? { limit: entry.limit } : {}),
      ...(entry.offset !== undefined ? { offset: entry.offset } : {}),
      ...(entry.hasMore !== undefined ? { has_more: entry.hasMore } : {}),
      cache: {
        state,
        revision: entry.revision,
        refreshed_at: entry.refreshedAt,
      },
    }
  }

  private load(): void {
    if (!existsSync(this.path)) return
    try {
      const raw = JSON.parse(readFileSync(this.path, 'utf8')) as SessionDirectoryCacheFile
      for (const value of raw.entries || []) {
        const entry = this.cleanEntry(value)
        if (entry) this.entries.set(this.key(entry.hermesAgentId, entry.queryKey), entry)
      }
    } catch (error) {
      logRouter('warn', 'session.directory_cache.load_failed', 'Session directory cache could not be restored from disk.', {
        outcome: 'failed',
        errorCode: 'session_directory_cache_load_failed',
        nextAction: 'refresh_from_gateway',
      }, error)
    }
  }

  private save(): void {
    mkdirSync(dirname(this.path), { recursive: true })
    const entries = [...this.entries.values()].sort((left, right) => (
      left.hermesAgentId.localeCompare(right.hermesAgentId)
      || left.queryKey.localeCompare(right.queryKey)
    ))
    writeFileSync(this.path, `${JSON.stringify({ entries }, null, 2)}\n`, { mode: 0o600 })
  }

  private cleanEntry(value: unknown): SessionDirectoryCacheEntry | undefined {
    const record = asRecord(value)
    if (!record) return undefined
    const hermesAgentId = boundedString(record.hermesAgentId, 160)
    const queryKey = boundedString(record.queryKey, 512)
    const revision = boundedString(record.revision, 128)
    const refreshedAt = boundedString(record.refreshedAt, 64)
    if (
      !hermesAgentId
      || !agentIdPattern.test(hermesAgentId)
      || !queryKey
      || !revision
      || !refreshedAt
      || !Number.isFinite(Date.parse(refreshedAt))
    ) return undefined
    const rows = Array.isArray(record.rows)
      ? record.rows.flatMap(row => {
          const safe = safeSessionRow(row)
          return safe ? [safe] : []
        }).slice(0, maxRowsPerEntry)
      : []
    return {
      hermesAgentId,
      queryKey,
      rows,
      object: boundedString(record.object, 32),
      limit: finiteNumber(record.limit),
      offset: finiteNumber(record.offset),
      hasMore: typeof record.hasMore === 'boolean' ? record.hasMore : undefined,
      revision,
      refreshedAt,
    }
  }

  private prune(hermesAgentId: string): void {
    const agentEntries = [...this.entries.values()]
      .filter(entry => entry.hermesAgentId === hermesAgentId)
      .sort((left, right) => right.refreshedAt.localeCompare(left.refreshedAt))
    for (const entry of agentEntries.slice(maxEntriesPerAgent)) {
      this.entries.delete(this.key(entry.hermesAgentId, entry.queryKey))
    }
  }

  private assertAgentId(value: string): void {
    if (!agentIdPattern.test(value)) {
      throw Object.assign(new Error('Hermes Agent id is invalid'), {
        code: 'validation_error',
        statusCode: 400,
      })
    }
  }

  private key(hermesAgentId: string, queryKey: string): string {
    return `${hermesAgentId}\u0000${queryKey}`
  }
}
