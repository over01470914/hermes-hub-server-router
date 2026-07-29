import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Public distribution metadata only. The Router never serves Gateway runtime
 * files: agents load skills from GitHub and install the executable package
 * from npm.
 */
export const gatewayPluginRepositoryUrl =
  'https://github.com/over01470914/hermes-hub-gateway-plugin'

type JsonRecord = Record<string, unknown>

export type GatewayPluginReleaseMetadataPaths = Readonly<{
  runtimeManifestPath?: string
  pairingReleasePath?: string
}>

export type GatewayPluginReleaseMetadata = Readonly<{
  npmPackage: Readonly<{
    name: string
    version: string
    runtimeManifestSha256: string
  }>
  releaseArtifact: Readonly<{
    packageName: string
    packageVersion: string
    runtimeManifestSha256: string
  }>
}>

const routerSourceDirectory = dirname(fileURLToPath(import.meta.url))
const repositoryRoot = resolve(routerSourceDirectory, '../../../../../')
const defaultRuntimeManifestPath = join(
  repositoryRoot,
  'apps',
  'hermes-hub-gateway-npm',
  'runtime',
  'package-manifest.json',
)
const defaultPairingReleasePath = join(
  repositoryRoot,
  'apps',
  'hermes-hub-gateway-npm',
  'src',
  'pairing-core',
  'references',
  'release.json',
)
const sha256Pattern = /^[a-f0-9]{64}$/
const packageNamePattern = /^@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/

function sha256(value: Buffer) {
  return createHash('sha256').update(value).digest('hex')
}

function isJsonRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requireExactKeys(value: JsonRecord, label: string, keys: readonly string[]) {
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} must contain exactly ${keys.join(', ')}`)
  }
}

function parseJson(bytes: Buffer, label: string): unknown {
  try {
    return JSON.parse(bytes.toString('utf8'))
  } catch {
    throw new Error(`${label} must be valid JSON`)
  }
}

function readJsonFile(path: string, label: string) {
  try {
    return readFileSync(path)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`could not read ${label} at ${path}: ${detail}`)
  }
}

function parseRuntimeManifest(bytes: Buffer) {
  const value = parseJson(bytes, 'runtime manifest')
  if (!isJsonRecord(value)) throw new Error('runtime manifest must be a JSON object')
  requireExactKeys(value, 'runtime manifest', ['schema', 'version', 'files'])
  if (value.schema !== 'hermes-hub-gateway-package/v1') {
    throw new Error('runtime manifest schema is unsupported')
  }
  if (typeof value.version !== 'string' || !versionPattern.test(value.version)) {
    throw new Error('runtime manifest version must be a publishable SemVer version')
  }
  if (!Array.isArray(value.files)) throw new Error('runtime manifest files must be an array')
  for (const entry of value.files) {
    if (!isJsonRecord(entry)) throw new Error('runtime manifest file entry must be an object')
    requireExactKeys(entry, 'runtime manifest file entry', ['name', 'bytes', 'sha256'])
    if (
      typeof entry.name !== 'string' ||
      !entry.name ||
      typeof entry.bytes !== 'number' ||
      !Number.isSafeInteger(entry.bytes) ||
      entry.bytes < 0 ||
      typeof entry.sha256 !== 'string' ||
      !sha256Pattern.test(entry.sha256)
    ) {
      throw new Error('runtime manifest file entry has invalid fields')
    }
  }
  return { version: value.version }
}

function parsePairingRelease(bytes: Buffer) {
  const value = parseJson(bytes, 'pairing release')
  if (!isJsonRecord(value)) throw new Error('pairing release must be a JSON object')
  requireExactKeys(value, 'pairing release', [
    'packageName',
    'packageVersion',
    'runtimeManifestSha256',
  ])
  if (typeof value.packageName !== 'string' || !packageNamePattern.test(value.packageName)) {
    throw new Error('pairing release packageName must be a scoped npm package name')
  }
  if (typeof value.packageVersion !== 'string' || !versionPattern.test(value.packageVersion)) {
    throw new Error('pairing release packageVersion must be a publishable SemVer version')
  }
  if (
    typeof value.runtimeManifestSha256 !== 'string' ||
    !sha256Pattern.test(value.runtimeManifestSha256)
  ) {
    throw new Error('pairing release runtimeManifestSha256 must be a lowercase SHA-256 digest')
  }
  return {
    packageName: value.packageName,
    packageVersion: value.packageVersion,
    runtimeManifestSha256: value.runtimeManifestSha256,
  }
}

export function loadGatewayPluginReleaseMetadata(
  paths: GatewayPluginReleaseMetadataPaths = {},
): GatewayPluginReleaseMetadata {
  try {
    const runtimeManifestBytes = readJsonFile(
      paths.runtimeManifestPath || defaultRuntimeManifestPath,
      'runtime manifest',
    )
    const pairingReleaseBytes = readJsonFile(
      paths.pairingReleasePath || defaultPairingReleasePath,
      'pairing release',
    )
    const manifest = parseRuntimeManifest(runtimeManifestBytes)
    const release = parsePairingRelease(pairingReleaseBytes)
    const runtimeManifestSha256 = sha256(runtimeManifestBytes)

    if (release.packageVersion !== manifest.version) {
      throw new Error('pairing release packageVersion does not match runtime manifest version')
    }
    if (release.runtimeManifestSha256 !== runtimeManifestSha256) {
      throw new Error('pairing release runtimeManifestSha256 does not match runtime manifest bytes')
    }

    const npmPackage = Object.freeze({
      name: release.packageName,
      version: release.packageVersion,
      runtimeManifestSha256,
    })
    return Object.freeze({
      npmPackage,
      releaseArtifact: Object.freeze({
        packageName: release.packageName,
        packageVersion: release.packageVersion,
        runtimeManifestSha256,
      }),
    })
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`Gateway release metadata is invalid: ${detail}`)
  }
}

const gatewayPluginReleaseMetadata = loadGatewayPluginReleaseMetadata()

export const gatewayPluginNpmPackage = gatewayPluginReleaseMetadata.npmPackage

export const gatewayPluginReleaseArtifact = gatewayPluginReleaseMetadata.releaseArtifact
