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
  version: '0.4.9',
  runtimeManifestSha256: '2814c6b02d472640e683fb5bc1fe93bed402f82516f1b713d41f3963a8674f20',
})
assert.deepEqual(gatewayPluginReleaseArtifact, {
  packageName: '@over01470914/hermes-hub-gateway',
  packageVersion: '0.4.9',
  runtimeManifestSha256: '2814c6b02d472640e683fb5bc1fe93bed402f82516f1b713d41f3963a8674f20',
})

console.log('Gateway plugin npm distribution metadata smoke passed.')
