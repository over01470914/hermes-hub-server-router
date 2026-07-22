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
  runtimeManifestSha256: 'a268d2dd066a140105e72fba6493ea5047a7875529c492807c2c90cbb8f479c1',
})
assert.deepEqual(gatewayPluginReleaseArtifact, {
  packageName: '@over01470914/hermes-hub-gateway',
  packageVersion: '0.4.14',
  runtimeManifestSha256: 'a268d2dd066a140105e72fba6493ea5047a7875529c492807c2c90cbb8f479c1',
})

console.log('Gateway plugin npm distribution metadata smoke passed.')
