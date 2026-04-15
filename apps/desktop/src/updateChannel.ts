const VERSION_PRERELEASE_CHANNEL_PATTERN =
  /^\d+\.\d+\.\d+(?:-([0-9A-Za-z-]+)(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z.-]+)?$/;

function resolvePrereleaseChannel(version: string): string | null {
  const normalizedVersion = version.trim();
  const match = VERSION_PRERELEASE_CHANNEL_PATTERN.exec(normalizedVersion);
  const channel = match?.[1]?.trim().toLowerCase();
  return channel && channel.length > 0 ? channel : null;
}

export function resolveDesktopUpdateChannel(version: string): string {
  return resolvePrereleaseChannel(version) ?? "latest";
}

export function shouldAllowDesktopPrereleaseUpdates(version: string): boolean {
  return resolvePrereleaseChannel(version) !== null;
}

export function shouldAcceptDesktopUpdateForCurrentVersion(
  currentVersion: string,
  candidateVersion: string,
): boolean {
  return (
    resolveDesktopUpdateChannel(currentVersion) === resolveDesktopUpdateChannel(candidateVersion)
  );
}
