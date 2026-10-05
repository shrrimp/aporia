import path from 'node:path';
import { brand as defaultBrand, type Brand } from '@app/brand';

export interface Environment {
  readonly platform: NodeJS.Platform;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly home: string;
}

/**
 * Where profiles live. Override with `<PREFIX>_DATA_DIR`; otherwise the OS convention:
 * Linux `$XDG_DATA_HOME` or `~/.local/share`, macOS `~/Library/Application Support`,
 * Windows `%APPDATA%`.
 */
export function dataRoot({ platform, env, home }: Environment, brand: Brand = defaultBrand): string {
  const override = env[`${brand.envPrefix}_DATA_DIR`];
  if (override) return path.resolve(override);
  switch (platform) {
    case 'win32':
      return path.win32.join(env['APPDATA'] ?? path.win32.join(home, 'AppData', 'Roaming'), brand.displayName);
    case 'darwin':
      return path.posix.join(home, 'Library', 'Application Support', brand.displayName);
    default: {
      const xdg = env['XDG_DATA_HOME'];
      return path.posix.join(xdg && path.posix.isAbsolute(xdg) ? xdg : path.posix.join(home, '.local', 'share'), brand.dataDirName);
    }
  }
}
