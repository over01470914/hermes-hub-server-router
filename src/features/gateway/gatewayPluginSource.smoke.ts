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
  runtimeManifestSha256: '868ae2403b68e31ea54c73e9af1d423be2821e3caf7aabcc877f1e0fae90099a',
})
assert.deepEqual(gatewayPluginReleaseArtifact, {
  packageName: '@over01470914/hermes-hub-gateway',
  packageVersion: '0.4.6',
  runtimeManifestSha256: '868ae2403b68e31ea54c73e9af1d423be2821e3caf7aabcc877f1e0fae90099a',
})

console.log('Gateway plugin npm distribution metadata smoke passed.')
