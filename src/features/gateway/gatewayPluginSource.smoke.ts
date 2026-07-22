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
  version: '0.4.13',
  runtimeManifestSha256: '16fb9c2c2b95e1f606d3ca40f351d07c3a40741702797993c307a23b535527ea',
})
assert.deepEqual(gatewayPluginReleaseArtifact, {
  packageName: '@over01470914/hermes-hub-gateway',
  packageVersion: '0.4.13',
  runtimeManifestSha256: '16fb9c2c2b95e1f606d3ca40f351d07c3a40741702797993c307a23b535527ea',
})

console.log('Gateway plugin npm distribution metadata smoke passed.')
