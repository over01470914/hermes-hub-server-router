import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  gatewayPluginRepositoryUrl,
  readGatewayPluginReleaseArtifact,
} from './gatewayPluginSource.js'

assert.equal(
  gatewayPluginRepositoryUrl,
  'https://github.com/over01470914/hermes-hub-gateway-plugin',
)

const routerRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const gatewayPackageRoot = join(routerRoot, '..', 'hermes-hub-gateway-npm')
const manifestBytes = await readFile(join(gatewayPackageRoot, 'runtime', 'package-manifest.json'))
const release = JSON.parse(
  await readFile(join(gatewayPackageRoot, 'src', 'pairing-core', 'references', 'release.json'), 'utf8'),
)
const metadata = {
  schema: 'hermes-hub-gateway-release-metadata/v1',
  ...release,
}
const metadataDirectory = await mkdtemp(join(tmpdir(), 'hermes-hub-gateway-release-metadata-'))
const metadataPath = join(metadataDirectory, 'gateway-release-metadata.json')
const manifestPath = join(metadataDirectory, 'package-manifest.json')

try {
  await writeFile(manifestPath, manifestBytes)
  await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`)
  assert.deepEqual(readGatewayPluginReleaseArtifact(metadataPath), release)

  await writeFile(metadataPath, '{not-json')
  assert.equal(readGatewayPluginReleaseArtifact(metadataPath), undefined)

  await writeFile(metadataPath, `${JSON.stringify({
    ...metadata,
    runtimeManifestSha256: createHash('sha256').update('different manifest bytes').digest('hex'),
  }, null, 2)}\n`)
  assert.equal(readGatewayPluginReleaseArtifact(metadataPath), undefined)

  for (const invalidMetadata of [
    { ...metadata, schema: 'hermes-hub-gateway-release-metadata/v0' },
    { ...metadata, packageName: 'hermes-hub-gateway' },
    { ...metadata, packageVersion: 'not-semver' },
    { ...metadata, unexpected: true },
  ]) {
    await writeFile(metadataPath, `${JSON.stringify(invalidMetadata, null, 2)}\n`)
    assert.equal(readGatewayPluginReleaseArtifact(metadataPath), undefined)
  }

  await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`)
  await writeFile(manifestPath, '{invalid-manifest')
  assert.equal(readGatewayPluginReleaseArtifact(metadataPath), undefined)

  assert.equal(readGatewayPluginReleaseArtifact(join(metadataDirectory, 'missing.json')), undefined)
} finally {
  await rm(metadataDirectory, { recursive: true, force: true })
}

console.log('Gateway plugin npm distribution metadata smoke passed.')
