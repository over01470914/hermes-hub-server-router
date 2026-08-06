export interface NativeSessionLineage {
  rootSessionId: string
  tipSessionId: string
  pathSessionIds: string[]
  allSessionIds: string[]
}

type JsonRecord = Record<string, unknown>

interface SessionRow {
  id: string
  parentId?: string
  rootHint?: string
  tipHint?: string
  source?: string
  profile?: string
  sessionSource?: string
  endReason?: string
  startedAt?: number
  endedAt?: number
  activityAt: number
  importable: boolean
}

const sessionIdPattern = /^[A-Za-z0-9._:-]{3,200}$/

function asRecord(value: unknown): JsonRecord | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : undefined
}

function firstString(record: JsonRecord, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return undefined
}

function timestamp(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.abs(value) >= 100_000_000_000 ? value / 1000 : value
  }
  if (typeof value !== 'string' || !value.trim()) return undefined
  const numeric = Number(value)
  if (Number.isFinite(numeric)) {
    return Math.abs(numeric) >= 100_000_000_000 ? numeric / 1000 : numeric
  }
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed / 1000 : undefined
}

function sessionRows(payload: unknown): SessionRow[] {
  const record = asRecord(payload)
  if (!record) return []
  const values = Array.isArray(record.sessions)
    ? record.sessions
    : Array.isArray(record.data)
      ? record.data
      : []
  const rows: SessionRow[] = []
  for (const value of values) {
    const row = asRecord(value)
    if (!row) continue
    const id = firstString(row, ['id', 'session_id', 'sessionId'])
    if (!id || !sessionIdPattern.test(id)) continue
    const messageCount = row.actual_message_count ?? row.message_count ?? row.messageCount
    const numericMessageCount = typeof messageCount === 'number' && Number.isFinite(messageCount)
      ? messageCount
      : undefined
    const startedAt = timestamp(row.started_at ?? row.created_at ?? row.startedAt ?? row.createdAt)
    const endedAt = timestamp(row.ended_at ?? row.endedAt)
    const activityAt = timestamp(
      row.last_activity ?? row.last_active ?? row.updated_at ?? row.lastActivity ?? row.lastActive ?? row.updatedAt,
    ) ?? startedAt ?? 0
    rows.push({
      id,
      parentId: firstString(row, ['parent_session_id', 'parentSessionId']),
      rootHint: firstString(row, ['_lineage_root_id', 'lineage_root_id', 'lineageRootId']),
      tipHint: firstString(row, ['_lineage_tip_id', 'lineage_tip_id', 'lineageTipId']),
      source: firstString(row, ['source']),
      profile: firstString(row, ['profile_name', 'profile']),
      sessionSource: firstString(row, ['session_source', 'sessionSource']),
      endReason: firstString(row, ['end_reason', 'endReason']),
      startedAt,
      endedAt,
      activityAt,
      importable: numericMessageCount === undefined || numericMessageCount > 0,
    })
  }
  return rows
}

function isContinuation(parent: SessionRow | undefined, child: SessionRow): boolean {
  if (!parent || child.parentId !== parent.id) return false
  if ((child.sessionSource || '').toLowerCase() === 'fork') return false
  if (parent.source && child.source && parent.source.toLowerCase() !== child.source.toLowerCase()) return false
  if (parent.profile && child.profile && parent.profile.toLowerCase() !== child.profile.toLowerCase()) return false
  if (!['compression', 'cli_close'].includes((parent.endReason || '').toLowerCase())) return false
  if (
    parent.endedAt !== undefined
    && child.startedAt !== undefined
    && child.startedAt < parent.endedAt
  ) return false
  return true
}

function uniqueIds(values: Iterable<string | undefined>): string[] {
  return [...new Set([...values].filter((value): value is string => (
    Boolean(value) && sessionIdPattern.test(value as string)
  )))]
}

function betterTip(
  candidate: { row: SessionRow; path: string[] },
  current: { row: SessionRow; path: string[] },
): boolean {
  if (candidate.row.importable !== current.row.importable) return candidate.row.importable
  if (candidate.row.activityAt !== current.row.activityAt) {
    return candidate.row.activityAt > current.row.activityAt
  }
  return candidate.path.length > current.path.length
}

/**
 * Project raw Hermes SessionDB rows into logical continuation lineages.
 *
 * Compression and CLI-close children continue one conversation. Explicit
 * forks, cross-source children, cross-profile children, and children created
 * before the parent's end boundary remain independent conversations.
 */
export function nativeSessionLineagesFromPayload(payload: unknown): NativeSessionLineage[] {
  const rows = sessionRows(payload)
  const rowsById = new Map(rows.map(row => [row.id, row]))
  const continuationChildren = new Map<string, SessionRow[]>()
  const continuationChildIds = new Set<string>()
  for (const child of rows) {
    if (!child.parentId) continue
    const parent = rowsById.get(child.parentId)
    if (!isContinuation(parent, child)) continue
    const children = continuationChildren.get(parent!.id) || []
    children.push(child)
    continuationChildren.set(parent!.id, children)
    continuationChildIds.add(child.id)
  }

  const lineages = new Map<string, NativeSessionLineage>()
  for (const root of rows.filter(row => !continuationChildIds.has(row.id))) {
    let best = { row: root, path: [root.id] }
    const allIds: string[] = []
    const stack: Array<{ row: SessionRow; path: string[] }> = [{ row: root, path: [root.id] }]
    const seen = new Set<string>()
    while (stack.length > 0) {
      const current = stack.pop()!
      if (seen.has(current.row.id)) continue
      seen.add(current.row.id)
      allIds.push(current.row.id)
      if (betterTip(current, best)) best = current
      for (const child of continuationChildren.get(current.row.id) || []) {
        stack.push({ row: child, path: [...current.path, child.id] })
      }
    }
    lineages.set(root.id, {
      rootSessionId: root.id,
      tipSessionId: best.row.id,
      pathSessionIds: best.path,
      allSessionIds: uniqueIds(allIds),
    })
  }

  // Some Hermes list endpoints already collapse a chain and expose only its
  // root/tip hints. Preserve those hints so an older Router mapping to the root
  // can still migrate even when intermediate rows are omitted from the page.
  for (const row of rows) {
    if (!row.rootHint) continue
    const hintedRowLineage = row.rootHint === row.id
      ? undefined
      : lineages.get(row.id)
    const existing = lineages.get(row.rootHint)
    const tipSessionId = row.tipHint || row.id
    const mergedIds = uniqueIds([
      ...(existing?.allSessionIds || []),
      ...(hintedRowLineage?.allSessionIds || []),
      row.rootHint,
      row.id,
      tipSessionId,
    ])
    lineages.set(row.rootHint, {
      rootSessionId: row.rootHint,
      tipSessionId,
      pathSessionIds: uniqueIds([
        row.rootHint,
        ...(existing?.pathSessionIds || []),
        ...(hintedRowLineage?.pathSessionIds || []),
        tipSessionId,
      ]),
      allSessionIds: mergedIds,
    })
    // A projected upstream row uses the continuation tip as its public row id
    // while carrying the original root in `_lineage_root_id`.  The first pass
    // necessarily sees that row as a singleton because the hidden ancestors
    // are not present.  Remove that synthetic singleton after folding it into
    // the hinted lineage or the Router would create a duplicate conversation.
    if (row.rootHint !== row.id) lineages.delete(row.id)
  }

  return [...lineages.values()]
}
