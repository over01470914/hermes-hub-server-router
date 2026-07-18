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
  version: '0.4.3',
  runtimeManifestSha256: '4573d2a0e3dfa9e7cda205b68b384986251c91da1702d60801e4e816b535f41a',
})
assert.deepEqual(gatewayPluginReleaseArtifact, {
  packageName: '@over01470914/hermes-hub-gateway',
  packageVersion: '0.4.3',
  runtimeManifestSha256: '4573d2a0e3dfa9e7cda205b68b384986251c91da1702d60801e4e816b535f41a',
})

console.log('Gateway plugin npm distribution metadata smoke passed.')
