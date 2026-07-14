import assert from 'node:assert/strict'
import {
  DiagnosticsPayloadError,
  maxDiagnosticsEntries,
  normalizeDiagnosticsReceipt,
  summarizeDiagnosticsReceipt
} from './diagnosticsReceipt.js'

const diagnosticEntry = {
  level: 'warning',
  category: 'connection',
  message: 'Authorization: Bearer bridge-token-value pairing code 12345678',
  timestamp: '2026-07-12T08:30:00.000Z',
  data: {
    latencyMs: 42,
    token: 'bridge-token-value',
    messageBody: 'private prompt body',
    nested: {
      apiKey: 'provider-key-value',
      retryable: true
    }
  }
}

const receipt = normalizeDiagnosticsReceipt({
  logText: 'legacy duplicate containing a private message body',
  entries: [
    diagnosticEntry,
    {
      level: 'debug',
      category: 'navigation',
      message: 'Settings opened',
      timestamp: '2026-07-12T08:30:01.000Z'
    }
  ],
  metadata: {
    appVersion: '0.1.0',
    routerUrl: 'https://user:password@router.example.test/v1?token=router-token&mode=dev',
    hermesAgentId: 'agent-safe-id',
    gatewayId: 'gw-safe-id',
    unexpected: 'must not cross the allowlist'
  }
})

const serialized = JSON.stringify(receipt)
assert.equal(receipt.entries.length, 2)
assert.equal(receipt.metadata.appVersion, '0.1.0')
assert.equal(receipt.metadata.unexpected, undefined)
assert.equal(receipt.entries[0].data?.latencyMs, 42)
assert.equal(receipt.entries[0].data?.token, '[redacted]')
assert.equal(receipt.entries[0].data?.messageBody, '[redacted]')
assert.deepEqual(receipt.entries[0].data?.nested, {
  apiKey: '[redacted]',
  retryable: true
})
assert.match(String(receipt.metadata.routerUrl), /token=\[redacted\]/)
assert.doesNotMatch(serialized, /bridge-token-value|provider-key-value|private prompt body|router-token|password/)
assert.doesNotMatch(serialized, /legacy duplicate/)

const summary = summarizeDiagnosticsReceipt(receipt)
assert.equal(summary.entryCount, 2)
assert.deepEqual(summary.levels, { warning: 1, debug: 1 })
assert.deepEqual(summary.categories, ['connection', 'navigation'])
assert.deepEqual(summary.metadataKeys, ['appVersion', 'gatewayId', 'hermesAgentId', 'routerUrl'])
assert.ok(summary.receiptBytes > 0)

assert.throws(
  () => normalizeDiagnosticsReceipt({ entries: 3, logText: 'legacy shape' }),
  (error: unknown) => error instanceof DiagnosticsPayloadError &&
    error.code === 'diagnostics_invalid' && error.statusCode === 400
)

assert.throws(
  () => normalizeDiagnosticsReceipt({
    entries: Array.from({ length: maxDiagnosticsEntries + 1 }, () => diagnosticEntry)
  }),
  (error: unknown) => error instanceof DiagnosticsPayloadError &&
    error.code === 'diagnostics_too_large' && error.statusCode === 413
)

console.log(JSON.stringify({
  ok: true,
  checks: [
    'structured entry count',
    'server-side secret redaction',
    'content-field suppression',
    'metadata allowlist',
    'safe summary output',
    'legacy numeric entries rejected',
    'entry limit enforced'
  ]
}))
