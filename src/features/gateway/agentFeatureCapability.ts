import type { GatewayState } from './gatewayRegistry.js'

/**
 * Stable Router-side capability contract for bridge features. A feature is
 * available only when its bridge grant, this exact Gateway capability, and the
 * feature's own Router operation contract all agree. Adding a capability here
 * never exposes an upstream path by itself.
 */
export const AGENT_FEATURE_GATEWAY_CONTRACT_VERSION = 2

export type AgentFeature = 'cron' | 'kanban'
export type AgentFeaturePermission = 'read' | 'write' | 'execute'

const requiredGatewayCapabilities: Record<
  AgentFeature,
  Record<AgentFeaturePermission, string>
> = {
  // Cron remains an atomic Gateway capability. It is advertised only when the
  // Agent publishes jobs_admin plus the complete CRUD, action and history
  // endpoint set; bridge-token permissions still split read/write/execute.
  cron: { read: 'cron', write: 'cron', execute: 'cron' },
  kanban: {
    read: 'kanban.read',
    write: 'kanban.write',
    execute: 'kanban.execute',
  },
}

export function requiredGatewayCapabilityForAgentFeature(
  feature: AgentFeature,
  permission: AgentFeaturePermission = 'read',
): string {
  return requiredGatewayCapabilities[feature][permission]
}

export function agentFeatureGatewayAvailable(
  gateway: Pick<GatewayState, 'online' | 'capabilities'> | null | undefined,
  feature: AgentFeature,
  permission: AgentFeaturePermission = 'read',
): boolean {
  const required = requiredGatewayCapabilityForAgentFeature(feature, permission)
  return Boolean(gateway?.online && gateway.capabilities?.includes(required))
}
