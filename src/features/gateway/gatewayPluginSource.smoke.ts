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
  runtimeManifestSha256: '362e543df38c0d9bb5bb700aeb7e998c0a0656df4942b4f433e1f491c019b0a4',
})
assert.deepEqual(gatewayPluginReleaseArtifact, {
  packageName: '@over01470914/hermes-hub-gateway',
  packageVersion: '0.4.6',
  runtimeManifestSha256: '362e543df38c0d9bb5bb700aeb7e998c0a0656df4942b4f433e1f491c019b0a4',
})

console.log('Gateway plugin npm distribution metadata smoke passed.')
