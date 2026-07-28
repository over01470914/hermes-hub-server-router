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
  version: '1.0.0',
  runtimeManifestSha256: 'bd3c29495053ca88b591be8f34787a8951d1b14981537948e45397a4bd9166c5',
})
assert.deepEqual(gatewayPluginReleaseArtifact, {
  packageName: '@over01470914/hermes-hub-gateway',
  packageVersion: '1.0.0',
  runtimeManifestSha256: 'bd3c29495053ca88b591be8f34787a8951d1b14981537948e45397a4bd9166c5',
})

console.log('Gateway plugin npm distribution metadata smoke passed.')
