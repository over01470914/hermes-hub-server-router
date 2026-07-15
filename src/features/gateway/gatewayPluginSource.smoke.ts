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
  version: '0.3.0',
  runtimeManifestSha256: '2230cd5021cc4fcc7a9c583c93be96775ffe93148fda8d0e5e4e28457d12792f',
})
assert.deepEqual(gatewayPluginReleaseArtifact, {
  packageName: '@over01470914/hermes-hub-gateway',
  packageVersion: '0.3.0',
  runtimeManifestSha256: '2230cd5021cc4fcc7a9c583c93be96775ffe93148fda8d0e5e4e28457d12792f',
})

console.log('Gateway plugin npm distribution metadata smoke passed.')
