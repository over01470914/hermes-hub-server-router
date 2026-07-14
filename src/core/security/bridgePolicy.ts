import type { BridgeTokenPayload } from './bridgeAuth.js'

export function requireGatewayBoundBridge(
  payload: Pick<BridgeTokenPayload, 'hermesAgentId' | 'deviceId'>,
): void {
  if (!payload.hermesAgentId) throw new Error('Bridge token must be Hermes Agent-bound')
  if (!payload.deviceId) throw new Error('Bridge token must be device-bound')
}
