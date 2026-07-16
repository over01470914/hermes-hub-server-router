import { randomUUID } from 'node:crypto'
import type { WebSocket } from 'ws'

export interface BridgeClientEvent {
  type: 'bridge.event'
  version: 2
  cursor: number
  event_id: string
  conversation_id: string
  session_id?: string
  submission_id?: string
  event: string
  data: Record<string, unknown>
  sent_at: number
}

export interface ClientEventSubscription {
  scope: string
  clientId: string
  afterCursor?: number
  expiresAtMs?: number
}

export interface ClientEventAttachResult {
  currentCursor: number
  replayed: number
  resyncRequired: boolean
}

export interface ClientEventPublishInput {
  scope: string
  conversationId?: string
  sessionId?: string
  submissionId?: string
  event?: string
  data?: Record<string, unknown>
  eventId?: string
  // Legacy request-bound stream fields remain accepted only so dead code can
  // compile during the hard cutover. Production routes no longer invoke them.
  streamId?: string
  frame?: unknown
  originClientId?: string
}

interface Subscriber {
  socket: WebSocket
  scope: string
  clientId: string
}

interface JournalEntry {
  event: BridgeClientEvent
  encoded: string
  bytes: number
}

interface ScopeState {
  cursor: number
  replay: JournalEntry[]
  replayBytes: number
  droppedThroughCursor: number
  eventsById: Map<string, BridgeClientEvent>
}

export interface ClientEventHubOptions {
  maxReplayEventsPerScope?: number
  maxReplayBytesPerScope?: number
  maxJournalScopes?: number
  maxSubscriberBufferedBytes?: number
  heartbeatIntervalMs?: number
}

const defaultMaxReplayEventsPerScope = 2048
const defaultMaxReplayBytesPerScope = 2 * 1024 * 1024
const defaultMaxJournalScopes = 64
const defaultMaxSubscriberBufferedBytes = 4 * 1024 * 1024
const defaultHeartbeatIntervalMs = 20_000

const socketOpen = 1

export class ClientEventHub {
  constructor(options: ClientEventHubOptions = {}) {
    this.maxReplayEventsPerScope = positiveInteger(
      options.maxReplayEventsPerScope,
      defaultMaxReplayEventsPerScope
    )
    this.maxReplayBytesPerScope = positiveInteger(
      options.maxReplayBytesPerScope,
      defaultMaxReplayBytesPerScope
    )
    this.maxJournalScopes = positiveInteger(
      options.maxJournalScopes,
      defaultMaxJournalScopes
    )
    this.maxSubscriberBufferedBytes = positiveInteger(
      options.maxSubscriberBufferedBytes,
      defaultMaxSubscriberBufferedBytes
    )
    this.heartbeatIntervalMs = positiveInteger(
      options.heartbeatIntervalMs,
      defaultHeartbeatIntervalMs
    )
  }

  private readonly subscribers = new Set<Subscriber>()
  private readonly scopeByName = new Map<string, ScopeState>()
  private readonly journalScopes = new Map<string, true>()
  private readonly maxReplayEventsPerScope: number
  private readonly maxReplayBytesPerScope: number
  private readonly maxJournalScopes: number
  private readonly maxSubscriberBufferedBytes: number
  private readonly heartbeatIntervalMs: number

  get subscriberCount(): number {
    return this.subscribers.size
  }

  attach(socket: WebSocket, subscription: ClientEventSubscription): ClientEventAttachResult {
    const state = this.scopeState(subscription.scope)
    const currentCursor = state.cursor
    const requestedCursor = subscription.afterCursor
    const resumeCursor = requestedCursor == null ? currentCursor : Math.max(0, requestedCursor)
    const replay = state.replay
    const oldestCursor = replay[0]?.event.cursor
    const resyncRequired = requestedCursor != null && (
      resumeCursor > currentCursor ||
      resumeCursor < state.droppedThroughCursor
    )
    const subscriber: Subscriber = {
      socket,
      scope: subscription.scope,
      clientId: subscription.clientId
    }
    this.subscribers.add(subscriber)
    this.retainJournal(subscription.scope)

    let alive = true
    const heartbeat = setInterval(() => {
      if (!alive || socket.readyState !== socketOpen) {
        socket.terminate()
        return
      }
      alive = false
      socket.ping()
    }, this.heartbeatIntervalMs)
    heartbeat.unref?.()
    const expiresInMs = subscription.expiresAtMs == null
      ? undefined
      : Math.max(0, subscription.expiresAtMs - Date.now())
    const expiry = expiresInMs == null
      ? undefined
      : setTimeout(() => socket.close(4001, 'bridge token expired'), expiresInMs)
    expiry?.unref?.()
    socket.on('pong', () => {
      alive = true
    })
    const detach = () => {
      clearInterval(heartbeat)
      if (expiry) clearTimeout(expiry)
      this.subscribers.delete(subscriber)
      this.pruneIdleJournals()
    }
    socket.once('close', detach)
    socket.once('error', detach)

    this.send(socket, {
      type: 'bridge.ready',
      version: 2,
      cursor: currentCursor,
      resume_cursor: resumeCursor,
      heartbeat_interval_ms: this.heartbeatIntervalMs
    })

    if (resyncRequired) {
      this.send(socket, {
        type: 'bridge.resync_required',
        version: 2,
        cursor: currentCursor,
        oldest_available_cursor: oldestCursor
      })
      return { currentCursor, replayed: 0, resyncRequired: true }
    }

    let replayed = 0
    for (const entry of replay) {
      const event = entry.event
      if (event.cursor <= resumeCursor) continue
      if (!this.send(socket, event, entry.encoded)) break
      replayed += 1
    }
    this.sendCursor(socket, currentCursor)
    return { currentCursor, replayed, resyncRequired: false }
  }

