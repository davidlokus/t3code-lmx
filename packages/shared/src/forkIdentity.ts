const baseName = "T3 Lab";
const slug = "t3lab";
const developmentSlug = `${slug}-dev`;
const protocol = `${slug}:`;
const developmentProtocol = `${developmentSlug}:`;
const appId = "com.davidlokus.t3lab";
const linuxDesktopId = "com.davidlokus.T3Lab";
const repository = "davidlokus/t3code-lmx";
const stageLabels = { development: "Dev", nightly: "Nightly", release: "Extend" } as const;

export const forkIdentity = {
  baseName,
  stageLabels,
  displayName: `${baseName} (${stageLabels.release})`,
  appId,
  developmentAppId: `${appId}.dev`,
  linuxDesktopId,
  linuxDesktopEntryName: `${linuxDesktopId}.desktop`,
  linuxDevelopmentDesktopEntryName: `${linuxDesktopId}.Development.desktop`,
  homeDirectoryName: `.${slug}`,
  userDataDirectoryName: `${slug}-v2`,
  developmentUserDataDirectoryName: developmentSlug,
  cacheNamespace: slug,
  protocolScheme: slug,
  developmentProtocolScheme: developmentSlug,
  cliCommand: slug,
  windowsCliCommand: `${slug}.cmd`,
  cliShimMarker: `Written by ${baseName}: runs the desktop app's bundled ${slug} CLI.`,
  desktopBackendPort: 3973,
  artifactStem: "T3-Lab-Extend",
  releasesUrl: `https://github.com/${repository}/releases`,
  upstreamUpdateRepository: "pingdotgg/t3code",
} as const;

export function isForkDesktopProtocol(value: string): boolean {
  return value === protocol || value === developmentProtocol;
}
