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
  version: '0.3.1',
  runtimeManifestSha256: '6fc8e4db86875c75191ae1a31a3fbf3f0d112cc429feb6eb682e6cf70cd323e6',
})
assert.deepEqual(gatewayPluginReleaseArtifact, {
  packageName: '@over01470914/hermes-hub-gateway',
  packageVersion: '0.3.1',
  runtimeManifestSha256: '6fc8e4db86875c75191ae1a31a3fbf3f0d112cc429feb6eb682e6cf70cd323e6',
})

console.log('Gateway plugin npm distribution metadata smoke passed.')
