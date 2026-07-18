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
  version: '0.4.5',
  runtimeManifestSha256: '83d15eacf087212df860a90d2b76c2d7e7f77112a4fd0853a758e5a7a44a92aa',
})
assert.deepEqual(gatewayPluginReleaseArtifact, {
  packageName: '@over01470914/hermes-hub-gateway',
  packageVersion: '0.4.5',
  runtimeManifestSha256: '83d15eacf087212df860a90d2b76c2d7e7f77112a4fd0853a758e5a7a44a92aa',
})

console.log('Gateway plugin npm distribution metadata smoke passed.')
