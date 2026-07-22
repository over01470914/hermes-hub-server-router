import assert from 'node:assert/strict'

import {
  AGENT_FEATURE_GATEWAY_CONTRACT_VERSION,
  agentFeatureGatewayAvailable,
  requiredGatewayCapabilityForAgentFeature,
} from './agentFeatureCapability.js'

assert.equal(AGENT_FEATURE_GATEWAY_CONTRACT_VERSION, 1)
assert.equal(requiredGatewayCapabilityForAgentFeature('cron'), 'cron')
assert.equal(requiredGatewayCapabilityForAgentFeature('kanban'), 'kanban.read')

assert.equal(
  agentFeatureGatewayAvailable({ online: true, capabilities: ['cron'] }, 'cron'),
  true,
)
assert.equal(
  agentFeatureGatewayAvailable({ online: true, capabilities: ['cron'] }, 'kanban'),
  false,
)
assert.equal(
  agentFeatureGatewayAvailable({ online: false, capabilities: ['cron', 'kanban.read'] }, 'cron'),
  false,
)
assert.equal(agentFeatureGatewayAvailable(null, 'kanban'), false)

console.log(JSON.stringify({
  ok: true,
  checks: [
    'stable feature capability mapping',
    'online Gateway capability required',
    'unadvertised feature remains unavailable',
  ],
}, null, 2))
