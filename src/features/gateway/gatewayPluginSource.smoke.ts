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
  version: '0.4.8',
  runtimeManifestSha256: 'f6815f0fd4107ad3d67d41226aaf037fd0950e560d3bc36f0775b8f412705fbd',
})
assert.deepEqual(gatewayPluginReleaseArtifact, {
  packageName: '@over01470914/hermes-hub-gateway',
  packageVersion: '0.4.8',
  runtimeManifestSha256: 'f6815f0fd4107ad3d67d41226aaf037fd0950e560d3bc36f0775b8f412705fbd',
})

console.log('Gateway plugin npm distribution metadata smoke passed.')
