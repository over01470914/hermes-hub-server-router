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
  version: '0.4.7',
  runtimeManifestSha256: 'b336d76ecc14ef6ad63c255a9e0b4f6bae8c0d9d5aa846656c31bc58901a2565',
})
assert.deepEqual(gatewayPluginReleaseArtifact, {
  packageName: '@over01470914/hermes-hub-gateway',
  packageVersion: '0.4.7',
  runtimeManifestSha256: 'b336d76ecc14ef6ad63c255a9e0b4f6bae8c0d9d5aa846656c31bc58901a2565',
})

console.log('Gateway plugin npm distribution metadata smoke passed.')