  publish(input: ClientEventPublishInput): BridgeClientEvent {
    const state = this.scopeState(input.scope)
    this.retainJournal(input.scope)
    const eventId = input.eventId || `evt_${randomUUID()}`
    const duplicate = state.eventsById.get(eventId)
    if (duplicate) return duplicate
    const cursor = state.cursor + 1
    state.cursor = cursor
    const event: BridgeClientEvent = {
      type: 'bridge.event',
      version: 2,
      cursor,
      event_id: eventId,
      conversation_id: input.conversationId || input.sessionId || 'unknown',
      ...(input.sessionId ? { session_id: input.sessionId } : {}),
      ...(input.submissionId ? { submission_id: input.submissionId } : {}),
      event: input.event || 'legacy.frame',
      data: input.data || { frame: input.frame },
      sent_at: Date.now()
    }
    const encoded = JSON.stringify(event)
    const entry: JournalEntry = {
      event,
      encoded,
      bytes: Buffer.byteLength(encoded, 'utf8'),
    }
    state.replay.push(entry)
    state.eventsById.set(eventId, event)
    state.replayBytes += entry.bytes
    this.trimReplay(state)

    for (const subscriber of this.subscribers) {
      if (subscriber.scope !== input.scope) continue
      this.send(subscriber.socket, event, encoded)
    }
    return event
  }

  reset(): void {
    for (const subscriber of this.subscribers) {
      subscriber.socket.close(1012, 'realtime state reset')
    }
    this.subscribers.clear()
    this.scopeByName.clear()
    this.journalScopes.clear()
  }

  private scopeState(scope: string): ScopeState {
    const existing = this.scopeByName.get(scope)
    if (existing) return existing
    const created: ScopeState = {
      cursor: 0,
      replay: [],
      replayBytes: 0,
      droppedThroughCursor: 0,
      eventsById: new Map(),
    }
    this.scopeByName.set(scope, created)
    return created
  }

  private retainJournal(scope: string): void {
    this.scopeState(scope)
    this.journalScopes.delete(scope)
    this.journalScopes.set(scope, true)
    this.pruneIdleJournals(scope)
  }

  private pruneIdleJournals(protectedScope?: string): void {
    while (this.journalScopes.size > this.maxJournalScopes) {
      let evicted = false
      for (const scope of this.journalScopes.keys()) {
        if (scope === protectedScope || this.hasSubscriberForScope(scope)) continue
        const state = this.scopeByName.get(scope)
        this.journalScopes.delete(scope)
        if (state) {
          state.replay = []
          state.replayBytes = 0
          state.droppedThroughCursor = state.cursor
          state.eventsById.clear()
        }
        evicted = true
        break
      }
      if (!evicted) break
    }
  }

  private hasSubscriberForScope(scope: string): boolean {
    for (const subscriber of this.subscribers) {
      if (subscriber.scope === scope) return true
    }
    return false
  }

  private trimReplay(state: ScopeState): void {
    while (
      state.replay.length > this.maxReplayEventsPerScope ||
      state.replayBytes > this.maxReplayBytesPerScope
    ) {
      const removed = state.replay.shift()
      if (!removed) break
      state.replayBytes = Math.max(0, state.replayBytes - removed.bytes)
      state.droppedThroughCursor = Math.max(
        state.droppedThroughCursor,
        removed.event.cursor
      )
      if (state.eventsById.get(removed.event.event_id) === removed.event) {
        state.eventsById.delete(removed.event.event_id)
      }
    }
  }

  private send(socket: WebSocket, payload: unknown, encoded?: string): boolean {
    if (socket.readyState !== socketOpen) return false
    const data = encoded ?? JSON.stringify(payload)
    const outgoingBytes = Buffer.byteLength(data, 'utf8')
    if (socket.bufferedAmount + outgoingBytes > this.maxSubscriberBufferedBytes) {
      socket.close(1013, 'client realtime backpressure')
      return false
    }
    try {
      socket.send(data)
      return true
    } catch {
      socket.terminate()
      return false
    }
  }

  private sendCursor(socket: WebSocket, cursor: number): boolean {
    return this.send(socket, {
      type: 'bridge.cursor',
      version: 2,
      cursor
    })
  }
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return value != null && Number.isSafeInteger(value) && value > 0 ? value : fallback
}
