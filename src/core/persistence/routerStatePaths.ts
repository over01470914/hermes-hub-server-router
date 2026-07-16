import { fileURLToPath } from 'node:url'
import { join, resolve } from 'node:path'

export interface RouterStatePaths {
  routerRoot: string
  diagnosticsDir: string
  pairingStorePath: string
  sessionMetadataStorePath: string
  nativeConversationStorePath: string
}

/**
 * Resolve mutable Router state from the Router package itself, never from the
 * caller's working directory. The latter differs between the standalone
 * Router checkout and the Hermes Hub monorepo launcher.
 */
export function resolveRouterStatePaths(
  moduleUrl: string,
  environment: NodeJS.ProcessEnv = process.env,
): RouterStatePaths {
  const routerRoot = resolve(fileURLToPath(new URL('../', moduleUrl)))
  const privateStateDir = join(routerRoot, '.hermes-hub-private')

  return {
    routerRoot,
    diagnosticsDir: environment.HERMES_HUB_DIAGNOSTICS_DIR || join(routerRoot, 'diagnostics'),
    pairingStorePath: environment.HERMES_HUB_PAIRING_STORE_PATH || join(privateStateDir, 'pairing-store.json'),
    sessionMetadataStorePath: environment.HERMES_HUB_SESSION_METADATA_STORE_PATH || join(privateStateDir, 'session-metadata.json'),
    nativeConversationStorePath: environment.HERMES_HUB_NATIVE_CONVERSATION_STORE_PATH || join(privateStateDir, 'native-conversations.json'),
  }
}
