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
  version: '0.4.9',
  runtimeManifestSha256: '0cf290dbcacc062cf0ea50fe76485677fe440d320c0a437cdf33a31edbb3dfe8',
})
assert.deepEqual(gatewayPluginReleaseArtifact, {
  packageName: '@over01470914/hermes-hub-gateway',
  packageVersion: '0.4.9',
  runtimeManifestSha256: '0cf290dbcacc062cf0ea50fe76485677fe440d320c0a437cdf33a31edbb3dfe8',
})

console.log('Gateway plugin npm distribution metadata smoke passed.')
