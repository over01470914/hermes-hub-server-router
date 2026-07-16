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
  version: '0.3.3',
  runtimeManifestSha256: '6518be796390554d2ea3fe8aa5a5a3a3c66c34c096c4812ccdbfe1ce13ab56b8',
})
assert.deepEqual(gatewayPluginReleaseArtifact, {
  packageName: '@over01470914/hermes-hub-gateway',
  packageVersion: '0.3.3',
  runtimeManifestSha256: '6518be796390554d2ea3fe8aa5a5a3a3c66c34c096c4812ccdbfe1ce13ab56b8',
})

console.log('Gateway plugin npm distribution metadata smoke passed.')
