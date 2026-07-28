/**
 * Public distribution metadata only. The Router never serves Gateway runtime
 * files: agents load skills from GitHub and install the executable package
 * from npm.
 */
export const gatewayPluginRepositoryUrl =
  'https://github.com/over01470914/hermes-hub-gateway-plugin'

export const gatewayPluginNpmPackage = Object.freeze({
  name: '@over01470914/hermes-hub-gateway',
  version: '1.0.1',
  runtimeManifestSha256: '5a4b23be0eae80448f7c874243cbed7075dc0db21bac775f130e168756200caf',
})

export const gatewayPluginReleaseArtifact = Object.freeze({
  packageName: gatewayPluginNpmPackage.name,
  packageVersion: gatewayPluginNpmPackage.version,
  runtimeManifestSha256: gatewayPluginNpmPackage.runtimeManifestSha256,
})
