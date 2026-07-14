export const maxDiagnosticsEntries = 500
export const maxDiagnosticsReportBytes = 512 * 1024

const maxDiagnosticMessageLength = 512
const maxDiagnosticValueLength = 256
const maxDiagnosticCollectionItems = 40
const maxDiagnosticDepth = 4

const allowedMetadataKeys = new Set([
  'appVersion',
  'buildFlavor',
  'routerUrl',
  'hermesAgentId',
  'gatewayId',
  'activeSessionId',
  'platform',
  'timestamp'
])

const sensitiveKeyPattern = /(^|[_-])(authorization|cookie|password|secret|token|approval|pairing(?:code)?|api[_-]?key|private[_-]?key|body(?:base64)?|content|prompt|output|transcript|comment|attachment)([_-]|$)/i
const unsafeObjectKeys = new Set(['__proto__', 'constructor', 'prototype'])

export interface SafeDiagnosticsEntry {
  level: 'debug' | 'info' | 'warning' | 'error'
  category: string
  message: string
  timestamp: string
  data?: Record<string, unknown>
}

export interface SafeDiagnosticsReceipt {
  metadata: Record<string, unknown>
  entries: SafeDiagnosticsEntry[]
}

export interface DiagnosticsReceiptSummary {
  entryCount: number
  levels: Record<string, number>
  categories: string[]
  metadataKeys: string[]
  receiptBytes: number
}

