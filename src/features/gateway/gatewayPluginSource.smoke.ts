import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  gatewayPluginNpmPackage,
  gatewayPluginReleaseArtifact,
  gatewayPluginRepositoryUrl,
  loadGatewayPluginReleaseMetadata,
} from './gatewayPluginSource.js'

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')

assert.equal(
  gatewayPluginRepositoryUrl,
  'https://github.com/over01470914/hermes-hub-gateway-plugin',
)

const directory = await mkdtemp(join(tmpdir(), 'hermes-hub-gateway-plugin-source-'))
const runtimeManifestPath = join(directory, 'package-manifest.json')
const pairingReleasePath = join(directory, 'release.json')
const fixtureVersion = [9, 8, 7].join('.')

try {
  const manifestText = `${JSON.stringify({
    schema: 'hermes-hub-gateway-package/v1',
    version: fixtureVersion,
    files: [{ name: 'adapter.py', bytes: 1, sha256: 'a'.repeat(64) }],
  }, null, 2)}\n`
  const runtimeManifestSha256 = sha256(manifestText)
  const release = {
    packageName: '@example/hermes-hub-gateway',
    packageVersion: fixtureVersion,
    runtimeManifestSha256,
  }

  await writeFile(runtimeManifestPath, manifestText, 'utf8')
  await writeFile(pairingReleasePath, `${JSON.stringify(release, null, 2)}\n`, 'utf8')

  const loaded = loadGatewayPluginReleaseMetadata({ runtimeManifestPath, pairingReleasePath })
  assert.deepEqual(loaded.npmPackage, {
    name: release.packageName,
    version: release.packageVersion,
    runtimeManifestSha256,
  })
  assert.deepEqual(loaded.releaseArtifact, {
    packageName: release.packageName,
    packageVersion: release.packageVersion,
    runtimeManifestSha256,
  })

  assert.equal(gatewayPluginNpmPackage.name, gatewayPluginReleaseArtifact.packageName)
  assert.equal(gatewayPluginNpmPackage.version, gatewayPluginReleaseArtifact.packageVersion)
  assert.equal(
    gatewayPluginNpmPackage.runtimeManifestSha256,
    gatewayPluginReleaseArtifact.runtimeManifestSha256,
  )

  await writeFile(pairingReleasePath, '{"packageName":"@example/hermes-hub-gateway"}\n', 'utf8')
  assert.throws(
    () => loadGatewayPluginReleaseMetadata({ runtimeManifestPath, pairingReleasePath }),
    /Gateway release metadata is invalid: pairing release must contain exactly packageName, packageVersion, runtimeManifestSha256/,
  )

  await writeFile(
    pairingReleasePath,
    `${JSON.stringify({ ...release, runtimeManifestSha256: '0'.repeat(64) }, null, 2)}\n`,
    'utf8',
  )
  assert.throws(
    () => loadGatewayPluginReleaseMetadata({ runtimeManifestPath, pairingReleasePath }),
    /Gateway release metadata is invalid: pairing release runtimeManifestSha256 does not match runtime manifest bytes/,
  )

  await writeFile(pairingReleasePath, `${JSON.stringify(release, null, 2)}\n`, 'utf8')
  await writeFile(runtimeManifestPath, '{"schema":"hermes-hub-gateway-package/v1"}\n', 'utf8')
  assert.throws(
    () => loadGatewayPluginReleaseMetadata({ runtimeManifestPath, pairingReleasePath }),
    /Gateway release metadata is invalid: runtime manifest must contain exactly schema, version, files/,
  )
} finally {
  await rm(directory, { recursive: true, force: true })
}

console.log('Gateway plugin npm distribution metadata smoke passed.')
