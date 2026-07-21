/**
 * Public distribution metadata only. The Router never serves Gateway runtime
 * files: agents load skills from GitHub and install the executable package
 * from npm.
 */
export const gatewayPluginRepositoryUrl =
  'https://github.com/over01470914/hermes-hub-gateway-plugin'

export const gatewayPluginNpmPackage = Object.freeze({
  name: '@over01470914/hermes-hub-gateway',
  version: '0.4.9',
  runtimeManifestSha256: '2814c6b02d472640e683fb5bc1fe93bed402f82516f1b713d41f3963a8674f20',
})

export const gatewayPluginReleaseArtifact = Object.freeze({
  packageName: gatewayPluginNpmPackage.name,
  packageVersion: gatewayPluginNpmPackage.version,
  runtimeManifestSha256: gatewayPluginNpmPackage.runtimeManifestSha256,
})
