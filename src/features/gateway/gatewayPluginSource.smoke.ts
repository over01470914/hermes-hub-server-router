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
  version: '0.4.2',
  runtimeManifestSha256: '1944aab29ad73aa344c76d9830f4924d7f152ad890737c80723bc9d1bf316ca4',
})
assert.deepEqual(gatewayPluginReleaseArtifact, {
  packageName: '@over01470914/hermes-hub-gateway',
  packageVersion: '0.4.2',
  runtimeManifestSha256: '1944aab29ad73aa344c76d9830f4924d7f152ad890737c80723bc9d1bf316ca4',
})

console.log('Gateway plugin npm distribution metadata smoke passed.')
