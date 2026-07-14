import type { RpcStreamFrame } from '../../core/protocol/bridgeProtocol.js'

export interface PendingRealtimeFrameBufferStats {
  retainedFrames: number
  retainedBytes: number
  droppedFrames: number
  droppedBytes: number
  hasTerminal: boolean
}

interface PendingFrameEntry {
  frame: RpcStreamFrame
  bytes: number
  terminal: boolean
}

export class PendingRealtimeFrameBuffer {
  constructor(
    private readonly maxFrames = 256,
    private readonly maxBytes = 1024 * 1024
  ) {
    if (!Number.isSafeInteger(maxFrames) || maxFrames < 1) {
      throw new Error('Pending realtime frame maxFrames must be a positive integer')
    }
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
      throw new Error('Pending realtime frame maxBytes must be a positive integer')
    }
  }

  private entries: PendingFrameEntry[] = []
  private retainedBytes = 0
  private droppedFrames = 0
  private droppedBytes = 0

  push(frame: RpcStreamFrame): PendingRealtimeFrameBufferStats {
    const encoded = JSON.stringify(frame)
    const entry: PendingFrameEntry = {
      frame,
      bytes: Buffer.byteLength(encoded, 'utf8'),
      terminal: frame.type === 'rpc_stream_end' || frame.type === 'rpc_stream_error'
    }
    this.entries.push(entry)
    this.retainedBytes += entry.bytes
    this.trim()
    return this.stats
  }

  drain(): RpcStreamFrame[] {
    const frames = this.entries.map(entry => entry.frame)
    this.entries = []
    this.retainedBytes = 0
    this.droppedFrames = 0
    this.droppedBytes = 0
    return frames
  }

  get stats(): PendingRealtimeFrameBufferStats {
    return {
      retainedFrames: this.entries.length,
      retainedBytes: this.retainedBytes,
      droppedFrames: this.droppedFrames,
      droppedBytes: this.droppedBytes,
      hasTerminal: this.entries.some(entry => entry.terminal)
    }
  }

  private trim(): void {
    while (this.entries.length > this.maxFrames || this.retainedBytes > this.maxBytes) {
      const nonTerminalIndex = this.entries.findIndex(entry => !entry.terminal)
      const removalIndex = nonTerminalIndex >= 0
        ? nonTerminalIndex
        : this.entries.length > 1
          ? 0
          : -1
      if (removalIndex < 0) break
      const [removed] = this.entries.splice(removalIndex, 1)
      if (!removed) break
      this.retainedBytes = Math.max(0, this.retainedBytes - removed.bytes)
      this.droppedFrames += 1
      this.droppedBytes += removed.bytes
    }
  }
}
