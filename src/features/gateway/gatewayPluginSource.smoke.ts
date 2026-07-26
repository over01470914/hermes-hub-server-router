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
  version: '0.4.15',
  runtimeManifestSha256: '246e43fa6c9a906c6c73f84661a9957f9352fcd8c20a361e93173963a3dee49b',
})
assert.deepEqual(gatewayPluginReleaseArtifact, {
  packageName: '@over01470914/hermes-hub-gateway',
  packageVersion: '0.4.15',
  runtimeManifestSha256: '246e43fa6c9a906c6c73f84661a9957f9352fcd8c20a361e93173963a3dee49b',
})

console.log('Gateway plugin npm distribution metadata smoke passed.')
