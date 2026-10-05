// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { splitEmphasis } from '../src/lib/emphasis.ts';
import { Headline } from '../src/lib/Headline.tsx';

describe('splitEmphasis', () => {
  it.each([
    ['Four Numbers, Three Speeds', ['Four Numbers, ', 'Three Speeds']],
    ['Why unit quaternions represent rotations', ['Why unit quaternions represent ', 'rotations']],
    ['Featherstone: the articulated-body algorithm', ['Featherstone: ', 'the articulated-body algorithm']],
    ['Contacts — finally', ['Contacts — ', 'finally']],
    ['Joints - at last', ['Joints - ', 'at last']],
    ['A, then a much longer closing phrase than four words', ['A, then a much longer closing phrase than four ', 'words']],
    ['Quaternions', ['', 'Quaternions']],
    ['  padded title  ', ['padded ', 'title']],
  ])('%s', (title, expected) => {
    expect(splitEmphasis(title)).toEqual(expected);
    expect(splitEmphasis(title).join('')).toBe(title.trim());
  });

  it('renders the closing phrase in the serif italic, keeping the accessible name intact', () => {
    render(<><Headline text="Four Numbers, Three Speeds" /><Headline text="Second level" level={2} /></>);
    expect(screen.getByRole('heading', { level: 1, name: 'Four Numbers, Three Speeds' }).querySelector('em.hl')).toHaveTextContent('Three Speeds');
    expect(screen.getByRole('heading', { level: 2, name: 'Second level' })).toBeInTheDocument();
  });
});
