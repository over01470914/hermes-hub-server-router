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

  const nativeSessionIds = new Set(
    nativeConversations.flatMap(conversation => conversation.sessionId ? [conversation.sessionId] : []),
  )
  const nativeRows = nativeConversations.map(conversation => {
    const upstream = conversation.sessionId
      ? upstreamBySessionId.get(conversation.sessionId)
      : undefined
    return {
      ...(upstream || {}),
      id: conversation.conversationId,
      session_id: conversation.conversationId,
      conversation_id: conversation.conversationId,
      hermes_session_id: conversation.sessionId,
      source: upstream?.source || 'hermes_hub_gateway',
      native: true,
      readOnly: false,
      read_only: false,
      created_at: upstream?.created_at || conversation.createdAt,
      updated_at: newestIsoTimestamp(upstream?.updated_at, conversation.updatedAt) || conversation.updatedAt,
      last_active: activityUnixSeconds(
        upstream?.last_active,
        upstream?.updated_at,
        conversation.updatedAt,
      ),
      title: upstream?.title || 'New conversation',
    }
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
