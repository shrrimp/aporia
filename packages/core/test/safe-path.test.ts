import { mkdir, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { PathEscapeError, isWithin, resolveInside, resolveInsideReal } from '../src/index.ts';
import { tempDir } from './helpers.ts';

describe('resolveInside', () => {
  const root = path.resolve('/data/root');

  it('resolves normal segments', () => {
    expect(resolveInside(root, 'a', 'b/c.json')).toBe(path.join(root, 'a', 'b', 'c.json'));
    expect(resolveInside(root, 'a/../b')).toBe(path.join(root, 'b'));
  });

  it.each([['..'], ['a/../../x'], ['/etc/passwd'], ['C:\\\\x'], ['a\0b'], [''], ['..\\\\..\\\\x']])(
    'rejects %j',
    (seg) => {
      expect(() => resolveInside(root, seg)).toThrow(PathEscapeError);
    },
  );

  it('requires an absolute root', () => {
    expect(() => resolveInside('rel', 'a')).toThrow(PathEscapeError);
  });

  it('never escapes, whatever the input (property)', () => {
    const seg = fc.oneof(
      fc.constantFrom('..', '.', 'a', 'b', '...', '..a', '%2e%2e', '\\..', '~'),
      fc.string({ maxLength: 6 }),
    );
    fc.assert(
      fc.property(fc.array(fc.array(seg, { minLength: 1, maxLength: 4 }).map((s) => s.join('/')), { minLength: 1, maxLength: 3 }), (segs) => {
        try {
          expect(isWithin(root, resolveInside(root, ...segs))).toBe(true);
        } catch (err) {
          expect(err).toBeInstanceOf(PathEscapeError);
        }
      }),
    );
  });
});

describe('resolveInsideReal', () => {
  it('allows symlinks that stay inside and rejects ones that escape', async () => {
    const root = await tempDir();
    const outside = await tempDir();
    await mkdir(path.join(root, 'real'));
    await writeFile(path.join(outside, 'secret.json'), '{}');
    await symlink(path.join(root, 'real'), path.join(root, 'inner'));
    await symlink(outside, path.join(root, 'evil'));

    await expect(resolveInsideReal(root, 'inner', 'new', 'file.json')).resolves.toMatch(/real[/\\]new[/\\]file\.json$/);
    await expect(resolveInsideReal(root, 'evil', 'secret.json')).rejects.toThrow(PathEscapeError);
    await expect(resolveInsideReal(root, 'evil', 'missing', 'x.json')).rejects.toThrow(PathEscapeError);
  });

  it('rethrows unexpected filesystem errors', async () => {
    const root = await tempDir();
    await writeFile(path.join(root, 'file'), 'x');
    await expect(resolveInsideReal(root, 'file', 'child')).rejects.toMatchObject({ code: 'ENOTDIR' });
  });
});
