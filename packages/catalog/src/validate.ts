import { z } from 'zod';
import { lesson as lessonSchema, ICAP, type Component, type Diagram, type Explorable, type Lesson, type Plot } from './schema.ts';
import { stubFindings } from './stub-check.ts';
import { normalizeLesson } from './normalize.ts';
import {
  ExprRuntimeError,
  ExprSyntaxError,
  evaluate,
  freeVariables,
  isNum,
  isQuat,
  isVec,
  parseAssignments,
  parseExpr,
  typeName,
  unknownFunctions,
  type Env,
  type Value,
} from './expr/index.ts';

export interface Problem {
  readonly path: string;
  readonly message: string;
}

export interface ValidationResult {
  /** Present only when there are no errors. */
  readonly lesson?: Lesson;
  /** Must be fixed: the lesson is rejected. */
  readonly errors: readonly Problem[];
  /** Pedagogical composition advice (pedagogy-model §4); the lesson is accepted. */
  readonly warnings: readonly Problem[];
}

const VALIDATION_BUDGET = 200_000;
const MAX_PASSIVE_WORDS = 700;

type Expect = 'number' | 'vector2' | 'vector3' | 'vector' | 'quaternion' | 'any';

class Checker {
  readonly errors: Problem[] = [];
  readonly warnings: Problem[] = [];

  error(path: string, message: string): void {
    this.errors.push({ path, message });
  }
  warn(path: string, message: string): void {
    this.warnings.push({ path, message });
  }

  /** Parse + statically check + evaluate one expression. Returns the value or undefined. */
  expr(path: string, src: string, env: Env, expect: Expect, extraVars: readonly string[] = []): Value | undefined {
    let node;
    try {
      node = parseExpr(src);
    } catch (err) {
      this.error(path, `syntax error in "${src}": ${(err as ExprSyntaxError).message}`);
      return undefined;
    }
    const unknownFns = [...unknownFunctions(node)];
    if (unknownFns.length) {
      this.error(path, `unknown function(s) ${unknownFns.join(', ')} in "${src}"`);
      return undefined;
    }
    const unknownVars = [...freeVariables(node)].filter((v) => !Object.hasOwn(env, v) && !extraVars.includes(v));
    if (unknownVars.length) {
      this.error(path, `unknown variable(s) ${unknownVars.join(', ')} in "${src}"`);
      return undefined;
    }
    const sample: Record<string, Value> = { ...env };
    for (const v of extraVars) sample[v] ??= 0;
    let value: Value;
    try {
      value = evaluate(node, sample, VALIDATION_BUDGET);
    } catch (err) {
      this.error(path, `"${src}" fails: ${(err as ExprRuntimeError).message}`);
      return undefined;
    }
    const ok =
      expect === 'any' ||
      (expect === 'number' && isNum(value)) ||
      (expect === 'quaternion' && isQuat(value)) ||
      (expect === 'vector' && isVec(value)) ||
      (expect === 'vector2' && isVec(value) && value.length === 2) ||
      (expect === 'vector3' && isVec(value) && value.length === 3);
    if (!ok) this.error(path, `"${src}" should be a ${expect}, got ${typeName(value)}`);
    return value;
  }

  diagram(path: string, d: Diagram, env: Env): void {
    const pt: Expect = d.dims === 2 ? 'vector2' : 'vector3';
    d.elements.forEach((e, i) => {
      const p = `${path}.elements[${i}]`;
      switch (e.kind) {
        case 'point':
        case 'label':
          this.expr(`${p}.at`, e.at, env, pt);
          return;
        case 'vector':
          if (e.from) this.expr(`${p}.from`, e.from, env, pt);
          this.expr(`${p}.to`, e.to, env, pt);
          return;
        case 'segment':
          this.expr(`${p}.from`, e.from, env, pt);
          this.expr(`${p}.to`, e.to, env, pt);
          return;
        case 'polyline':
          e.points.forEach((s, j) => this.expr(`${p}.points[${j}]`, s, env, pt));
          return;
        case 'circle':
          if (d.dims !== 2) this.error(p, 'circle is only available in 2D diagrams');
          this.expr(`${p}.center`, e.center, env, pt);
          this.expr(`${p}.radius`, e.radius, env, 'number');
          return;
        case 'frame':
          if (e.at) this.expr(`${p}.at`, e.at, env, pt);
          if (e.rotation) this.expr(`${p}.rotation`, e.rotation, env, d.dims === 3 ? 'quaternion' : 'number');
          return;
        case 'box':
          if (d.dims !== 3) this.error(p, 'box is only available in 3D diagrams');
          if (e.center) this.expr(`${p}.center`, e.center, env, 'vector3');
          this.expr(`${p}.size`, e.size, env, 'vector3');
          if (e.rotation) this.expr(`${p}.rotation`, e.rotation, env, 'quaternion');
          return;
      }
    });
  }

