import type { NativeConversationRecord } from './nativeConversationStore.js'

type JsonRecord = Record<string, unknown>

function asRecord(value: unknown): JsonRecord | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : undefined
}

function sessionIdOf(session: JsonRecord): string {
  for (const key of ['id', 'session_id', 'sessionId']) {
    const value = session[key]
    if (typeof value === 'string' && value) return value
  }
  return ''
}

function firstString(record: JsonRecord | undefined, keys: string[]): string | undefined {
  if (!record) return undefined
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return undefined
}

function newestIsoTimestamp(...values: unknown[]): string | undefined {
  const timestamps = values
    .filter((value): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value)))
    .sort((left, right) => Date.parse(right) - Date.parse(left))
  return timestamps[0]
}

function activityUnixSeconds(...values: unknown[]): number | undefined {
  const timestamps = values.flatMap(value => {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return [Math.abs(value) >= 100_000_000_000 ? value / 1000 : value]
    }
    if (typeof value !== 'string' || !value.trim()) return []
    const trimmed = value.trim()
    const numeric = Number(trimmed)
    if (Number.isFinite(numeric)) {
      return [Math.abs(numeric) >= 100_000_000_000 ? numeric / 1000 : numeric]
    }
    const milliseconds = Date.parse(trimmed)
    return Number.isFinite(milliseconds) ? [milliseconds / 1000] : []
  })
  if (timestamps.length === 0) return undefined
  return Math.floor(Math.max(...timestamps))
}

function detailSessionPayload(payload: unknown): {
  record: JsonRecord
  session: JsonRecord
} | undefined {
  const record = asRecord(payload)
  if (!record) return undefined
  const session = asRecord(record.session) || asRecord(record.data) || record
  return { record, session }
}

/**
 * Applies the same public identity policy to a selected session as the list
 * projection.  In particular, a raw Hermes row must remain read-only until it
 * is backed by a Router-owned native conversation.
 */
export function projectNativeSessionDetailPayload(
  payload: unknown,
  nativeConversation?: NativeConversationRecord,
): unknown {
  const detail = detailSessionPayload(payload)
  if (!detail) return payload

  const session = nativeConversation
    ? {
        ...detail.session,
        id: nativeConversation.conversationId,
        session_id: nativeConversation.conversationId,
        conversation_id: nativeConversation.conversationId,
        hermes_session_id: nativeConversation.sessionId,
        native: true,
        readOnly: false,
        read_only: false,
      }
    : {
        ...detail.session,
        native: false,
        readOnly: true,
        read_only: true,
      }

  return { ...detail.record, session }
}

export function projectNativeSessionListPayload(
  payload: unknown,
  nativeConversations: NativeConversationRecord[],
): unknown {
  const record = asRecord(payload)
  if (!record) return payload

  const sourceRows = Array.isArray(record.sessions)
    ? record.sessions
    : Array.isArray(record.data)
      ? record.data
      : []
  const upstreamBySessionId = new Map<string, JsonRecord>()
  for (const value of sourceRows) {
    const session = asRecord(value)
    if (!session) continue
    const sessionId = sessionIdOf(session)
    if (sessionId) upstreamBySessionId.set(sessionId, session)
  }

  const conversationBySessionId = new Map<string, NativeConversationRecord>()
  for (const conversation of nativeConversations) {
    for (const sessionId of [
      ...(conversation.sessionId ? [conversation.sessionId] : []),
      ...(conversation.lineageSessionIds || []),
    ]) conversationBySessionId.set(sessionId, conversation)
  }
  const topologyByConversationId = new Map<string, JsonRecord>()
  const childCountByConversationId = new Map<string, number>()
  for (const conversation of nativeConversations) {
    const rootRow = conversation.lineageRootSessionId
      ? upstreamBySessionId.get(conversation.lineageRootSessionId)
      : undefined
    const tipRow = conversation.sessionId
      ? upstreamBySessionId.get(conversation.sessionId)
      : undefined
    const representative = rootRow
      || (conversation.lineageSessionIds || []).flatMap(sessionId => {
        const row = upstreamBySessionId.get(sessionId)
        return row ? [row] : []
      })[0]
      || tipRow
    const parentSessionId = firstString(representative, ['parent_session_id', 'parentSessionId'])
    const parentConversation = parentSessionId
      ? conversationBySessionId.get(parentSessionId)
      : undefined
    if (!parentConversation || parentConversation.conversationId === conversation.conversationId) continue
    const relation = firstString(representative, ['session_source', 'sessionSource'])?.toLowerCase() === 'fork'
      ? 'fork'
      : 'branch'
    topologyByConversationId.set(conversation.conversationId, {
      relation,
      parentConversationId: parentConversation.conversationId,
    })
    childCountByConversationId.set(
      parentConversation.conversationId,
      (childCountByConversationId.get(parentConversation.conversationId) || 0) + 1,
    )
  }

  const nativeSessionIds = new Set(
    nativeConversations.flatMap(conversation => [
      ...(conversation.sessionId ? [conversation.sessionId] : []),
      ...(conversation.lineageSessionIds || []),
    ]),
  )
  const nativeRows = nativeConversations.flatMap(conversation => {
    if (!conversation.sessionId) return []
    const tip = upstreamBySessionId.get(conversation.sessionId)
    const root = conversation.lineageRootSessionId
      ? upstreamBySessionId.get(conversation.lineageRootSessionId)
      : undefined
    const upstream = tip
      || root
      || (conversation.lineageSessionIds || []).flatMap(sessionId => {
        const row = upstreamBySessionId.get(sessionId)
        return row ? [row] : []
      })[0]
    if (!upstream) return []
    const tipSource = typeof tip?.source === 'string' ? tip.source.toLowerCase() : ''
    const visibleTitle = tipSource === 'tui'
      ? tip?.title || root?.title || upstream.title
      : root?.title || upstream.title || tip?.title
    const visibleSource = root?.source || upstream.source || tip?.source || 'hermes_hub_gateway'
    const createdAt = root?.created_at
      || root?.started_at
      || upstream.created_at
      || upstream.started_at
      || conversation.createdAt
    const updatedAt = newestIsoTimestamp(tip?.updated_at, upstream.updated_at)
      || (typeof tip?.updated_at === 'string' ? tip.updated_at : undefined)
      || conversation.createdAt
    return [{
      ...(root || {}),
      ...upstream,
      ...(tip || {}),
      id: conversation.conversationId,
      session_id: conversation.conversationId,
      conversation_id: conversation.conversationId,
      hermes_session_id: conversation.sessionId,
      source: visibleSource,
      native: true,
      readOnly: false,
      read_only: false,
      created_at: createdAt,
      // `conversation.updatedAt` records Router-owned mapping activity (for
      // example, discovering a session while serving this list).  It is not a
      // transcript activity timestamp and must never become `last_active`.
      updated_at: updatedAt,
      last_active: activityUnixSeconds(
        tip?.last_active,
        upstream.last_active,
      ),
      title: visibleTitle || 'New conversation',
      topology: {
        ...(topologyByConversationId.get(conversation.conversationId) || { relation: 'root' }),
        childCount: childCountByConversationId.get(conversation.conversationId) || 0,
      },
    }]
  })
  const legacyRows = sourceRows.flatMap(value => {
    const session = asRecord(value)
    if (!session) return [value]
    const sessionId = sessionIdOf(session)
    if (sessionId && nativeSessionIds.has(sessionId)) return []
    return [{ ...session, native: false, readOnly: true, read_only: true }]
  })
  const sessions = [...nativeRows, ...legacyRows]
  return { ...record, sessions, data: sessions }
}
