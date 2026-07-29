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
  version: '1.0.1',
  runtimeManifestSha256: '5a4b23be0eae80448f7c874243cbed7075dc0db21bac775f130e168756200caf',
})
assert.deepEqual(gatewayPluginReleaseArtifact, {
  packageName: '@over01470914/hermes-hub-gateway',
  packageVersion: '1.0.1',
  runtimeManifestSha256: '5a4b23be0eae80448f7c874243cbed7075dc0db21bac775f130e168756200caf',
})

console.log('Gateway plugin npm distribution metadata smoke passed.')
