import { describe, expect, it } from 'vitest';
import { brand, defineBrand } from '../src/index.ts';

describe('defineBrand', () => {
  it('derives every name from the id', () => {
    const b = defineBrand({ displayName: ' Foo Bar ', id: 'foo-bar', tagline: 't' });
    expect(b).toEqual({
      displayName: 'Foo Bar',
      id: 'foo-bar',
      tagline: 't',
      cliName: 'foo-bar',
      dataDirName: 'foo-bar',
      bundleExtension: '.foo-bar',
      envPrefix: 'FOO_BAR',
    });
    expect(Object.isFrozen(b)).toBe(true);
  });

  it.each([
    [null, 'expected an object'],
    ['x', 'expected an object'],
    [{ displayName: '', id: 'ok', tagline: '' }, 'displayName'],
    [{ displayName: 3, id: 'ok', tagline: '' }, 'displayName'],
    [{ displayName: 'A', id: 'Bad', tagline: '' }, 'id must match'],
    [{ displayName: 'A', id: 'a', tagline: '' }, 'id must match'],
    [{ displayName: 'A', id: '1abc', tagline: '' }, 'id must match'],
    [{ displayName: 'A', id: 'a/../b', tagline: '' }, 'id must match'],
    [{ displayName: 'A', id: 'ok', tagline: 5 }, 'tagline'],
  ])('rejects %j', (input, message) => {
    expect(() => defineBrand(input)).toThrow(message);
  });

  it('loads the shipped brand file', () => {
    expect(brand.id).toMatch(/^[a-z]/);
    expect(brand.bundleExtension).toBe(`.${brand.id}`);
  });
});