  plot(path: string, pl: Plot, env: Env): void {
    if (!(pl.x.min < pl.x.max)) this.error(`${path}.x`, 'x.min must be less than x.max');
    if (pl.y && !(pl.y.min < pl.y.max)) this.error(`${path}.y`, 'y.min must be less than y.max');
    pl.series.forEach((s, i) => {
      const p = `${path}.series[${i}]`;
      if ((s.expr === undefined) === (s.data === undefined)) {
        this.error(p, 'a series needs exactly one of "expr" or "data"');
        return;
      }
      if (s.expr !== undefined) this.expr(`${p}.expr`, s.expr, { ...env, x: pl.x.min }, 'number');
    });
  }

  explorable(path: string, e: Explorable): void {
    const env: Record<string, Value> = {};
    e.controls.forEach((c, i) => {
      const p = `${path}.controls[${i}]`;
      if (c.kind === 'slider') {
        if (!(c.min < c.max)) this.error(p, 'slider min must be less than max');
        const initial = c.initial ?? c.min;
        if (initial < c.min || initial > c.max) this.error(p, 'slider initial value outside [min, max]');
        env[c.name] = initial;
      } else if (c.kind === 'toggle') env[c.name] = c.initial;
    });
    for (const [name, src] of Object.entries(e.state)) {
      if (Object.hasOwn(env, name)) this.error(`${path}.state.${name}`, `"${name}" is also a control name`);
      const v = this.expr(`${path}.state.${name}`, src, env, 'any');
      if (v !== undefined) env[name] = v;
    }
    if (this.errors.length > 0) return;
    e.controls.forEach((c, i) => {
      if (c.kind !== 'button' && c.kind !== 'play') return;
      const p = `${path}.controls[${i}].do`;
      try {
        for (const a of parseAssignments(c.do)) {
          if (!Object.hasOwn(e.state, a.name)) this.error(p, `can only assign state variables; "${a.name}" is not in state`);
          const unknown = [...freeVariables(a.value)].filter((v) => !Object.hasOwn(env, v));
          if (unknown.length) this.error(p, `unknown variable(s) ${unknown.join(', ')}`);
          const fns = [...unknownFunctions(a.value)];
          if (fns.length) this.error(p, `unknown function(s) ${fns.join(', ')}`);
          if (unknown.length === 0 && fns.length === 0) {
            try {
              const v = evaluate(a.value, env, VALIDATION_BUDGET);
              const before = env[a.name];
              if (before !== undefined && typeName(before) !== typeName(v)) {
                this.error(p, `assigning ${typeName(v)} to "${a.name}" which holds a ${typeName(before)}`);
              }
            } catch (err) {
              this.error(p, `fails: ${(err as Error).message}`);
            }
          }
        }
      } catch (err) {
        this.error(p, `syntax error: ${(err as Error).message}`);
      }
    });
    e.readouts.forEach((r, i) => this.expr(`${path}.readouts[${i}].expr`, r.expr, env, 'any'));
    if (e.view.type === 'diagram') this.diagram(`${path}.view`, e.view, env);
    else this.plot(`${path}.view`, e.view, env);
  }

  component(path: string, c: Component): void {
    switch (c.type) {
      case 'code': {
        if (c.kind === 'stub') {
          for (const f of stubFindings(c.source)) {
            this.error(`${path}.source`, `stub contains implementation at line ${f.line}: "${f.text}". A stub may only declare and describe; the learner writes the body.`);
          }
        }
        if (c.kind === 'trace' && !c.file) this.error(path, 'trace code must name the learner file it walks through ("file")');
        if (c.kind === 'contrast' && (!c.variant || !c.difference)) this.error(path, 'contrast code needs "variant" and "difference"');
        if (c.kind === 'analogue' && !c.subgoals?.length) this.error(path, 'analogue worked examples need subgoal labels ("subgoals")');
        return;
      }
      case 'diagram':
        this.diagram(path, c, {});
        return;
      case 'plot':
        this.plot(path, c, {});
        return;
      case 'explorable':
        this.explorable(path, c);
        return;
      case 'drill':
        c.items.forEach((item, i) => {
          const p = `${path}.items[${i}]`;
          if (item.kind === 'mcq' && item.answer >= item.options.length) this.error(p, 'answer index is out of range');
          if (item.kind === 'order' && new Set(item.lines).size !== item.lines.length) this.error(p, 'order lines must be distinct');
        });
        return;
      default:
        return;
    }
  }

