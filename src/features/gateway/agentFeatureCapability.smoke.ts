import assert from 'node:assert/strict'

import {
  AGENT_FEATURE_GATEWAY_CONTRACT_VERSION,
  agentFeatureGatewayAvailable,
  requiredGatewayCapabilityForAgentFeature,
} from './agentFeatureCapability.js'

assert.equal(AGENT_FEATURE_GATEWAY_CONTRACT_VERSION, 2)
assert.equal(requiredGatewayCapabilityForAgentFeature('cron'), 'cron')
assert.equal(requiredGatewayCapabilityForAgentFeature('kanban'), 'kanban.read')
assert.equal(requiredGatewayCapabilityForAgentFeature('kanban', 'write'), 'kanban.write')
assert.equal(requiredGatewayCapabilityForAgentFeature('kanban', 'execute'), 'kanban.execute')

assert.equal(
  agentFeatureGatewayAvailable({ online: true, capabilities: ['cron'] }, 'cron'),
  true,
)
assert.equal(
  agentFeatureGatewayAvailable({ online: true, capabilities: ['cron'] }, 'kanban'),
  false,
)
assert.equal(
  agentFeatureGatewayAvailable(
    { online: true, capabilities: ['kanban.read', 'kanban.write'] },
    'kanban',
    'write',
  ),
  true,
)
assert.equal(
  agentFeatureGatewayAvailable(
    { online: true, capabilities: ['kanban.read', 'kanban.write'] },
    'kanban',
    'execute',
  ),
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
    'versioned permission-specific feature capability mapping',
    'online Gateway capability required',
    'unadvertised feature remains unavailable',
  ],
}, null, 2))
