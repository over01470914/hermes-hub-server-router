/**
 * Public distribution metadata only. The Router never serves Gateway runtime
 * files: agents load skills from GitHub and install the executable package
 * from npm.
 */
export const gatewayPluginRepositoryUrl =
  'https://github.com/over01470914/hermes-hub-gateway-plugin'

export const gatewayPluginNpmPackage = Object.freeze({
  name: '@over01470914/hermes-hub-gateway',
  version: '0.4.0',
  runtimeManifestSha256: '0546a90a86fa3141811d96e6182aa0b9175fc0b5d121cb32cd78f559f81eb915',
})

export const gatewayPluginReleaseArtifact = Object.freeze({
  packageName: gatewayPluginNpmPackage.name,
  packageVersion: gatewayPluginNpmPackage.version,
  runtimeManifestSha256: gatewayPluginNpmPackage.runtimeManifestSha256,
})
