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
  version: '0.4.0',
  runtimeManifestSha256: '1bfbc7e5f80966f118a35c5e6025746fe33fd94f53fe9bceccc8daf16326015f',
})
assert.deepEqual(gatewayPluginReleaseArtifact, {
  packageName: '@over01470914/hermes-hub-gateway',
  packageVersion: '0.4.0',
  runtimeManifestSha256: '1bfbc7e5f80966f118a35c5e6025746fe33fd94f53fe9bceccc8daf16326015f',
})

console.log('Gateway plugin npm distribution metadata smoke passed.')
