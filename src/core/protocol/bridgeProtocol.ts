import { randomUUID } from 'node:crypto'

export type RpcStreamEvent = string

export interface GatewayRequestMetrics {
  requestId: string
  routerQueuedMs?: number
  gatewayDispatchMs?: number
  upstreamHermesLatencyMs?: number
  totalLatencyMs?: number
  streamedEventCount?: number
  forwardedContentFrames?: number
  replayedEventCount?: number
  bufferedReplay?: boolean
  upstreamContentType?: string
  upstreamResponseBytes?: number
  bodyBase64Bytes?: number
  firstUpstreamFrameMs?: number
  firstForwardedFrameMs?: number
  firstContentFrameMs?: number
  timeoutReason?: string
  disconnectReason?: string
  via?: 'hermes-hub-gateway'
}

export interface RpcStreamRequest {
  type: 'rpc_stream_request'
  id: string
  method: string
  path: string
  headers?: Record<string, string>
  bodyBase64?: string
}

export interface RpcStreamCancel {
  type: 'rpc_stream_cancel'
  id: string
  reason?: 'client_disconnected' | 'router_timeout'
}

export interface RpcStreamChunk {
  type: 'rpc_stream_chunk'
  id: string
  event: RpcStreamEvent
  data?: unknown
  text?: string
  sentAt?: number
  metrics?: Partial<GatewayRequestMetrics>
}

export interface RpcStreamEnd {
  type: 'rpc_stream_end'
  id: string
  status: number
  headers?: Record<string, string>
  bodyBase64?: string
  sentAt?: number
  metrics?: Partial<GatewayRequestMetrics>
}

export interface RpcStreamError {
  type: 'rpc_stream_error'
  id: string
  error: string
  code?: string
  sentAt?: number
  metrics?: Partial<GatewayRequestMetrics>
}

export type RpcStreamFrame = RpcStreamChunk | RpcStreamEnd | RpcStreamError

export interface BootstrapQuery {
  limit: number
  activeSessionId?: string
}

export function requestId(prefix = 'req'): string {
  return `${prefix}_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`
}

export function nowMs(): number {
  return Date.now()
}

export function elapsedMs(startedAt: number): number {
  return Math.max(0, Date.now() - startedAt)
}

export function sseHeaders(): Record<string, string> {
  return {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no'
  }
}

export function encodeSseEvent(event: string, data: unknown, id?: string): string {
  const lines = id ? [`id: ${id}`] : []
  lines.push(`event: ${event}`)
  const payload = JSON.stringify(data)
  for (const line of payload.split('\n')) lines.push(`data: ${line}`)
  lines.push('', '')
  return lines.join('\n')
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

export function cleanHeaders(value: unknown): Record<string, string> {
  const input = asRecord(value)
  if (!input) return {}
  const output: Record<string, string> = {}
  for (const [key, raw] of Object.entries(input)) {
    if (typeof raw !== 'string') continue
    output[key.toLowerCase()] = raw
  }
  return output
}

export function cleanStreamFrame(value: unknown): RpcStreamFrame {
  const input = asRecord(value)
  if (!input || typeof input.type !== 'string' || typeof input.id !== 'string') throw new Error('Gateway stream frame must include type and id')
  const sentAt = typeof input.sentAt === 'number' && Number.isFinite(input.sentAt) ? input.sentAt : undefined
  const metrics = asRecord(input.metrics) as Partial<GatewayRequestMetrics> | null
  if (input.type === 'rpc_stream_chunk') {
    const event = typeof input.event === 'string' && input.event.trim() ? input.event.trim() : 'status'
    return {
      type: 'rpc_stream_chunk',
      id: input.id,
      event,
      data: input.data,
      text: typeof input.text === 'string' ? input.text : undefined,
      sentAt,
      metrics: metrics || undefined
    }
  }
  if (input.type === 'rpc_stream_end') {
    const status = typeof input.status === 'number' && input.status >= 100 && input.status <= 599 ? input.status : 502
    return {
      type: 'rpc_stream_end',
      id: input.id,
      status,
      headers: cleanHeaders(input.headers),
      bodyBase64: typeof input.bodyBase64 === 'string' ? input.bodyBase64 : '',
      sentAt,
      metrics: metrics || undefined
    }
  }
  if (input.type === 'rpc_stream_error') {
    return {
      type: 'rpc_stream_error',
      id: input.id,
      error: typeof input.error === 'string' && input.error.trim() ? input.error : 'Gateway stream failed',
      code: typeof input.code === 'string' ? input.code : undefined,
      sentAt,
      metrics: metrics || undefined
    }
  }
  throw new Error(`Unsupported gateway stream frame: ${input.type}`)
}

export function normalizeBootstrapQuery(url: URL): BootstrapQuery {
  const limitValue = Number(url.searchParams.get('limit') || 50)
  const limit = Number.isFinite(limitValue) ? Math.min(200, Math.max(1, Math.floor(limitValue))) : 50
  const activeSessionId = url.searchParams.get('activeSessionId') || undefined
  return { limit, activeSessionId }
}

export function parseJsonBuffer(body: Buffer): unknown | null {
  if (!body.length) return null
  try {
    return JSON.parse(body.toString('utf8')) as unknown
  } catch {
    return null
  }
}
