import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { attachSessionMetadata, metadataFromPatch, type SessionMetadataRecord } from './sessionMetadata.js'
import { logRouter } from '../../core/observability/routerLogger.js'

interface SessionMetadataStoreFile {
  records?: SessionMetadataRecord[]
}

export class SessionMetadataStore {
  private records = new Map<string, SessionMetadataRecord>()

  constructor(private readonly path: string) {
    this.load()
  }

  get(hermesAgentId: string, sessionId: string): SessionMetadataRecord | undefined {
    return this.records.get(this.key(hermesAgentId, sessionId))
  }

  set(hermesAgentId: string, sessionId: string, input: unknown): SessionMetadataRecord | undefined {
    const patch = metadataFromPatch(input)
    if (!patch.categoryId) return this.get(hermesAgentId, sessionId)
    const record = {
      hermesAgentId,
      sessionId,
      categoryId: patch.categoryId,
      updatedAt: new Date().toISOString(),
    }
    this.records.set(this.key(hermesAgentId, sessionId), record)
    this.save()
    return record
  }

  copy(hermesAgentId: string, sourceSessionId: string, targetSessionId: string): SessionMetadataRecord | undefined {
    const source = this.get(hermesAgentId, sourceSessionId)
    if (!source?.categoryId) return undefined
    return this.set(hermesAgentId, targetSessionId, { categoryId: source.categoryId })
  }

  delete(hermesAgentId: string, sessionId: string): boolean {
    const deleted = this.records.delete(this.key(hermesAgentId, sessionId))
    if (deleted) this.save()
    return deleted
  }

  applyToSession<T extends Record<string, unknown>>(hermesAgentId: string, session: T): T {
    const id = typeof session.id === 'string' ? session.id : ''
    return id ? attachSessionMetadata(session, this.get(hermesAgentId, id)) : session
  }

  applyToPayload(hermesAgentId: string, payload: unknown): unknown {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return payload
    const data = payload as Record<string, unknown>
    const next = { ...data }
    if (Array.isArray(next.sessions)) next.sessions = next.sessions.map(item => this.applyIfSession(hermesAgentId, item))
    if (Array.isArray(next.data)) next.data = next.data.map(item => this.applyIfSession(hermesAgentId, item))
    if (next.session && typeof next.session === 'object' && !Array.isArray(next.session)) {
      next.session = this.applyToSession(hermesAgentId, next.session as Record<string, unknown>)
    }
    return next
  }

  private key(hermesAgentId: string, sessionId: string): string {
    return `${hermesAgentId}\u0000${sessionId}`
  }

  private applyIfSession(hermesAgentId: string, item: unknown): unknown {
    return item && typeof item === 'object' && !Array.isArray(item)
      ? this.applyToSession(hermesAgentId, item as Record<string, unknown>)
      : item
  }

  private load(): void {
    if (!existsSync(this.path)) return
    try {
      const raw = JSON.parse(readFileSync(this.path, 'utf8')) as SessionMetadataStoreFile
      for (const record of raw.records || []) {
        // Pre-Gateway-only records had no Agent scope. They cannot be assigned
        // safely after a multi-Agent Router restart, so fail closed and ignore
        // them instead of leaking metadata to whichever Agent asks first.
        if (record.hermesAgentId && record.sessionId && record.categoryId) {
          this.records.set(this.key(record.hermesAgentId, record.sessionId), record)
        }
      }
    } catch (error) {
      logRouter('warn', 'Session metadata store load failed', { storePath: this.path }, error)
    }
  }

  private save(): void {
    mkdirSync(dirname(this.path), { recursive: true })
    const records = Array.from(this.records.values()).sort((a, b) => (
      a.hermesAgentId.localeCompare(b.hermesAgentId) || a.sessionId.localeCompare(b.sessionId)
    ))
    writeFileSync(this.path, JSON.stringify({ records }, null, 2) + '\n', { mode: 0o600 })
  }
}
