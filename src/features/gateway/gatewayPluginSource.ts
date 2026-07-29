import { createHash } from 'node:crypto'
import { lstatSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'

/**
 * Public distribution metadata only. The Router never serves Gateway runtime
 * files: agents load skills from GitHub and install the executable package
 * from npm.
 */
export const gatewayPluginRepositoryUrl =
  'https://github.com/over01470914/hermes-hub-gateway-plugin'

const RELEASE_METADATA_SCHEMA = 'hermes-hub-gateway-release-metadata/v1'
const RELEASE_METADATA_MAX_BYTES = 16 * 1024
const PACKAGE_MANIFEST_MAX_BYTES = 64 * 1024

export interface GatewayPluginReleaseArtifact {
  packageName: string
  packageVersion: string
  runtimeManifestSha256: string
}

function exactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index])
}

function isRegularFileWithin(path: string, maximumBytes: number): boolean {
  const stat = lstatSync(path)
  return stat.isFile() && !stat.isSymbolicLink() && stat.size > 0 && stat.size <= maximumBytes
}

function parseReleaseMetadata(bytes: Buffer): GatewayPluginReleaseArtifact | undefined {
  let value: unknown
  try {
    value = JSON.parse(bytes.toString('utf8'))
  } catch {
    return undefined
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  if (!exactKeys(record, ['schema', 'packageName', 'packageVersion', 'runtimeManifestSha256'])) return undefined
  if (record.schema !== RELEASE_METADATA_SCHEMA) return undefined
  if (typeof record.packageName !== 'string' || !/^@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/.test(record.packageName)) {
    return undefined
  }
  if (typeof record.packageVersion !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(record.packageVersion)) {
    return undefined
  }
  if (typeof record.runtimeManifestSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(record.runtimeManifestSha256)) {
    return undefined
  }
  return {
    packageName: record.packageName,
    packageVersion: record.packageVersion,
    runtimeManifestSha256: record.runtimeManifestSha256,
  }
}

/**
 * Loads installer-managed Gateway release metadata for the health surface.
 * This is intentionally advisory: no file error escapes Router import or
 * startup, and only a matching sibling package-manifest is trusted.
 */
export function readGatewayPluginReleaseArtifact(
  metadataPath = process.env.HERMES_HUB_GATEWAY_RELEASE_METADATA_PATH || '',
): GatewayPluginReleaseArtifact | undefined {
  if (!metadataPath || !isAbsolute(metadataPath)) return undefined
  try {
    if (!isRegularFileWithin(metadataPath, RELEASE_METADATA_MAX_BYTES)) return undefined
    const release = parseReleaseMetadata(readFileSync(metadataPath))
    if (!release) return undefined

    const manifestPath = join(dirname(metadataPath), 'package-manifest.json')
    if (!isRegularFileWithin(manifestPath, PACKAGE_MANIFEST_MAX_BYTES)) return undefined
    const manifestSha256 = createHash('sha256').update(readFileSync(manifestPath)).digest('hex')
    return manifestSha256 === release.runtimeManifestSha256 ? release : undefined
  } catch {
    return undefined
  }
}
