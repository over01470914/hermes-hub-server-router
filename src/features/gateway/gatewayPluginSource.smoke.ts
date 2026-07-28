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
  version: '0.4.17',
  runtimeManifestSha256: '6070d58491c441cbdfc9a50fb5b998b9cc30b1926e33974bc1091f5ccdf636d2',
})
assert.deepEqual(gatewayPluginReleaseArtifact, {
  packageName: '@over01470914/hermes-hub-gateway',
  packageVersion: '0.4.17',
  runtimeManifestSha256: '6070d58491c441cbdfc9a50fb5b998b9cc30b1926e33974bc1091f5ccdf636d2',
})

console.log('Gateway plugin npm distribution metadata smoke passed.')
