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
  runtimeManifestSha256: 'c06876ea2090c207f3503b6299f73b22134b601a2abe665b4bec55e9f69988e6',
})
assert.deepEqual(gatewayPluginReleaseArtifact, {
  packageName: '@over01470914/hermes-hub-gateway',
  packageVersion: '0.4.9',
  runtimeManifestSha256: 'c06876ea2090c207f3503b6299f73b22134b601a2abe665b4bec55e9f69988e6',
})

console.log('Gateway plugin npm distribution metadata smoke passed.')
