// Path translation between Windows and a WSL distro.
//
//   Windows                              WSL
//   C:\dev\proj                    <->   /mnt/c/dev/proj           (Windows drives, via automount root)
//   \\wsl.localhost\Ubuntu\home\u  <->   /home/u                   (the distro's own filesystem)
//   \\wsl$\Ubuntu\home\u            ->   /home/u

export interface WslMount {
  distro: string;
  /** Automount root as reported by `wslpath -u 'C:\'` minus the drive letter, usually "/mnt/". */
  mountRoot: string;
}

function mountPrefix(m: WslMount): string {
  return m.mountRoot.endsWith("/") ? m.mountRoot : m.mountRoot + "/";
}

/** Windows path -> path inside the distro, or undefined if it cannot be reached from there. */
export function winToWsl(p: string, m: WslMount): string | undefined {
  const drive = p.match(/^([A-Za-z]):(?:[\\/](.*))?$/);
  if (drive) {
    const rest = (drive[2] ?? "").replace(/\\/g, "/").replace(/\/+$/, "");
    return `${mountPrefix(m)}${drive[1]!.toLowerCase()}${rest ? "/" + rest : ""}`;
  }
  const unc = p.replace(/\//g, "\\").match(/^\\\\(?:wsl\.localhost|wsl\$)\\([^\\]+)(\\.*)?$/i);
  if (unc && unc[1]!.toLowerCase() === m.distro.toLowerCase()) {
    const rest = (unc[2] ?? "").replace(/\\/g, "/").replace(/\/+$/, "");
    return rest || "/";
  }
  return undefined;
}

/** Path inside the distro -> Windows path. Always possible. */
export function wslToWin(p: string, m: WslMount): string {
  const prefix = mountPrefix(m);
  if (p.startsWith(prefix)) {
    const drive = p.slice(prefix.length).match(/^([a-zA-Z])(?:\/(.*))?$/);
    if (drive) return `${drive[1]!.toUpperCase()}:\\${(drive[2] ?? "").replace(/\//g, "\\")}`;
  }
  const rest = p.replace(/^\/+/, "").replace(/\//g, "\\");
  return `\\\\wsl.localhost\\${m.distro}${rest ? "\\" + rest : ""}`;
}
