/**
 * Public distribution metadata only. The Router never serves Gateway runtime
 * files: agents load skills from GitHub and install the executable package
 * from npm.
 */
export const gatewayPluginRepositoryUrl =
  'https://github.com/over01470914/hermes-hub-gateway-plugin'

export const gatewayPluginNpmPackage = Object.freeze({
  name: '@over01470914/hermes-hub-gateway',
  version: '0.4.2',
  runtimeManifestSha256: '1944aab29ad73aa344c76d9830f4924d7f152ad890737c80723bc9d1bf316ca4',
})

export const gatewayPluginReleaseArtifact = Object.freeze({
  packageName: gatewayPluginNpmPackage.name,
  packageVersion: gatewayPluginNpmPackage.version,
  runtimeManifestSha256: gatewayPluginNpmPackage.runtimeManifestSha256,
})
