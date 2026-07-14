export type RouterLogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface RouterLogContext {
  [key: string]: unknown
}

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
  return /(^|_|-)(authorization|cookie|password|secret|token|approval|pairingcode|code)$/i.test(key)
}

function cleanValue(key: string, value: unknown): unknown {
  if (value === undefined) return undefined
  if (shouldRedact(key)) return '[redacted]'
  if (value instanceof Error) return value.message
  if (Array.isArray(value)) return value.map((item, index) => cleanValue(String(index), item))
  if (value && typeof value === 'object') {
    const output: RouterLogContext = {}
    for (const [childKey, childValue] of Object.entries(value as RouterLogContext)) {
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
    const cleaned = cleanValue(key, value)
    if (cleaned !== undefined) output[key] = cleaned
  }
  return output
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function logRouter(level: RouterLogLevel, message: string, context: RouterLogContext = {}, error?: unknown): void {
  if (!shouldLog(level)) return
  const record: RouterLogContext = {
    timestamp: new Date().toISOString(),
    level,
    service: 'hermes-hub-router',
    message,
    ...cleanContext(context)
  }
  if (error !== undefined) {
    record.error = errorMessage(error)
    if (level === 'error' && process.env.HERMES_HUB_LOG_STACKS === '1' && error instanceof Error && error.stack) {
      record.stack = error.stack
    }
  }
  const line = JSON.stringify(record)
  if (level === 'error') console.error(line)
  else if (level === 'warn') console.warn(line)
  else if (level === 'debug') console.debug(line)
  else console.info(line)
}
