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
  version: '0.3.0',
  runtimeManifestSha256: 'e328b3ef656adfc9f6ebda71e54083e7457f1c02a44757f269e75f5289775c69',
})
assert.deepEqual(gatewayPluginReleaseArtifact, {
  packageName: '@over01470914/hermes-hub-gateway',
  packageVersion: '0.3.0',
  runtimeManifestSha256: 'e328b3ef656adfc9f6ebda71e54083e7457f1c02a44757f269e75f5289775c69',
})

console.log('Gateway plugin npm distribution metadata smoke passed.')
