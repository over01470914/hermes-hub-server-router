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
  version: '0.4.12',
  runtimeManifestSha256: 'd5d4e48ac852cc20f966f4ebbc7a00f4530beda2bd09dea780a764fbf233c50c',
})
assert.deepEqual(gatewayPluginReleaseArtifact, {
  packageName: '@over01470914/hermes-hub-gateway',
  packageVersion: '0.4.12',
  runtimeManifestSha256: 'd5d4e48ac852cc20f966f4ebbc7a00f4530beda2bd09dea780a764fbf233c50c',
})

console.log('Gateway plugin npm distribution metadata smoke passed.')
