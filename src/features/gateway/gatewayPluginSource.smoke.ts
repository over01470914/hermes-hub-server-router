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
  version: '0.4.0',
  runtimeManifestSha256: '7d146c5b701928f05a2e2754c25b845e3cf99b2b7970878342354ee38213d30a',
})
assert.deepEqual(gatewayPluginReleaseArtifact, {
  packageName: '@over01470914/hermes-hub-gateway',
  packageVersion: '0.4.0',
  runtimeManifestSha256: '7d146c5b701928f05a2e2754c25b845e3cf99b2b7970878342354ee38213d30a',
})

console.log('Gateway plugin npm distribution metadata smoke passed.')
