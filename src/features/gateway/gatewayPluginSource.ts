/**
 * Public distribution metadata only. The Router never serves Gateway runtime
 * files: agents load skills from GitHub and install the executable package
 * from npm.
 */
export const gatewayPluginRepositoryUrl =
  'https://github.com/over01470914/hermes-hub-gateway-plugin'

export const gatewayPluginNpmPackage = Object.freeze({
  name: '@over01470914/hermes-hub-gateway',
  version: '0.4.1',
  runtimeManifestSha256: '019817f83fef04d10181cbb0f83837405578557fbb2e74cb0a2eba125264703f',
})

export const gatewayPluginReleaseArtifact = Object.freeze({
  packageName: gatewayPluginNpmPackage.name,
  packageVersion: gatewayPluginNpmPackage.version,
  runtimeManifestSha256: gatewayPluginNpmPackage.runtimeManifestSha256,
})
