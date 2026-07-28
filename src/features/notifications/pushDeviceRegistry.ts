import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto'

export const PUSH_DEVICE_REGISTRY_SCHEMA_VERSION = 1

export type PushProviderName = 'jpush'
export type PushPlatform = 'android' | 'ios' | 'harmony'

export interface PushNotificationPreferences {
  assistantReplies: boolean
  promptRequests: boolean
  errors: boolean
  sound: boolean
  vibration: boolean
}

export interface PushDeviceRegistration {
  hermesAgentId: string
  deviceId: string
  provider: PushProviderName
  platform: PushPlatform
  registrationToken: string
  preferences: PushNotificationPreferences
}

export interface EncryptedPushDeviceRecord {
  hermesAgentId: string
  deviceId: string
  provider: PushProviderName
  platform: PushPlatform
  encryptedRegistrationToken: string
  preferences?: PushNotificationPreferences
  updatedAt: number
}

export interface PushDeviceRegistryState {
  schemaVersion: number
  records: EncryptedPushDeviceRecord[]
}

type PersistPushDeviceRecords = (records: EncryptedPushDeviceRecord[]) => void

export class PushDeviceRegistry {
  private readonly key: Buffer
  private readonly records = new Map<string, EncryptedPushDeviceRecord>()

  constructor(
    encryptionSecret: string,
    initialRecords: EncryptedPushDeviceRecord[] = [],
    private readonly persist: PersistPushDeviceRecords = () => {},
    private readonly now: () => number = Date.now,
  ) {
    if (encryptionSecret.length < 32) {
      throw new Error('Push device storage encryption key must be at least 32 characters')
    }
    this.key = createHash('sha256').update(encryptionSecret).digest()
    for (const record of initialRecords) {
      validateEncryptedRecord(record)
      this.decrypt(record.encryptedRegistrationToken)
      this.records.set(recordKey(record.hermesAgentId, record.deviceId), { ...record })
    }
  }

  upsert(input: PushDeviceRegistration): void {
    validateRegistration(input)
    const record: EncryptedPushDeviceRecord = {
      hermesAgentId: input.hermesAgentId,
      deviceId: input.deviceId,
      provider: input.provider,
      platform: input.platform,
      encryptedRegistrationToken: this.encrypt(input.registrationToken),
      preferences: { ...input.preferences },
      updatedAt: this.now(),
    }
    this.records.set(recordKey(input.hermesAgentId, input.deviceId), record)
    this.flush()
  }

  remove(hermesAgentId: string, deviceId: string): boolean {
    const removed = this.records.delete(recordKey(hermesAgentId, deviceId))
    if (removed) this.flush()
    return removed
  }

  registrationsForAgent(hermesAgentId: string): PushDeviceRegistration[] {
    const registrations: PushDeviceRegistration[] = []
    for (const record of this.records.values()) {
      if (record.hermesAgentId !== hermesAgentId) continue
      registrations.push({
        hermesAgentId: record.hermesAgentId,
        deviceId: record.deviceId,
        provider: record.provider,
        platform: record.platform,
        registrationToken: this.decrypt(record.encryptedRegistrationToken),
        preferences: normalizePreferences(record.preferences),
      })
    }
    return registrations
  }

  get size(): number {
    return this.records.size
  }

  snapshot(): EncryptedPushDeviceRecord[] {
    return [...this.records.values()].map(record => ({ ...record }))
  }

  private flush(): void {
    this.persist(this.snapshot())
  }

  private encrypt(value: string): string {
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', this.key, iv)
    const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
    const tag = cipher.getAuthTag()
    return `${iv.toString('base64url')}.${tag.toString('base64url')}.${encrypted.toString('base64url')}`
  }

  private decrypt(value: string): string {
    const [ivEncoded, tagEncoded, encryptedEncoded, ...extra] = value.split('.')
    if (!ivEncoded || !tagEncoded || !encryptedEncoded || extra.length > 0) {
      throw new Error('Encrypted push registration token is invalid')
    }
    try {
      const decipher = createDecipheriv(
        'aes-256-gcm',
        this.key,
        Buffer.from(ivEncoded, 'base64url'),
      )
      decipher.setAuthTag(Buffer.from(tagEncoded, 'base64url'))
      return Buffer.concat([
        decipher.update(Buffer.from(encryptedEncoded, 'base64url')),
        decipher.final(),
      ]).toString('utf8')
    } catch {
      throw new Error('Encrypted push registration token cannot be decrypted')
    }
  }
}

function recordKey(hermesAgentId: string, deviceId: string): string {
  return `${hermesAgentId}\u0000${deviceId}`
}

function validateId(value: string, label: string): void {
  if (!value || value.length > 160 || !/^[A-Za-z0-9._:-]+$/.test(value)) {
    throw new Error(`${label} invalid`)
  }
}

function validateRegistration(input: PushDeviceRegistration): void {
  validateId(input.hermesAgentId, 'Hermes Agent id')
  validateId(input.deviceId, 'Device id')
  if (input.provider !== 'jpush') throw new Error('Push provider invalid')
  if (!['android', 'ios', 'harmony'].includes(input.platform)) {
    throw new Error('Push platform invalid')
  }
  if (
    !input.registrationToken ||
    input.registrationToken.length > 2048 ||
    /[\u0000-\u001f\u007f]/.test(input.registrationToken)
  ) {
    throw new Error('Push registration token invalid')
  }
  validatePreferences(input.preferences)
}

function validateEncryptedRecord(record: EncryptedPushDeviceRecord): void {
  if (record.preferences != null) validatePreferences(record.preferences)
  validateRegistration({
    hermesAgentId: record.hermesAgentId,
    deviceId: record.deviceId,
    provider: record.provider,
    platform: record.platform,
    registrationToken: record.encryptedRegistrationToken,
    preferences: normalizePreferences(record.preferences),
  })
  if (!Number.isSafeInteger(record.updatedAt) || record.updatedAt < 0) {
    throw new Error('Push device updatedAt invalid')
  }
}

function validatePreferences(value: unknown): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Push notification preferences invalid')
  }
  const preferences = value as Record<string, unknown>
  for (const key of [
    'assistantReplies',
    'promptRequests',
    'errors',
    'sound',
    'vibration',
  ]) {
    if (typeof preferences[key] !== 'boolean') {
      throw new Error('Push notification preferences invalid')
    }
  }
}

export function normalizePreferences(
  value: Partial<PushNotificationPreferences> | undefined,
): PushNotificationPreferences {
  return {
    assistantReplies: value?.assistantReplies !== false,
    promptRequests: value?.promptRequests !== false,
    errors: value?.errors !== false,
    sound: value?.sound !== false,
    vibration: value?.vibration !== false,
  }
}
