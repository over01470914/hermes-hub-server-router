import { Buffer } from 'node:buffer'
import type { ServerResponse } from 'node:http'

export interface BoundedSseWriterStats {
  blocked: boolean
  queuedBytes: number
  queuedItems: number
}

export interface BoundedSseWriterOptions {
  maxQueuedBytes: number
  maxQueuedItems: number
  drainTimeoutMs: number
  onFailure?: (error: DownstreamBackpressureError, stats: BoundedSseWriterStats) => void
}

interface QueuedWrite {
  bytes: number
  value: string
}

interface FlushWaiter {
  resolve: () => void
  reject: (error: Error) => void
}

export class DownstreamBackpressureError extends Error {
  constructor(message: string, readonly code: 'downstream_queue_overflow' | 'downstream_drain_timeout' | 'downstream_write_failed') {
    super(message)
    this.name = 'DownstreamBackpressureError'
  }
}

/**
 * Per-response SSE writer which stops writing after Node signals backpressure.
 * Gateway frames are kept in a small, bounded queue until `drain`; a stalled or
 * overflowing client fails only its own stream and cannot grow Router memory
 * without bound or block another session sharing the Gateway WebSocket.
 */
export class BoundedSseWriter {
  private readonly queue: QueuedWrite[] = []
  private readonly flushWaiters: FlushWaiter[] = []
  private blocked = false
  private closed = false
  private failure?: DownstreamBackpressureError
  private queuedBytes = 0
  private drainTimeout?: NodeJS.Timeout

  constructor(
    private readonly response: ServerResponse,
    private readonly options: BoundedSseWriterOptions,
  ) {
    if (!Number.isInteger(options.maxQueuedItems) || options.maxQueuedItems < 1) {
      throw new Error('maxQueuedItems must be a positive integer')
    }
    if (!Number.isInteger(options.maxQueuedBytes) || options.maxQueuedBytes < 1) {
      throw new Error('maxQueuedBytes must be a positive integer')
    }
    if (!Number.isInteger(options.drainTimeoutMs) || options.drainTimeoutMs < 1) {
      throw new Error('drainTimeoutMs must be a positive integer')
    }
    response.once('close', this.handleClose)
    response.once('error', this.handleResponseError)
  }

  get stats(): BoundedSseWriterStats {
    return {
      blocked: this.blocked,
      queuedBytes: this.queuedBytes,
      queuedItems: this.queue.length,
    }
  }

  write(value: string): boolean {
    if (this.closed || this.failure || this.response.destroyed || this.response.writableEnded) return false
    const bytes = Buffer.byteLength(value)
    if (bytes > this.options.maxQueuedBytes) {
      this.fail(new DownstreamBackpressureError(
        'Downstream SSE item exceeds the per-stream queue byte limit',
        'downstream_queue_overflow',
      ))
      return false
    }
    if (this.blocked || this.queue.length > 0) return this.enqueue({ bytes, value })
    return this.writeNow(value)
  }

  flush(): Promise<void> {
    if (this.failure) return Promise.reject(this.failure)
    if (this.closed || this.response.destroyed || this.response.writableEnded) {
      return Promise.reject(new Error('Downstream SSE response closed'))
    }
    if (!this.blocked && this.queue.length === 0) return Promise.resolve()
    return new Promise<void>((resolve, reject) => this.flushWaiters.push({ resolve, reject }))
  }

  dispose(): void {
    if (this.closed) return
    this.closed = true
    this.clearDrainWait()
    this.response.off('close', this.handleClose)
    this.response.off('error', this.handleResponseError)
    this.queue.length = 0
    this.queuedBytes = 0
    this.rejectFlushWaiters(new Error('Downstream SSE writer disposed'))
  }

  private enqueue(item: QueuedWrite): boolean {
    if (
      this.queue.length >= this.options.maxQueuedItems ||
      this.queuedBytes + item.bytes > this.options.maxQueuedBytes
    ) {
      this.fail(new DownstreamBackpressureError(
        'Downstream SSE queue exceeded its per-stream limit',
        'downstream_queue_overflow',
      ))
      return false
    }
    this.queue.push(item)
    this.queuedBytes += item.bytes
    return true
  }

  private writeNow(value: string): boolean {
    try {
      if (!this.response.write(value)) {
        this.blocked = true
        this.armDrainWait()
      }
      return true
    } catch (error) {
      this.fail(new DownstreamBackpressureError(
        error instanceof Error ? error.message : String(error),
        'downstream_write_failed',
      ))
      return false
    }
  }

  private readonly handleDrain = (): void => {
    if (this.closed || this.failure) return
    this.clearDrainWait()
    this.blocked = false
    while (this.queue.length > 0 && !this.blocked && !this.closed && !this.failure) {
      const item = this.queue.shift()
      if (!item) break
      this.queuedBytes -= item.bytes
      this.writeNow(item.value)
    }
    if (!this.blocked && this.queue.length === 0 && !this.failure) this.resolveFlushWaiters()
  }

  private readonly handleClose = (): void => {
    if (this.closed) return
    this.closed = true
    this.clearDrainWait()
    this.response.off('error', this.handleResponseError)
    this.queue.length = 0
    this.queuedBytes = 0
    this.rejectFlushWaiters(this.failure || new Error('Downstream SSE response closed'))
  }

  private readonly handleResponseError = (error: Error): void => {
    this.fail(new DownstreamBackpressureError(error.message, 'downstream_write_failed'))
  }

  private armDrainWait(): void {
    this.clearDrainWait()
    this.response.once('drain', this.handleDrain)
    this.drainTimeout = setTimeout(() => {
      this.fail(new DownstreamBackpressureError(
        'Downstream SSE response did not drain before the deadline',
        'downstream_drain_timeout',
      ))
    }, this.options.drainTimeoutMs)
    this.drainTimeout.unref?.()
  }

  private clearDrainWait(): void {
    if (this.drainTimeout) clearTimeout(this.drainTimeout)
    this.drainTimeout = undefined
    this.response.off('drain', this.handleDrain)
  }

  private fail(error: DownstreamBackpressureError): void {
    if (this.failure || this.closed) return
    this.failure = error
    const failureStats = this.stats
    this.blocked = false
    this.clearDrainWait()
    this.queue.length = 0
    this.queuedBytes = 0
    this.rejectFlushWaiters(error)
    this.options.onFailure?.(error, failureStats)
  }

  private resolveFlushWaiters(): void {
    for (const waiter of this.flushWaiters.splice(0)) waiter.resolve()
  }

  private rejectFlushWaiters(error: Error): void {
    for (const waiter of this.flushWaiters.splice(0)) waiter.reject(error)
  }
}
