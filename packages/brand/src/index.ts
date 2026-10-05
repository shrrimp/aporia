import raw from '../brand.json' with { type: 'json' };

export interface Brand {
  /** Human-facing product name, e.g. in window titles. */
  readonly displayName: string;
  /** Lowercase identifier: CLI command, data folder, bundle extension. */
  readonly id: string;
  readonly tagline: string;
  /** Command-line executable name. */
  readonly cliName: string;
  /** Folder name used under the OS data directory. */
  readonly dataDirName: string;
  /** Extension (with dot) for exported lesson/project bundles. */
  readonly bundleExtension: string;
  /** Prefix for environment variables, e.g. APORIA_DATA_DIR. */
  readonly envPrefix: string;
}

const ID_PATTERN = /^[a-z][a-z0-9-]{1,31}$/;

/** Validates raw brand data and derives every name the app uses. Throws on invalid input. */
export function defineBrand(input: unknown): Brand {
  if (typeof input !== 'object' || input === null) {
    throw new TypeError('brand: expected an object');
  }
  const { displayName, id, tagline } = input as Record<string, unknown>;
  if (typeof displayName !== 'string' || displayName.trim() === '') {
    throw new TypeError('brand: displayName must be a non-empty string');
  }
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) {
    throw new TypeError(`brand: id must match ${ID_PATTERN}`);
  }
  if (typeof tagline !== 'string') {
    throw new TypeError('brand: tagline must be a string');
  }
  return Object.freeze({
    displayName: displayName.trim(),
    id,
    tagline,
    cliName: id,
    dataDirName: id,
    bundleExtension: `.${id}`,
    envPrefix: id.toUpperCase().replaceAll('-', '_'),
  });
}

export const brand: Brand = defineBrand(raw);