export class DiagnosticsPayloadError extends Error {
  constructor(
    readonly code: 'diagnostics_invalid' | 'diagnostics_too_large',
    message: string,
    readonly statusCode: 400 | 413
  ) {
    super(message)
    this.name = 'DiagnosticsPayloadError'
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}...`
}

function isSensitiveKey(key: string): boolean {
  const normalized = key.replace(/([a-z0-9])([A-Z])/g, '$1_$2')
  return sensitiveKeyPattern.test(normalized)
}

export function redactDiagnosticText(value: string, maxLength = maxDiagnosticValueLength): string {
  const redacted = value
    .replace(
      /(Authorization\s*[:=]\s*)[^\r\n,;]+/gi,
      '$1[redacted]'
    )
    .replace(/(https?:\/\/)[^/\s:@]+:[^@/\s]+@/gi, '$1[redacted]@')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/\b(?:sk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{12,}\b/gi, '[redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}(?:\.[A-Za-z0-9_-]{10,})?\b/g, '[redacted]')
    .replace(
      /([?&](?:access[_-]?token|token|secret|password|api[_-]?key|code)=)[^&#\s]*/gi,
      '$1[redacted]'
    )
    .replace(
      /((?:access[_-]?token|token|secret|password|api[_-]?key|pairing[_-]?code)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi,
      '$1[redacted]'
    )
    .replace(/\b\d{8}\b/g, '[redacted]')

  return truncate(redacted, maxLength)
}

function sanitizeValue(value: unknown, key: string, depth: number): unknown {
  if (isSensitiveKey(key)) return '[redacted]'
  if (value == null || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string') return redactDiagnosticText(value)
  if (depth >= maxDiagnosticDepth) return '[truncated]'
  if (Array.isArray(value)) {
    return value
      .slice(0, maxDiagnosticCollectionItems)
      .map(item => sanitizeValue(item, '', depth + 1))
      .filter(item => item !== undefined)
  }

  const record = asRecord(value)
  if (!record) return undefined
  return sanitizeRecord(record, depth + 1)
}

function sanitizeRecord(
  input: Record<string, unknown>,
  depth = 0
): Record<string, unknown> {
  const output: Record<string, unknown> = {}
  for (const [rawKey, value] of Object.entries(input).slice(0, maxDiagnosticCollectionItems)) {
    if (unsafeObjectKeys.has(rawKey)) continue
    const key = redactDiagnosticText(rawKey, 80)
    const safeValue = sanitizeValue(value, rawKey, depth)
    if (safeValue !== undefined) output[key] = safeValue
  }
  return output
}

function normalizeLevel(value: unknown): SafeDiagnosticsEntry['level'] {
  if (value === 'debug' || value === 'warning' || value === 'error') return value
  if (value === 'warn') return 'warning'
  return 'info'
}

function normalizeEntry(value: unknown, index: number): SafeDiagnosticsEntry {
  const input = asRecord(value)
  if (!input) {
    throw new DiagnosticsPayloadError(
      'diagnostics_invalid',
      `Diagnostics entry ${index} must be an object`,
      400
    )
  }

  const rawMessage = typeof input.message === 'string' ? input.message.trim() : ''
  if (!rawMessage) {
    throw new DiagnosticsPayloadError(
      'diagnostics_invalid',
      `Diagnostics entry ${index} requires a message`,
      400
    )
  }

  const category = typeof input.category === 'string' && input.category.trim()
    ? input.category.trim()
    : 'app'
  const timestamp = typeof input.timestamp === 'string' && input.timestamp.trim()
    ? input.timestamp.trim()
    : 'unknown'
  const data = asRecord(input.data)
  const safeData = data ? sanitizeRecord(data) : undefined
  const safeCategory = redactDiagnosticText(category, 80)

  return {
    level: normalizeLevel(input.level),
    category: /^[A-Za-z0-9._:-]{1,80}$/.test(safeCategory) ? safeCategory : 'other',
    message: redactDiagnosticText(rawMessage, maxDiagnosticMessageLength),
    timestamp: redactDiagnosticText(timestamp, 80),
    ...(safeData && Object.keys(safeData).length > 0 ? { data: safeData } : {})
  }
}

function normalizeMetadata(value: unknown): Record<string, unknown> {
  const input = asRecord(value)
  if (!input) return {}
  const output: Record<string, unknown> = {}
  for (const key of allowedMetadataKeys) {
    if (!(key in input)) continue
    const safeValue = sanitizeValue(input[key], key, 0)
    if (safeValue !== undefined) output[key] = safeValue
  }
  return output
}

export function normalizeDiagnosticsReceipt(inputValue: unknown): SafeDiagnosticsReceipt {
  const input = asRecord(inputValue)
  if (!input || !Array.isArray(input.entries)) {
    throw new DiagnosticsPayloadError(
      'diagnostics_invalid',
      'Diagnostics entries must be an array',
      400
    )
  }
  if (input.entries.length === 0) {
    throw new DiagnosticsPayloadError(
      'diagnostics_invalid',
      'Diagnostics entries must not be empty',
      400
    )
  }
  if (input.entries.length > maxDiagnosticsEntries) {
    throw new DiagnosticsPayloadError(
      'diagnostics_too_large',
      `Diagnostics entries exceed the ${maxDiagnosticsEntries} entry limit`,
      413
    )
  }

  const receipt: SafeDiagnosticsReceipt = {
    metadata: normalizeMetadata(input.metadata),
    entries: input.entries.map(normalizeEntry)
  }
  const receiptBytes = Buffer.byteLength(JSON.stringify(receipt), 'utf8')
  if (receiptBytes > maxDiagnosticsReportBytes) {
    throw new DiagnosticsPayloadError(
      'diagnostics_too_large',
      'Diagnostics report exceeds the 512 KiB limit',
      413
    )
  }
  return receipt
}

export function summarizeDiagnosticsReceipt(
  receipt: SafeDiagnosticsReceipt
): DiagnosticsReceiptSummary {
  const levels: Record<string, number> = {}
  const categories = new Set<string>()
  for (const entry of receipt.entries) {
    levels[entry.level] = (levels[entry.level] || 0) + 1
    categories.add(entry.category)
  }
  return {
    entryCount: receipt.entries.length,
    levels,
    categories: [...categories].sort().slice(0, maxDiagnosticCollectionItems),
    metadataKeys: Object.keys(receipt.metadata).sort(),
    receiptBytes: Buffer.byteLength(JSON.stringify(receipt), 'utf8')
  }
}
