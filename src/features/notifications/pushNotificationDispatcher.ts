import { logRouter } from '../../core/observability/routerLogger.js'
import type { PushDeviceRegistry } from './pushDeviceRegistry.js'
import type {
  PushNotificationCategory,
  PushNotificationIntent,
  PushProvider,
} from './pushProvider.js'

export class PushNotificationDispatcher {
  private readonly seenEventIds = new Set<string>()
  private readonly seenEventOrder: string[] = []

  constructor(
    private readonly registry: PushDeviceRegistry,
    private readonly provider: PushProvider,
  ) {}

  async dispatch(input: {
    hermesAgentId: string
    eventId: string
    sessionId: string
    event: string
    data: Record<string, unknown>
  }): Promise<void> {
    if (!this.provider.configured) return
    const category = categoryFor(input.event, input.data)
    if (category == null || !input.eventId || !input.sessionId) return
    const eventKey = `${input.hermesAgentId}\u0000${input.eventId}`
    if (this.seenEventIds.has(eventKey)) return
    this.seenEventIds.add(eventKey)
    this.seenEventOrder.push(eventKey)
    while (this.seenEventOrder.length > 4_096) {
      const oldest = this.seenEventOrder.shift()
      if (oldest) this.seenEventIds.delete(oldest)
    }
    const intent: PushNotificationIntent = {
      hermesAgentId: input.hermesAgentId,
      eventId: input.eventId,
      sessionId: input.sessionId,
      category,
    }
    const registrations = this.registry.registrationsForAgent(input.hermesAgentId)
    let delivered = 0
    let revoked = 0
    for (const registration of registrations) {
      if (!allowsCategory(registration.preferences, category)) continue
      try {
        const result = await this.provider.send(registration, intent)
        if (result.delivered) delivered += 1
        if (result.invalidRegistration) {
          if (this.registry.remove(registration.hermesAgentId, registration.deviceId)) {
            revoked += 1
          }
        }
      } catch {
        // Provider failures are isolated from realtime event delivery.
      }
    }
    logRouter('info', 'Push notification dispatch completed', {
      hermesAgentId: input.hermesAgentId,
      category,
      registrationCount: registrations.length,
      delivered,
      revoked,
    })
  }
}

function allowsCategory(
  preferences: {
    assistantReplies: boolean
    promptRequests: boolean
    errors: boolean
  },
  category: PushNotificationCategory,
): boolean {
  if (category === 'assistant_reply') return preferences.assistantReplies
  if (category === 'prompt_request') return preferences.promptRequests
  return preferences.errors
}

function categoryFor(
  event: string,
  data: Record<string, unknown>,
): PushNotificationCategory | null {
  if (
    event === 'prompt.requested' ||
    event === 'clarify.request' ||
    event === 'approval.request'
  ) return 'prompt_request'
  if (event === 'error') return 'error'
  if (event === 'message.complete') {
    return eventReportsFailure(data) ? 'error' : 'assistant_reply'
  }
  if (event === 'processing.completed') {
    if (eventReportsFailure(data)) return null
    return 'assistant_reply'
  }
  if (event === 'message.created' && data.role === 'assistant') {
    return 'assistant_reply'
  }
  return null
}

function eventReportsFailure(data: Record<string, unknown>): boolean {
  const rawStatus = data.status ?? data.outcome
  const status = typeof rawStatus === 'string' ? rawStatus.trim().toLowerCase() : ''
  if (status === 'error' || status === 'failed' || status === 'failure') return true
  const error = data.error
  if (error === true) return true
  if (typeof error === 'string' && error.trim().length > 0) return true
  if (error && typeof error === 'object' && !Array.isArray(error)) return true
  const failureReason = data.failure_reason ?? data.failureReason
  return typeof failureReason === 'string' && failureReason.trim().length > 0
}
