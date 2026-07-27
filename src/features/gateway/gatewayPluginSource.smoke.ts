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
  version: '0.4.15',
  runtimeManifestSha256: 'f7920bbd75eb34d8a3acbaecdab486e82b39d2e76dbae61ee8a4469ad40be55d',
})
assert.deepEqual(gatewayPluginReleaseArtifact, {
  packageName: '@over01470914/hermes-hub-gateway',
  packageVersion: '0.4.15',
  runtimeManifestSha256: 'f7920bbd75eb34d8a3acbaecdab486e82b39d2e76dbae61ee8a4469ad40be55d',
})

console.log('Gateway plugin npm distribution metadata smoke passed.')
