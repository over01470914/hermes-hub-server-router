import assert from 'node:assert/strict'
import { logRouter } from './routerLogger.js'

const info = console.info
const error = console.error
const lines: string[] = []

console.info = (line: unknown) => lines.push(String(line))
console.error = (line: unknown) => lines.push(String(line))

try {
  logRouter(
    'info',
    'session.submit.started',
    'Router begins a native session submission.',
    {
      hermesAgentId: 'agent_logger_smoke',
      submissionId: 'sub_logger_smoke',
      conversationId: 'conv_logger_smoke',
      gatewayConnectionId: 'gwc_logger_smoke',
      latencyMs: 12,
      token: 'must-not-appear',
      text: 'must-not-appear',
      body: { prompt: 'must-not-appear' },
      messageCount: 2,
      responseStatus: 202,
      responseBytes: 64,
      attachmentCount: 1,
      upstreamError: Object.assign(new Error('must-not-appear'), { code: 'upstream_failed' }),
      event: 'forged.event',
      message: 'must-not-replace-envelope',
      timestamp: 'forged-time',
      capabilities: Array.from({ length: 40 }, (_, index) => `capability_${index}`),
    },
  )
  const first = JSON.parse(lines.shift() || '{}') as Record<string, unknown>
  assert.equal(first.event, 'session.submit.started')
  assert.equal(first.durationMs, 12)
  assert.equal(first.connectionId, 'gwc_logger_smoke')
  assert.equal('latencyMs' in first, false)
  assert.equal('gatewayConnectionId' in first, false)
  assert.equal(first.token, '[redacted]')
  assert.equal(first.text, '[redacted]')
  assert.equal(first.body, '[redacted]')
  assert.equal(first.messageCount, 2)
  assert.equal(first.responseStatus, 202)
  assert.equal(first.responseBytes, 64)
  assert.equal(first.attachmentCount, 1)
  assert.equal(first.upstreamError, '[redacted]')
  assert.equal(first.event, 'session.submit.started')
  assert.equal(first.message, 'Router begins a native session submission.')
  assert.notEqual(first.timestamp, 'forged-time')
  assert.equal((first.capabilities as unknown[]).length, 32)

  const sensitive = Object.assign(new Error('message body: must-not-appear'), {
    code: 'gateway_rpc_timeout',
  })
  logRouter('error', 'gateway.rpc.failed', 'Gateway RPC cannot safely continue.', {}, sensitive)
  const second = JSON.parse(lines.shift() || '{}') as Record<string, unknown>
  assert.equal(second.event, 'gateway.rpc.failed')
  assert.equal(second.errorCode, 'gateway_rpc_timeout')
  assert.equal(JSON.stringify(second).includes('must-not-appear'), false)
} finally {
  console.info = info
  console.error = error
}

console.log('Router logger story smoke passed.')