  composition(l: Lesson): void {
    const ids = new Map<string, string>();
    const unique = (id: string, path: string) => {
      if (ids.has(id)) this.error(path, `duplicate id "${id}" (also at ${ids.get(id)})`);
      else ids.set(id, path);
    };
    let constructive = 0;
    l.sections.forEach((s, si) => {
      const sp = `sections[${si}]`;
      unique(s.id, sp);
      let passiveWords = 0;
      let hasVisual = false;
      s.blocks.forEach((b, bi) => {
        const bp = `${sp}.blocks[${bi}]`;
        if (b.type === 'task') unique(b.id, bp);
        if (b.type === 'drill') b.items.forEach((it, ii) => unique(it.id, `${bp}.items[${ii}]`));
        if (b.type === 'diagram' || b.type === 'plot' || b.type === 'explorable') hasVisual = true;
        const kcsUsed = b.type === 'drill' ? b.items.flatMap((it) => it.kcs) : 'kcs' in b ? b.kcs : [];
        for (const k of kcsUsed) if (!l.kcs.includes(k)) this.warn(bp, `KC "${k}" is not listed in the lesson's kcs`);
        if (ICAP[b.type] === 'P') {
          const text = 'md' in b ? b.md : b.type === 'code' ? b.source : '';
          passiveWords += text.split(/\s+/).filter(Boolean).length;
          if (passiveWords > MAX_PASSIVE_WORDS) {
            this.warn(bp, `more than ${MAX_PASSIVE_WORDS} words without an activity; add a predict, drill or explorable (segmenting, P2)`);
            passiveWords = 0;
          }
        } else {
          passiveWords = 0;
          if (ICAP[b.type] === 'C' || ICAP[b.type] === 'I') constructive++;
        }
      });
      if (s.role === 'concept' && !hasVisual) this.warn(sp, 'concept sections should include a diagram, plot or explorable (P2)');
    });
    if (constructive === 0) this.error('sections', 'the lesson has no constructive activity (drill, predict, think-first, explain-back or task)');
    const roles = new Set(l.sections.map((s) => s.role));
    if (!roles.has('warmup')) this.warn('sections', 'no warm-up section: start with 2–4 retrieval items (R1, R3)');
    if (!roles.has('open-loop') && !l.sections.some((s) => s.blocks.some((b) => b.type === 'open-loop'))) {
      this.warn('sections', 'no open loop: end on the next unsolved problem (MO8)');
    }
    const exit = l.sections.filter((s) => s.role === 'exit');
    const transfer = exit.some((s) =>
      s.blocks.some((b) => (b.type === 'drill' && b.items.some((i) => i.transfer)) || b.type === 'explain-back'),
    );
    if (!transfer) this.warn('sections', 'the exit section needs a transfer item or an explain-back (R2)');
  }
}

function formatPath(path: readonly PropertyKey[]): string {
  return path.map((p) => (typeof p === 'number' ? `[${p}]` : `.${String(p)}`)).join('').replace(/^\./, '');
}

/** Validate an agent-authored lesson. Errors reject it; warnings are returned for the agent to consider. */
/** Say which field names the thing, so a model can fix the whole lesson in one go. */
function hint(path: string, message: string): string {
  if (!/discriminator|Invalid input/.test(message)) return message;
  if (/blocks\[\d+\]\.type$/.test(path) || /\.view\.type$/.test(path)) return `${message}. Blocks say what they are with "type", e.g. {"type": "drill", …}`;
  if (/(elements|controls|items)\[\d+\]\.kind$/.test(path)) return `${message}. Diagram elements, explorable controls and drill items use "kind", e.g. {"kind": "vector", …}`;
  return message;
}

export function validateLesson(input: unknown): ValidationResult {
  const parsed = lessonSchema.safeParse(normalizeLesson(input));
  if (!parsed.success) {
    return {
      errors: parsed.error.issues.map((i: z.core.$ZodIssue) => {
        const path = formatPath(i.path);
        return { path, message: hint(path, i.message) };
      }),
      warnings: [],
    };
  }
  const c = new Checker();
  parsed.data.sections.forEach((s, si) => s.blocks.forEach((b, bi) => c.component(`sections[${si}].blocks[${bi}]`, b)));
  c.composition(parsed.data);
  return c.errors.length === 0
    ? { lesson: parsed.data, errors: [], warnings: c.warnings }
    : { errors: c.errors, warnings: c.warnings };
}
