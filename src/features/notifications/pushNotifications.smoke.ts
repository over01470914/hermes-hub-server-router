import assert from 'node:assert/strict'
import {
  PushDeviceRegistry,
  type EncryptedPushDeviceRecord,
  type PushDeviceRegistration,
} from './pushDeviceRegistry.js'
import { PushNotificationDispatcher } from './pushNotificationDispatcher.js'
import type {
  PushDeliveryResult,
  PushNotificationIntent,
  PushProvider,
} from './pushProvider.js'
import { JPushPushProvider } from './pushProvider.js'

const encryptionKey = 'test-only-push-storage-key-32-characters-minimum'
const rawToken = 'registration-token-must-never-be-stored'
let persisted: EncryptedPushDeviceRecord[] = []
const registry = new PushDeviceRegistry(
  encryptionKey,
  [],
  records => {
    persisted = records
  },
  () => 1_700_000_000_000,
)

registry.upsert({
  hermesAgentId: 'agent_a',
  deviceId: 'device_a',
  provider: 'jpush',
  platform: 'android',
  registrationToken: rawToken,
  preferences: {
    assistantReplies: true,
    promptRequests: true,
    errors: true,
    sound: false,
    vibration: true,
  },
})
assert.equal(registry.size, 1)
assert.equal(JSON.stringify(persisted).includes(rawToken), false)
assert.equal(
  registry.registrationsForAgent('agent_a')[0]?.registrationToken,
  rawToken,
)
assert.equal(
  registry.registrationsForAgent('agent_a')[0]?.preferences.sound,
  false,
)
assert.deepEqual(registry.registrationsForAgent('agent_b'), [])

const reloaded = new PushDeviceRegistry(encryptionKey, persisted)
assert.equal(reloaded.registrationsForAgent('agent_a')[0]?.registrationToken, rawToken)
assert.throws(
  () => new PushDeviceRegistry('different-test-push-storage-key-32-characters', persisted),
  /cannot be decrypted/,
)

const providerRequests: Record<string, unknown>[] = []
const jpushProvider = new JPushPushProvider(
  'test-configuration',
  'test-provider-credential',
  false,
  async (_input, init) => {
    providerRequests.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
    return new Response('{}', { status: 200 })
  },
)
assert.deepEqual(
  await jpushProvider.send(
    registry.registrationsForAgent('agent_a')[0]!,
    {
      hermesAgentId: 'agent_a',
      eventId: 'provider_event',
      sessionId: 'session_1',
      category: 'assistant_reply',
    },
  ),
  { delivered: true },
)
assert.equal(providerRequests.length, 1)
assert.equal(JSON.stringify(providerRequests).includes(rawToken), true)
assert.equal(JSON.stringify(providerRequests).includes('message body'), false)
assert.equal(
  (
    (
      providerRequests[0]?.notification as Record<string, unknown>
    )?.android as Record<string, unknown>
  )?.alert_type,
  2,
)

class FakePushProvider implements PushProvider {
  readonly name = 'jpush' as const
  readonly configured = true
  readonly intents: PushNotificationIntent[] = []
  invalid = false

  async send(
    _registration: PushDeviceRegistration,
    intent: PushNotificationIntent,
  ): Promise<PushDeliveryResult> {
    this.intents.push(intent)
    return this.invalid
      ? { delivered: false, invalidRegistration: true }
      : { delivered: true }
  }
}

const provider = new FakePushProvider()
const dispatcher = new PushNotificationDispatcher(registry, provider)
await dispatcher.dispatch({
  hermesAgentId: 'agent_a',
  eventId: 'event_1',
  sessionId: 'session_1',
  event: 'message.created',
  data: { role: 'assistant', text: 'must not be copied' },
})
assert.equal(provider.intents.length, 1)
assert.deepEqual(provider.intents[0], {
  hermesAgentId: 'agent_a',
  eventId: 'event_1',
  sessionId: 'session_1',
  category: 'assistant_reply',
})
assert.equal(JSON.stringify(provider.intents).includes('must not be copied'), false)

await dispatcher.dispatch({
  hermesAgentId: 'agent_a',
  eventId: 'event_1',
  sessionId: 'session_1',
  event: 'message.created',
  data: { role: 'assistant' },
})
assert.equal(provider.intents.length, 1)

registry.upsert({
  hermesAgentId: 'agent_a',
  deviceId: 'device_a',
  provider: 'jpush',
  platform: 'android',
  registrationToken: rawToken,
  preferences: {
    assistantReplies: false,
    promptRequests: true,
    errors: true,
    sound: false,
    vibration: true,
  },
})
await dispatcher.dispatch({
  hermesAgentId: 'agent_a',
  eventId: 'event_muted_reply',
  sessionId: 'session_1',
  event: 'message.created',
  data: { role: 'assistant' },
})
assert.equal(provider.intents.length, 1)

await dispatcher.dispatch({
  hermesAgentId: 'agent_a',
  eventId: 'event_delta',
  sessionId: 'session_1',
  event: 'message.delta',
  data: { text: 'ignored' },
})
assert.equal(provider.intents.length, 1)

provider.invalid = true
await dispatcher.dispatch({
  hermesAgentId: 'agent_a',
  eventId: 'event_error',
  sessionId: 'session_1',
  event: 'error',
  data: { detail: 'not copied' },
})
assert.equal(registry.size, 0)

console.log('push notification smoke passed')
