export type RouterLogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface RouterLogContext {
  [key: string]: unknown
}

type RouterLogArguments =
  | [context?: RouterLogContext, error?: unknown]
  | [message: string, context?: RouterLogContext, error?: unknown]

const levelRank: Record<RouterLogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
}

const configuredLevel = (
  process.env.HERMES_HUB_LOG_LEVEL || 'info'
).toLowerCase() as RouterLogLevel

const minimumLevel = levelRank[configuredLevel] === undefined ? 'info' : configuredLevel

function shouldLog(level: RouterLogLevel): boolean {
  return levelRank[level] >= levelRank[minimumLevel]
}

function shouldRedact(key: string): boolean {
  const normalized = key.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase()
  if (/(^|_|-)(authorization|cookie|password|secret|token|approval|pairingcode|pairing_code)(_|-|$)/.test(normalized)) return true
  if (normalized !== 'error_code' && /(^|_)(error|reason)$/.test(normalized)) return true
  // Preserve safe bounded metadata such as messageCount, responseStatus,
  // promptId, responseBytes, and attachmentCount. Only redact fields that
  // can contain user or upstream content.
  if (/(_count|_bytes|_status|_id|_ids|_type)$/.test(normalized)) return false
  return /^(message|text|prompt|response|body|headers|attachment|content|payload|data)(_.*)?$/.test(normalized) ||
    /(_body|_headers|_content|_payload|_data|_text|_message|_prompt|_response)$/.test(normalized)
}

function cleanValue(key: string, value: unknown): unknown {
  if (value === undefined) return undefined
  if (shouldRedact(key)) return '[redacted]'
  if (value instanceof Error) return errorCode(value)
  if (typeof value === 'string') {
    if (/(?:bearer\s+|https?:\/\/|wss?:\/\/|[?&](?:token|secret|key)=)/i.test(value)) {
      return '[redacted]'
    }
    return value.length <= 512 ? value : `${value.slice(0, 509)}...`
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value === 'boolean' || value === null) return value
  if (Array.isArray(value)) return value.slice(0, 32).map((item, index) => cleanValue(String(index), item))
  if (value && typeof value === 'object') {
    const output: RouterLogContext = {}
    for (const [childKey, childValue] of Object.entries(value as RouterLogContext).slice(0, 32)) {
      const cleaned = cleanValue(childKey, childValue)
      if (cleaned !== undefined) output[childKey] = cleaned
    }
    return output
  }
  return value
}

function cleanContext(context: RouterLogContext = {}): RouterLogContext {
  const output: RouterLogContext = {}
  for (const [key, value] of Object.entries(context)) {
    if (key === 'timestamp' || key === 'level' || key === 'service' || key === 'event' || key === 'message') continue
    const cleaned = cleanValue(key, value)
    if (cleaned !== undefined) output[key] = cleaned
  }
  // Keep legacy call sites safe while the story contract converges. New call
  // sites emit the canonical names directly; legacy aliases never appear in
  // persisted records.
  if (output.durationMs === undefined && typeof output.latencyMs === 'number') {
    output.durationMs = output.latencyMs
  }
  delete output.latencyMs
  if (output.connectionId === undefined && typeof output.gatewayConnectionId === 'string') {
    output.connectionId = output.gatewayConnectionId
  }
  delete output.gatewayConnectionId
  if (output.errorCode === undefined && typeof output.code === 'string') {
    output.errorCode = output.code
  }
  delete output.code
  return output
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** A safe category for logs; do not use this as public response copy. */
export function errorCode(error: unknown): string {
  return boundedErrorCode(error)
}

function eventName(value: string): string {
  const normalized = value
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, '$1.$2')
    .replace(/[^A-Za-z0-9_]+/g, '.')
    .replace(/^\.+|\.+$/g, '')
    .toLowerCase()
  return normalized || 'router.log'
}

function boundedErrorCode(error: unknown): string {
  const code = error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : undefined
  return code && /^[a-z][a-z0-9_.-]{0,119}$/i.test(code) ? code : 'router_error'
}

/**
 * Emits one redacted JSON record per observed Router boundary.
 *
 * The three-argument form remains for older call sites and derives a stable
 * dotted event name from their message. New story call sites should use the
 * four-argument form: `event`, short factual `message`, then context.
 */
export function logRouter(
  level: RouterLogLevel,
  event: string,
  ...args: RouterLogArguments
): void {
  if (!shouldLog(level)) return
  let message = event
  let context: RouterLogContext = {}
  let error: unknown
  if (typeof args[0] === 'string') {
    message = args[0]
    context = (args[1] as RouterLogContext | undefined) || (Object.create(null) as RouterLogContext)
    error = args[2]
  } else {
    context = args[0] || (Object.create(null) as RouterLogContext)
    error = args[1]
  }
  const cleanedContext = cleanContext(context)
  const record: RouterLogContext = {
    ...cleanedContext,
    timestamp: new Date().toISOString(),
    level,
    service: 'hermes-hub-router',
    message,
    event: eventName(event),
  }
  if (error !== undefined) {
    // Errors regularly contain upstream bodies, headers, or user input. Keep
    // only a bounded category even when a caller accidentally passes one.
    record.errorCode = record.errorCode || boundedErrorCode(error)
  }
  const line = JSON.stringify(record)
  if (level === 'error') console.error(line)
  else if (level === 'warn') console.warn(line)
  else if (level === 'debug') console.debug(line)
  else console.info(line)
}
