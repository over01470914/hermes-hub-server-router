import { createHash } from 'node:crypto'

export interface SessionMessagePage {
  items: unknown[]
  hasMoreOlder: boolean
  nextOffset?: number
  loadedCount: number
  totalCount: number
  transcriptRevision: string
}

/**
 * Page one physical Hermes session from newest to oldest.
 *
 * Hermes' public session-messages endpoint returns a chronological transcript.
 * Hub cursors count rows already consumed from the newest edge, matching the
 * Desktop/Gateway display-history contract so Flutter can prepend each older
 * page without reversing either the page or the complete transcript.
 */
export function projectSessionMessagePage(
  sourceRows: unknown[],
  offset: number,
  limit: number,
  maxBytes: number,
): SessionMessagePage {
  const boundedOffset = Math.min(Math.max(0, offset), sourceRows.length)
  const pageEnd = sourceRows.length - boundedOffset
  let pageStart = pageEnd
  let pageBytes = 2
  while (pageStart > 0 && pageEnd - pageStart < limit) {
    const candidate = sourceRows[pageStart - 1]
    const candidateBytes = Buffer.byteLength(
      JSON.stringify(candidate) ?? 'null',
      'utf8',
    ) + 1
    if (pageStart < pageEnd && pageBytes + candidateBytes > maxBytes) break
    pageStart -= 1
    pageBytes += candidateBytes
  }
  const items = sourceRows.slice(pageStart, pageEnd)
  const loadedCount = boundedOffset + items.length
  const hasMoreOlder = pageStart > 0
  return {
    items,
    hasMoreOlder,
    nextOffset: hasMoreOlder ? loadedCount : undefined,
    loadedCount,
    totalCount: sourceRows.length,
    transcriptRevision: createHash('sha256')
      .update(JSON.stringify(sourceRows))
      .digest('hex'),
  }
}
