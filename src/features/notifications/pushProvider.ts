import type {
  PushDeviceRegistration,
  PushPlatform,
} from './pushDeviceRegistry.js'

export type PushNotificationCategory = 'assistant_reply' | 'prompt_request' | 'error'

export interface PushNotificationIntent {
  hermesAgentId: string
  eventId: string
  sessionId: string
  category: PushNotificationCategory
}

export interface PushDeliveryResult {
  delivered: boolean
  invalidRegistration?: boolean
}

export interface PushProvider {
  readonly name: 'jpush'
  readonly configured: boolean
  send(
    registration: PushDeviceRegistration,
    intent: PushNotificationIntent,
  ): Promise<PushDeliveryResult>
}

type FetchLike = typeof fetch

export class JPushPushProvider implements PushProvider {
  readonly name = 'jpush' as const
  readonly configured: boolean

  constructor(
    private readonly appKey: string,
    private readonly masterSecret: string,
    private readonly production: boolean,
    private readonly fetchImpl: FetchLike = fetch,
  ) {
    this.configured = appKey.trim().length > 0 && masterSecret.trim().length > 0
  }

  async send(
    registration: PushDeviceRegistration,
    intent: PushNotificationIntent,
  ): Promise<PushDeliveryResult> {
    if (!this.configured) return { delivered: false }
    const alert = alertFor(intent.category)
    const extras = {
      event_id: intent.eventId,
      session_id: intent.sessionId,
      category: intent.category,
    }
    const response = await this.fetchImpl('https://api.jpush.cn/v3/push', {
      method: 'POST',
      headers: {
        authorization: `Basic ${Buffer.from(`${this.appKey}:${this.masterSecret}`).toString('base64')}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        platform: jpushPlatform(registration.platform),
        audience: { registration_id: [registration.registrationToken] },
        notification: {
          alert,
          android: {
            alert,
            extras,
            alert_type:
              (registration.preferences.sound ? 1 : 0) +
              (registration.preferences.vibration ? 2 : 0),
          },
          ios: {
            alert,
            extras,
            ...(registration.preferences.sound ? { sound: 'default' } : {}),
          },
        },
        options: {
          apns_production: this.production,
          time_to_live: 86_400,
        },
      }),
      signal: AbortSignal.timeout(10_000),
    })
    if (response.ok) return { delivered: true }
    let errorCode: number | undefined
    try {
      const body = await response.json() as { error?: { code?: unknown } }
      if (typeof body.error?.code === 'number') errorCode = body.error.code
    } catch {
      // Status is sufficient for a retryable failure; response text is never logged.
    }
    return {
      delivered: false,
      invalidRegistration: errorCode === 1011,
    }
  }
}

function jpushPlatform(platform: PushPlatform): 'android' | 'ios' | 'all' {
  return platform === 'harmony' ? 'all' : platform
}

function alertFor(category: PushNotificationCategory): string {
  if (category === 'prompt_request') return 'Hermes Hub needs your attention'
  if (category === 'error') return 'Hermes Hub activity needs attention'
  return 'Hermes Hub has new activity'
}
