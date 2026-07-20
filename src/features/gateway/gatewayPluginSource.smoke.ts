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
  version: '0.4.6',
  runtimeManifestSha256: '411477b60a7425eb23737ddd6d20ed1a041630c673343febac1ce90e06bfdcbb',
})
assert.deepEqual(gatewayPluginReleaseArtifact, {
  packageName: '@over01470914/hermes-hub-gateway',
  packageVersion: '0.4.6',
  runtimeManifestSha256: '411477b60a7425eb23737ddd6d20ed1a041630c673343febac1ce90e06bfdcbb',
})

console.log('Gateway plugin npm distribution metadata smoke passed.')
