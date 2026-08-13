import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'

export const diagnosticsEvidenceSchemaVersion = 1 as const

export type DiagnosticsEvidence = {
  schemaVersion: typeof diagnosticsEvidenceSchemaVersion
  evidenceId: string
  observedAt: string
  monotonicMs: number
  sourceNode: 'router'
  stage: string
  transport: 'http' | 'websocket' | 'sse' | 'internal'
  direction: 'ingress' | 'egress' | 'internal'
  outcome: 'started' | 'completed' | 'failed' | 'dropped'
  requestId?: string
  hermesAgentId?: string
  clientId?: string
  sessionId?: string
  eventId?: string
  routerCursor?: number
  sendIndex?: number
  byteCount?: number
  fingerprint?: string
  detail?: Record<string, unknown>
}

type DiagnosticsEvidenceListener = (evidence: DiagnosticsEvidence) => void

export class DiagnosticsEvidenceJournal {
  private readonly started = process.hrtime.bigint()
  private readonly records: Array<{ evidence: DiagnosticsEvidence; bytes: number }> = []
  private readonly listeners = new Set<DiagnosticsEvidenceListener>()
  private dropped = 0
  private retainedBytes = 0

  constructor(
    private readonly maxRecords = 50_000,
    private readonly maxBytes = 256 * 1024 * 1024,
  ) {}

  record(input: Omit<DiagnosticsEvidence, 'schemaVersion' | 'evidenceId' | 'observedAt' | 'monotonicMs'>): DiagnosticsEvidence {
    const evidence: DiagnosticsEvidence = {
      schemaVersion: diagnosticsEvidenceSchemaVersion,
      evidenceId: `evidence_${randomUUID()}`,
      observedAt: new Date().toISOString(),
      monotonicMs: Number((process.hrtime.bigint() - this.started) / 1_000_000n),
      ...input,
    }
    this.append(evidence)
    for (const listener of this.listeners) {
      try { listener(evidence) } catch { /* An observer must never affect Router delivery. */ }
    }
    return evidence
  }

  snapshot(limit = 1000): {
    schemaVersion: number
    dropped: number
    retainedBytes: number
    maxRecords: number
    maxBytes: number
    events: DiagnosticsEvidence[]
  } {
    return {
      schemaVersion: diagnosticsEvidenceSchemaVersion,
      dropped: this.dropped,
      retainedBytes: this.retainedBytes,
      maxRecords: this.maxRecords,
      maxBytes: this.maxBytes,
      events: this.records
        .slice(-Math.max(1, Math.min(limit, this.maxRecords)))
        .map(record => record.evidence),
    }
  }

  subscribe(listener: DiagnosticsEvidenceListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private append(evidence: DiagnosticsEvidence): void {
    const bytes = Buffer.byteLength(JSON.stringify(evidence), 'utf8')
    this.records.push({ evidence, bytes })
    this.retainedBytes += bytes
    let removed = 0
    while (this.records.length > this.maxRecords || this.retainedBytes > this.maxBytes) {
      const record = this.records.shift()
      if (!record) break
      this.retainedBytes -= record.bytes
      this.dropped += 1
      removed += 1
    }
    if (removed === 0 || evidence.stage === 'gap') return
    const gap: DiagnosticsEvidence = {
      schemaVersion: diagnosticsEvidenceSchemaVersion,
      evidenceId: `evidence_${randomUUID()}`,
      observedAt: new Date().toISOString(),
      monotonicMs: Number((process.hrtime.bigint() - this.started) / 1_000_000n),
      sourceNode: 'router',
      stage: 'gap',
      transport: 'internal',
      direction: 'internal',
      outcome: 'dropped',
      detail: { reason: 'retention_eviction', droppedCount: removed },
    }
    const gapBytes = Buffer.byteLength(JSON.stringify(gap), 'utf8')
    this.records.push({ evidence: gap, bytes: gapBytes })
    this.retainedBytes += gapBytes
    while (this.records.length > this.maxRecords || this.retainedBytes > this.maxBytes) {
      const record = this.records.shift()
      if (!record) break
      this.retainedBytes -= record.bytes
      this.dropped += 1
    }
    for (const listener of this.listeners) {
      try { listener(gap) } catch { /* An observer must never affect Router delivery. */ }
    }
  }
}

export function redactDiagnosticsContent(value: unknown, key = '', depth = 0): unknown {
  if (depth >= 8) return '[truncated]'
  if (value == null || typeof value === 'boolean' || typeof value === 'number') return value
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return `[binary ${value.byteLength} bytes]`
  if (Array.isArray(value)) return value.slice(0, 80).map(item => redactDiagnosticsContent(item, key, depth + 1))
  if (typeof value === 'object') {
    const result: Record<string, unknown> = {}
    for (const [entryKey, entryValue] of Object.entries(value as Record<string, unknown>).slice(0, 80)) {
      result[entryKey] = diagnosticsSensitiveKey.test(entryKey)
        ? '[redacted]'
        : redactDiagnosticsContent(entryValue, entryKey, depth + 1)
    }
    return result
  }
  let text = String(value)
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer [redacted]')
    .replace(/([?&](?:token|secret|key|ticket|code)=)[^&#\s]+/gi, '$1[redacted]')
  if (diagnosticsPathKey.test(key) || /(?:[A-Za-z]:\\|file:\/\/\/|\/(?:Users|home|var|tmp)\/)/.test(text)) {
    return '[path redacted]'
  }
  if (text.length > 64 * 1024) text = `${text.slice(0, 64 * 1024)}[truncated]`
  return text
}

const diagnosticsSensitiveKey = /authorization|cookie|token|secret|password|credential|private.?key|pairing.?code|enrollment|ticket|bodybase64|attachment.?data|binary/i
const diagnosticsPathKey = /(?:^|_)(?:path|filepath|filename|cwd|directory|home)(?:$|_)/i

export function redactedEvidenceFingerprint(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

export function diagnosticsEnabledFromEnvironment(env = process.env): boolean {
  const requested = env.HERMES_HUB_DIAGNOSTICS === '1'
  const environment = (env.HERMES_HUB_ENVIRONMENT || env.NODE_ENV || 'production').toLowerCase()
  if (requested && environment === 'production') throw new Error('HERMES_HUB_DIAGNOSTICS is unavailable in production')
  return requested && (environment === 'development' || environment === 'staging')
}

export function observerTokenIsValid(presented: string | undefined, configuredHash: string): boolean {
  if (!presented || !configuredHash) return false
  const actual = createHash('sha256').update(presented).digest()
  const expected = Buffer.from(configuredHash, 'hex')
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}
