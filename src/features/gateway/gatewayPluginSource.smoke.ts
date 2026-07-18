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
  version: '0.4.4',
  runtimeManifestSha256: 'd7c851eeb620aa62741b478bf61c00cffaa59b570432efa5a8df079b9267b35d',
})
assert.deepEqual(gatewayPluginReleaseArtifact, {
  packageName: '@over01470914/hermes-hub-gateway',
  packageVersion: '0.4.4',
  runtimeManifestSha256: 'd7c851eeb620aa62741b478bf61c00cffaa59b570432efa5a8df079b9267b35d',
})

console.log('Gateway plugin npm distribution metadata smoke passed.')
