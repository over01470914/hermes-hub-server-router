import assert from 'node:assert/strict'
import { DiagnosticsEvidenceJournal, diagnosticsEnabledFromEnvironment, redactDiagnosticsContent } from './diagnosticsEvidence.js'

assert.equal(diagnosticsEnabledFromEnvironment({ HERMES_HUB_DIAGNOSTICS: '1', HERMES_HUB_ENVIRONMENT: 'staging' }), true)
assert.equal(diagnosticsEnabledFromEnvironment({ HERMES_HUB_DIAGNOSTICS: '0', NODE_ENV: 'production' }), false)
assert.throws(
  () => diagnosticsEnabledFromEnvironment({ HERMES_HUB_DIAGNOSTICS: '1' }),
  /unavailable in production/,
)
assert.throws(
  () => diagnosticsEnabledFromEnvironment({ HERMES_HUB_DIAGNOSTICS: '1', NODE_ENV: 'production' }),
  /unavailable in production/,
)

const redacted = redactDiagnosticsContent({ nested: { authorization: 'Bearer private', filePath: 'C:\\secret\\file', items: [{ token: 'nope' }] } }) as Record<string, unknown>
assert.deepEqual(redacted, { nested: { authorization: '[redacted]', filePath: '[path redacted]', items: [{ token: '[redacted]' }] } })

const journal = new DiagnosticsEvidenceJournal(2, 1024)
for (let index = 0; index < 3; index += 1) {
  journal.record({ sourceNode: 'router', stage: `event-${index}`, transport: 'internal', direction: 'internal', outcome: 'completed' })
}
const snapshot = journal.snapshot(10)
assert(snapshot.dropped > 0, 'retention must record evictions')
assert(snapshot.events.some(event => event.stage === 'gap'), 'retention must leave a gap marker')

console.log(JSON.stringify({ ok: true, checks: { productionFailClosed: true, recursiveRedaction: true, cappedJournalGap: true } }))
