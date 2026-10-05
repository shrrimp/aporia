/** One schema step: takes a document at version `from` and returns it at `from + 1`. */
export type Migration = (doc: Record<string, unknown>) => Record<string, unknown>;

export class MigrationError extends Error {
  override readonly name = 'MigrationError';
}

/**
 * Bring `doc` (with a numeric `schemaVersion`) up to `target` by running pure steps in order.
 * `steps[v]` migrates v → v + 1. Documents from a newer app version are refused, never downgraded.
 */
export function migrate(
  doc: Record<string, unknown>,
  target: number,
  steps: Readonly<Record<number, Migration>>,
): Record<string, unknown> {
  let current = doc;
  let version = current['schemaVersion'];
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    throw new MigrationError(`missing or invalid schemaVersion: ${String(version)}`);
  }
  if (version > target) {
    throw new MigrationError(`document is from a newer version (${version} > ${target}); update the app`);
  }
  while (version < target) {
    const step = steps[version];
    if (!step) throw new MigrationError(`no migration from version ${version}`);
    current = { ...step(structuredClone(current)), schemaVersion: version + 1 };
    version += 1;
  }
  return current;
}
