export interface PairingRateLimitRule {
  maxAttempts: number
  windowMs: number
}

interface PairingRateLimitBucket {
  count: number
  resetAt: number
}

export class PairingRateLimitError extends Error {
  constructor(readonly retryAfterSeconds: number) {
    super('Pairing request rate limit exceeded')
    this.name = 'PairingRateLimitError'
  }

  readonly statusCode = 429
  readonly code = 'pairing_rate_limited'
}

export class PairingRateLimiter {
  private readonly buckets = new Map<string, PairingRateLimitBucket>()

  constructor(
    private readonly now: () => number = Date.now,
    private readonly maxTrackedKeys = 4096,
  ) {}

  assertAllowed(scope: string, subject: string, rule: PairingRateLimitRule): void {
    if (!Number.isSafeInteger(rule.maxAttempts) || rule.maxAttempts < 1 || rule.windowMs < 1) {
      throw new Error('Invalid pairing rate-limit rule')
    }
    const now = this.now()
    this.pruneExpired(now)
    const key = `${scope}\u0000${subject}`
    const existing = this.buckets.get(key)
    if (!existing && this.buckets.size >= this.maxTrackedKeys) {
      throw new PairingRateLimitError(Math.max(1, Math.ceil(rule.windowMs / 1000)))
    }
    const bucket = !existing || existing.resetAt <= now
      ? { count: 0, resetAt: now + rule.windowMs }
      : existing
    if (bucket.count >= rule.maxAttempts) {
      throw new PairingRateLimitError(Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)))
    }
    bucket.count += 1
    this.buckets.set(key, bucket)
  }

  private pruneExpired(now: number): void {
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= now) this.buckets.delete(key)
    }
  }
}
