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
  version: '0.4.14',
  runtimeManifestSha256: '74efe5517f687c1fba29a138771d3175e8f127c232cde7a21cdc9a6f8dd09e7c',
})
assert.deepEqual(gatewayPluginReleaseArtifact, {
  packageName: '@over01470914/hermes-hub-gateway',
  packageVersion: '0.4.14',
  runtimeManifestSha256: '74efe5517f687c1fba29a138771d3175e8f127c232cde7a21cdc9a6f8dd09e7c',
})

console.log('Gateway plugin npm distribution metadata smoke passed.')
