import assert from 'node:assert/strict'

import {
  gatewayPluginNpmPackage,
  gatewayPluginReleaseArtifact,
  gatewayPluginRepositoryUrl,
} from './gatewayPluginSource.js'

assert.equal(
  gatewayPluginRepositoryUrl,
  'https://github.com/over01470914/hermes-hub-gateway-plugin',
)
assert.deepEqual(gatewayPluginNpmPackage, {
  name: '@over01470914/hermes-hub-gateway',
  version: '0.4.14',
  runtimeManifestSha256: 'aaab30e0b4d195ae00751f8d24c3e561f501c827b73d1c0ca18b8defe26c0f62',
})
assert.deepEqual(gatewayPluginReleaseArtifact, {
  packageName: '@over01470914/hermes-hub-gateway',
  packageVersion: '0.4.14',
  runtimeManifestSha256: 'aaab30e0b4d195ae00751f8d24c3e561f501c827b73d1c0ca18b8defe26c0f62',
})

console.log('Gateway plugin npm distribution metadata smoke passed.')
