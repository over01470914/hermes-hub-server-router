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
  runtimeManifestSha256: '0546a90a86fa3141811d96e6182aa0b9175fc0b5d121cb32cd78f559f81eb915',
})
assert.deepEqual(gatewayPluginReleaseArtifact, {
  packageName: '@over01470914/hermes-hub-gateway',
  packageVersion: '0.4.0',
  runtimeManifestSha256: '0546a90a86fa3141811d96e6182aa0b9175fc0b5d121cb32cd78f559f81eb915',
})

console.log('Gateway plugin npm distribution metadata smoke passed.')
