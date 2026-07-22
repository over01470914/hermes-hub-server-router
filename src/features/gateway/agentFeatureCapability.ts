import type { GatewayState } from './gatewayRegistry.js'

/**
 * Stable Router-side capability contract for bridge features. A feature is
 * available only when its bridge grant, this exact Gateway capability, and the
 * feature's own Router operation contract all agree. Adding a capability here
 * never exposes an upstream path by itself.
 */
export const AGENT_FEATURE_GATEWAY_CONTRACT_VERSION = 1

export type AgentFeature = 'cron' | 'kanban'

const requiredGatewayCapabilities: Record<AgentFeature, string> = {
  cron: 'cron',
  // Reserved until Hermes publishes the complete public Kanban read contract.
  kanban: 'kanban.read',
}

export function requiredGatewayCapabilityForAgentFeature(feature: AgentFeature): string {
  return requiredGatewayCapabilities[feature]
}

export function agentFeatureGatewayAvailable(
  gateway: Pick<GatewayState, 'online' | 'capabilities'> | null | undefined,
  feature: AgentFeature,
): boolean {
  const required = requiredGatewayCapabilityForAgentFeature(feature)
  return Boolean(gateway?.online && gateway.capabilities?.includes(required))
}
