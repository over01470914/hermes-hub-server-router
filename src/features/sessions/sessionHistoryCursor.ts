const maxHistoryOffset = 10_000_000
const transcriptRevisionPattern = /^[a-f0-9]{64}$/

export interface SessionHistoryCursor {
  offset: number
  snapshotRevision?: string
}

function validOffset(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= maxHistoryOffset
}

export function isSessionHistoryRevision(value: string): boolean {
  return transcriptRevisionPattern.test(value)
}

export function decodeSessionHistoryCursor(value: string): SessionHistoryCursor {
  const decoded = Buffer.from(value, 'base64url').toString('utf8')
  if (/^\d{1,10}$/.test(decoded)) {
    const offset = Number(decoded)
    if (!validOffset(offset)) throw new Error('invalid history cursor offset')
    return { offset }
  }

  const parsed = JSON.parse(decoded) as Record<string, unknown>
  const offset = parsed.offset
  const snapshotRevision = parsed.snapshotRevision
  if (!validOffset(offset)) throw new Error('invalid history cursor offset')
  if (typeof snapshotRevision !== 'string' || !isSessionHistoryRevision(snapshotRevision)) {
    throw new Error('invalid history cursor revision')
  }
  return { offset, snapshotRevision }
}

export function encodeSessionHistoryCursor(
  offset: number,
  snapshotRevision?: string,
): string {
  if (!validOffset(offset)) throw new Error('invalid history cursor offset')
  if (snapshotRevision !== undefined && !isSessionHistoryRevision(snapshotRevision)) {
    throw new Error('invalid history cursor revision')
  }
  const payload = snapshotRevision === undefined
    ? String(offset)
    : JSON.stringify({ offset, snapshotRevision })
  return Buffer.from(payload, 'utf8').toString('base64url')
}
