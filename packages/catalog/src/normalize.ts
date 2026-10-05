/**
 * Forgiving input: lessons name what a block is with `type`, and what a diagram element,
 * control or drill item is with `kind`. Models mix the two up, and nothing is gained by
 * rejecting a whole lesson for it, so this swaps a misnamed discriminator back before
 * validation. Only exact, known values are moved; nothing else is touched.
 */
const COMPONENTS = new Set([
  'prose', 'math', 'callout', 'code', 'table', 'diagram', 'plot', 'explorable', 'drill',
  'predict', 'think-first', 'explain-back', 'task', 'open-loop', 'utility-link',
]);
const ELEMENTS = new Set(['point', 'vector', 'segment', 'polyline', 'circle', 'frame', 'box', 'label']);
const CONTROLS = new Set(['slider', 'toggle', 'button', 'play', 'reset']);
const ITEMS = new Set(['mcq', 'numeric', 'short', 'order']);

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Rename `from` → `to` when `to` is missing and the value names one of `allowed`. */
function swap(o: Obj, from: string, to: string, allowed: ReadonlySet<string>): Obj {
  if (o[to] !== undefined || typeof o[from] !== 'string' || !allowed.has(o[from] as string)) return o;
  const { [from]: value, ...rest } = o;
  return { [to]: value, ...rest };
}

const mapArray = (v: unknown, f: (o: Obj) => Obj): unknown => (Array.isArray(v) ? v.map((x) => (isObj(x) ? f(x) : x)) : v);

function normalizeView(v: Obj): Obj {
  const o = swap(v, 'kind', 'type', COMPONENTS);
  return 'elements' in o ? { ...o, elements: mapArray(o['elements'], (e) => swap(e, 'type', 'kind', ELEMENTS)) } : o;
}

function normalizeBlock(b: Obj): Obj {
  let o = normalizeView(b);
  if ('controls' in o) o = { ...o, controls: mapArray(o['controls'], (c) => swap(c, 'type', 'kind', CONTROLS)) };
  if (isObj(o['view'])) o = { ...o, view: normalizeView(o['view']) };
  if (o['type'] === 'drill') o = { ...o, items: mapArray(o['items'], (i) => swap(i, 'type', 'kind', ITEMS)) };
  return o;
}

export function normalizeLesson(input: unknown): unknown {
  if (!isObj(input) || !Array.isArray(input['sections'])) return input;
  return {
    ...input,
    sections: input['sections'].map((s) => (isObj(s) ? { ...s, blocks: mapArray(s['blocks'], normalizeBlock) } : s)),
  };
}
