export type GatewayRpcCancelOutcome =
  | 'cancelled'
  | 'not_found'
  | 'already_completed'

export type GatewayRpcResponseClassification =
  | 'late_after_timeout'
  | 'unknown'

export type GatewayRpcCancelAckClassification =
  | 'recorded'
  | 'unknown'
  | 'conflict'

export interface GatewayRequestLifecycleMetrics {
  timedOut: number
  activeTombstones: number
  oldestTombstoneAgeMs: number
  lateAfterTimeout: number
  lastLateAgeMs?: number
  unknownResponses: number
  cancelDispatched: number
  cancelDispatchFailed: number
  lastCancelOutcome?: GatewayRpcCancelOutcome
  cancelAcknowledged: Record<GatewayRpcCancelOutcome, number>
}

interface GatewayRequestTombstone {
  hermesAgentId: string
  gatewayId: string
  gatewayConnectionId: string
  requestId: string
  startedAt: number
  timedOutAt: number
  expiresAt: number
  cancelDispatched: boolean
  cancelOutcome?: GatewayRpcCancelOutcome
  lateResponseAt?: number
}

interface GatewayRequestLifecycleCounters {
  timedOut: number
  lateAfterTimeout: number
  unknownResponses: number
  cancelDispatched: number
  cancelDispatchFailed: number
  lastLateAgeMs?: number
  lastCancelOutcome?: GatewayRpcCancelOutcome
  cancelAcknowledged: Record<GatewayRpcCancelOutcome, number>
}

interface TombstoneIdentity {
  hermesAgentId: string
  gatewayConnectionId: string
  requestId: string
}

const emptyCounters = (): GatewayRequestLifecycleCounters => ({
  timedOut: 0,
  lateAfterTimeout: 0,
  unknownResponses: 0,
  cancelDispatched: 0,
  cancelDispatchFailed: 0,
  cancelAcknowledged: {
    cancelled: 0,
    not_found: 0,
    already_completed: 0,
  },
})

export class GatewayRequestTombstones {
  private readonly tombstones = new Map<string, GatewayRequestTombstone>()
  private readonly countersByAgent = new Map<
    string,
    GatewayRequestLifecycleCounters
  >()

  constructor(
    private readonly ttlMs = 60_000,
    private readonly maximumEntries = 2_048,
    private readonly now: () => number = Date.now,
  ) {}

  recordTimeout(
    input: TombstoneIdentity & {
      gatewayId: string
      startedAt: number
      cancelDispatched: boolean
    },
  ): void {
    const timedOutAt = this.now()
    this.prune(timedOutAt)
    const counters = this.counters(input.hermesAgentId)
    counters.timedOut += 1
    if (input.cancelDispatched) counters.cancelDispatched += 1
    const key = this.key(input)
    this.tombstones.delete(key)
    this.tombstones.set(key, {
      ...input,
      timedOutAt,
      expiresAt: timedOutAt + this.ttlMs,
    })
    this.enforceBound()
  }

  recordCancelDispatchFailure(input: TombstoneIdentity): boolean {
    const tombstone = this.find(input)
    if (!tombstone || !tombstone.cancelDispatched) return false
    this.counters(input.hermesAgentId).cancelDispatchFailed += 1
    return true
  }

  recordCancelAck(
    input: TombstoneIdentity & { outcome: GatewayRpcCancelOutcome },
  ): GatewayRpcCancelAckClassification {
    const tombstone = this.find(input)
    if (!tombstone) return 'unknown'
    if (tombstone.cancelOutcome) {
      return tombstone.cancelOutcome === input.outcome ? 'recorded' : 'conflict'
    }
    tombstone.cancelOutcome = input.outcome
    const counters = this.counters(input.hermesAgentId)
    counters.cancelAcknowledged[input.outcome] += 1
    counters.lastCancelOutcome = input.outcome
    return 'recorded'
  }

  classifyResponse(
    input: TombstoneIdentity,
  ): GatewayRpcResponseClassification {
    const tombstone = this.find(input)
    const counters = this.counters(input.hermesAgentId)
    if (!tombstone) {
      counters.unknownResponses += 1
      return 'unknown'
    }
    if (tombstone.lateResponseAt === undefined) {
      const receivedAt = this.now()
      tombstone.lateResponseAt = receivedAt
      counters.lateAfterTimeout += 1
      counters.lastLateAgeMs = Math.max(0, receivedAt - tombstone.timedOutAt)
    }
    return 'late_after_timeout'
  }

  snapshot(hermesAgentId: string): GatewayRequestLifecycleMetrics {
    this.prune(this.now())
    const counters = this.counters(hermesAgentId)
    let activeTombstones = 0
    let oldestTombstoneAgeMs = 0
    const now = this.now()
    for (const tombstone of this.tombstones.values()) {
      if (tombstone.hermesAgentId !== hermesAgentId) continue
      activeTombstones += 1
      oldestTombstoneAgeMs = Math.max(
        oldestTombstoneAgeMs,
        Math.max(0, now - tombstone.timedOutAt),
      )
    }
    return {
      timedOut: counters.timedOut,
      activeTombstones,
      oldestTombstoneAgeMs,
      lateAfterTimeout: counters.lateAfterTimeout,
      ...(counters.lastLateAgeMs === undefined
        ? {}
        : { lastLateAgeMs: counters.lastLateAgeMs }),
      unknownResponses: counters.unknownResponses,
      cancelDispatched: counters.cancelDispatched,
      cancelDispatchFailed: counters.cancelDispatchFailed,
      ...(counters.lastCancelOutcome
        ? { lastCancelOutcome: counters.lastCancelOutcome }
        : {}),
      cancelAcknowledged: { ...counters.cancelAcknowledged },
    }
  }

  private counters(hermesAgentId: string): GatewayRequestLifecycleCounters {
    let counters = this.countersByAgent.get(hermesAgentId)
    if (!counters) {
      counters = emptyCounters()
      this.countersByAgent.set(hermesAgentId, counters)
    }
    return counters
  }

  private find(input: TombstoneIdentity): GatewayRequestTombstone | undefined {
    const now = this.now()
    this.prune(now)
    const tombstone = this.tombstones.get(this.key(input))
    return tombstone && tombstone.expiresAt > now ? tombstone : undefined
  }

  private key(input: TombstoneIdentity): string {
    return `${input.hermesAgentId}\u0000${input.gatewayConnectionId}\u0000${input.requestId}`
  }

  private prune(now: number): void {
    for (const [key, tombstone] of this.tombstones) {
      if (tombstone.expiresAt > now) continue
      this.tombstones.delete(key)
    }
  }

  private enforceBound(): void {
    while (this.tombstones.size > this.maximumEntries) {
      const oldest = this.tombstones.keys().next().value
      if (typeof oldest !== 'string') return
      this.tombstones.delete(oldest)
    }
  }
}
