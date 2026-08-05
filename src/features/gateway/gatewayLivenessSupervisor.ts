export type GatewayLivenessState =
  | { kind: 'healthy'; lastAckAt: number; latencyMs: number }
  | { kind: 'suspect'; lastAckAt: number; consecutiveMisses: 1 }
  | { kind: 'offline'; lastAckAt?: number; reason: string }

export type GatewayLivenessProbeOutcome =
  | { ok: true; latencyMs: number }
  | { ok: false; reason: string; fatal?: boolean }

export interface GatewayLivenessProbe {
  gatewayConnectionId: string
  run(): Promise<GatewayLivenessProbeOutcome>
  close(reason: string): void
}

interface TrackedLiveness {
  gatewayConnectionId: string
  consecutiveMisses: number
  state: GatewayLivenessState
}

interface InFlightProbe {
  gatewayConnectionId: string
  promise: Promise<GatewayLivenessState>
}

export class GatewayLivenessSupervisor {
  private readonly tracked = new Map<string, TrackedLiveness>()
  private readonly inFlight = new Map<string, InFlightProbe>()

  constructor(
    private readonly resolveProbe: (
      hermesAgentId: string,
      timeoutMs: number,
    ) => GatewayLivenessProbe | null,
  ) {}

  recordSocketReady(
    hermesAgentId: string,
    gatewayConnectionId: string,
  ): void {
    this.tracked.set(hermesAgentId, {
      gatewayConnectionId,
      consecutiveMisses: 0,
      state: {
        kind: 'healthy',
        lastAckAt: Date.now(),
        latencyMs: 0,
      },
    })
  }

  recordSocketClosed(
    hermesAgentId: string,
    gatewayConnectionId: string,
    reason: string,
  ): void {
    const current = this.tracked.get(hermesAgentId)
    if (current && current.gatewayConnectionId !== gatewayConnectionId) return
    const previous = current?.state
    this.tracked.set(hermesAgentId, {
      gatewayConnectionId,
      consecutiveMisses: 2,
      state: previous?.kind === 'offline'
        ? previous
        : {
            kind: 'offline',
            ...(previous && 'lastAckAt' in previous
              ? { lastAckAt: previous.lastAckAt }
              : {}),
            reason,
          },
    })
  }

  snapshot(hermesAgentId: string): GatewayLivenessState {
    return this.tracked.get(hermesAgentId)?.state ?? {
      kind: 'offline',
      reason: 'Gateway offline',
    }
  }

  probe(
    hermesAgentId: string,
    // The Sidecar and Plugin share this control frame with an active Hermes
    // request path. Six seconds preserves fast failure detection without
    // treating ordinary three-to-five second host scheduling stalls as a
    // disconnected Gateway.
    timeoutMs = 6_000,
  ): Promise<GatewayLivenessState> {
    const candidate = this.resolveProbe(hermesAgentId, timeoutMs)
    if (!candidate) {
      const current = this.tracked.get(hermesAgentId)
      const state: GatewayLivenessState = {
        kind: 'offline',
        ...(current?.state && 'lastAckAt' in current.state
          ? { lastAckAt: current.state.lastAckAt }
          : {}),
        reason: 'Gateway offline',
      }
      if (current) {
        this.tracked.set(hermesAgentId, {
          ...current,
          consecutiveMisses: 2,
          state,
        })
      }
      return Promise.resolve(state)
    }

    const pending = this.inFlight.get(hermesAgentId)
    if (pending?.gatewayConnectionId === candidate.gatewayConnectionId) {
      return pending.promise
    }

    const promise = this.runProbe(hermesAgentId, candidate)
    this.inFlight.set(hermesAgentId, {
      gatewayConnectionId: candidate.gatewayConnectionId,
      promise,
    })
    void promise.finally(() => {
      if (this.inFlight.get(hermesAgentId)?.promise === promise) {
        this.inFlight.delete(hermesAgentId)
      }
    })
    return promise
  }

  private async runProbe(
    hermesAgentId: string,
    candidate: GatewayLivenessProbe,
  ): Promise<GatewayLivenessState> {
    let outcome: GatewayLivenessProbeOutcome
    try {
      outcome = await candidate.run()
    } catch (error) {
      outcome = {
        ok: false,
        reason: error instanceof Error ? error.message : String(error),
      }
    }

    const current = this.tracked.get(hermesAgentId)
    if (!current ||
        current.gatewayConnectionId !== candidate.gatewayConnectionId) {
      return this.snapshot(hermesAgentId)
    }

    if (outcome.ok) {
      const state: GatewayLivenessState = {
        kind: 'healthy',
        lastAckAt: Date.now(),
        latencyMs: outcome.latencyMs,
      }
      this.tracked.set(hermesAgentId, {
        ...current,
        consecutiveMisses: 0,
        state,
      })
      return state
    }

    const lastAckAt = 'lastAckAt' in current.state
      ? current.state.lastAckAt
      : undefined
    const shouldClose = outcome.fatal || current.consecutiveMisses >= 1
    if (!shouldClose) {
      const state: GatewayLivenessState = {
        kind: 'suspect',
        lastAckAt: lastAckAt ?? Date.now(),
        consecutiveMisses: 1,
      }
      this.tracked.set(hermesAgentId, {
        ...current,
        consecutiveMisses: 1,
        state,
      })
      return state
    }

    const state: GatewayLivenessState = {
      kind: 'offline',
      ...(lastAckAt === undefined ? {} : { lastAckAt }),
      reason: outcome.reason,
    }
    this.tracked.set(hermesAgentId, {
      ...current,
      consecutiveMisses: 2,
      state,
    })
    candidate.close(outcome.reason)
    return state
  }
}
