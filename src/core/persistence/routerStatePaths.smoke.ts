import assert from 'node:assert/strict'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveRouterStatePaths } from './routerStatePaths.js'

const routerModuleUrl = new URL('../../bridgeServer.ts', import.meta.url).href
const routerRoot = resolve(fileURLToPath(new URL('../../../', import.meta.url)))
const resolved = resolveRouterStatePaths(routerModuleUrl, {})

assert.equal(resolved.routerRoot, routerRoot)
assert.equal(resolved.pairingStorePath, join(routerRoot, '.hermes-hub-private', 'pairing-store.json'))
assert.equal(resolved.sessionMetadataStorePath, join(routerRoot, '.hermes-hub-private', 'session-metadata.json'))
assert.equal(resolved.diagnosticsDir, join(routerRoot, 'diagnostics'))

const overridden = resolveRouterStatePaths(routerModuleUrl, {
  HERMES_HUB_PAIRING_STORE_PATH: '/private/pairing.json',
  HERMES_HUB_SESSION_METADATA_STORE_PATH: '/private/sessions.json',
  HERMES_HUB_DIAGNOSTICS_DIR: '/private/diagnostics',
})

assert.equal(overridden.pairingStorePath, '/private/pairing.json')
assert.equal(overridden.sessionMetadataStorePath, '/private/sessions.json')
assert.equal(overridden.diagnosticsDir, '/private/diagnostics')

console.log(JSON.stringify({
  ok: true,
  checks: [
    'default mutable Router paths are anchored to the Router package rather than process.cwd()',
    'explicit private path overrides remain supported',
  ],
}, null, 2))
