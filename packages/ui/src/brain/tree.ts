import type { BrainDTO } from '@app/server/protocol';

/** The group of skills that have none (or one the map does not describe). */
export const OTHER = '~other';

/**
 * The skill map's groups as a tree: domains at the top (graphics programming, mathematics),
 * areas inside them (Vulkan, shaders), skills in the most specific group. Built defensively: a
 * missing parent makes a group top-level, a loop is cut, and groups without skills are left out.
 */
export interface GroupTree {
  /** Groups that hold at least one skill (nested ones included), in tree order. */
  readonly ids: readonly string[];
  readonly parent: ReadonlyMap<string, string | undefined>;
  /** Children of each group; `undefined` is the root. Sorted by id. */
  readonly children: ReadonlyMap<string | undefined, readonly string[]>;
  readonly title: ReadonlyMap<string, string>;
  /** The group each skill sits in directly (OTHER for skills without one). */
  readonly groupOf: ReadonlyMap<string, string>;
  /** Skills in each group, nested groups included. */
  readonly size: ReadonlyMap<string, number>;
}

export function groupTree(data: Pick<BrainDTO, 'groups' | 'nodes'>): GroupTree {
  const known = new Map(data.groups.map((g) => [g.id, g]));
  const groupOf = new Map(data.nodes.map((n) => [n.id, n.group !== undefined && known.has(n.group) ? n.group : OTHER]));
  // Parents, with loops cut: a group whose chain comes back to itself becomes top-level.
  const parent = new Map<string, string | undefined>();
  for (const g of data.groups) {
    let p = g.parent !== undefined && known.has(g.parent) ? g.parent : undefined;
    const seen = new Set<string>();
    for (let q = p; q !== undefined && !seen.has(q); q = known.get(q)?.parent) {
      if (q === g.id) {
        p = undefined;
        break;
      }
      seen.add(q);
    }
    parent.set(g.id, p);
  }
  const title = new Map(data.groups.map((g) => [g.id, g.title]));
  if ([...groupOf.values()].includes(OTHER)) {
    parent.set(OTHER, undefined);
    title.set(OTHER, 'Other skills');
  }
  const size = new Map<string, number>();
  for (const g of groupOf.values()) {
    for (let q: string | undefined = g, guard = 0; q !== undefined && guard < 64; q = parent.get(q), guard++) size.set(q, (size.get(q) ?? 0) + 1);
  }
  const children = new Map<string | undefined, string[]>();
  for (const [g, p] of parent) {
    if (!size.get(g)) continue;
    children.set(p, [...(children.get(p) ?? []), g]);
  }
  for (const list of children.values()) list.sort((a, b) => (a === OTHER ? 1 : b === OTHER ? -1 : a.localeCompare(b)));
  const ids: string[] = [];
  const walk = (p: string | undefined) => {
    for (const g of children.get(p) ?? []) {
      ids.push(g);
      walk(g);
    }
  };
  walk(undefined);
  return { ids, parent, children, title, groupOf, size };
}

/** A group and the groups it is inside, outermost first. */
export function pathOf(tree: GroupTree, group: string): string[] {
  const out: string[] = [];
  for (let q: string | undefined = group; q !== undefined && out.length < 64; q = tree.parent.get(q)) out.unshift(q);
  return out;
}

/** How deep a group sits (a domain is 1). */
export const depthOf = (tree: GroupTree, group: string) => pathOf(tree, group).length;
