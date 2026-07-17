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
  version: '0.4.1',
  runtimeManifestSha256: '019817f83fef04d10181cbb0f83837405578557fbb2e74cb0a2eba125264703f',
})
assert.deepEqual(gatewayPluginReleaseArtifact, {
  packageName: '@over01470914/hermes-hub-gateway',
  packageVersion: '0.4.1',
  runtimeManifestSha256: '019817f83fef04d10181cbb0f83837405578557fbb2e74cb0a2eba125264703f',
})

console.log('Gateway plugin npm distribution metadata smoke passed.')
