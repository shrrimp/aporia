import { BUILTINS } from './expr/builtins.ts';

/** Agent-facing reference for the component catalog. Semantic only: nothing about looks. */
export function catalogGuide(): string {
  const fns = Object.keys(BUILTINS).sort().join(', ');
  return `# Component catalog v1

A lesson: { schemaVersion: 1, catalogVersion: 1, id, title, standfirst, kind: build|theory|review|source-study,
kcs: [kc ids], estimateMin, capability?, sections: [{ id, role, title?, blocks: [component…] }] }
Section roles: warmup, hook, concept, practice, build, exit, open-loop.
Ids are lowercase slugs. KC ids look like "quaternion.exp-map-side".
Text fields use CommonMark + $TeX$ maths + \`code\`. No HTML.

## Reading
- prose { md }
- math { tex, tag? }
- callout { kind: note|trap|key-idea|history|aside, title?, md }
- code { kind: stub|api|layout|analogue|trace|contrast, lang, source, caption?, annotations?: [{line, note}],
  subgoals? (analogue, required), file? (trace, required), variant? + difference? (contrast, required) }
  There is NO solution kind. stub = signature + contract comments + empty/TODO body.
- table { caption?, columns: [..], rows: [[..]] }

## Visuals (expressions in the expression language)
- diagram { dims: 2|3, description, extent (half-width, default 2), elements: [...] }
  elements: point{at,label?} vector{from?,to,label?} segment{from,to} polyline{points:[..],closed?}
  circle{center,radius} (2D) frame{at?,rotation? (quaternion in 3D, angle in 2D),size?,label?}
  box{center?,size (vec3),rotation? (quaternion)} (3D) label{at,text}
  every element has role: primary|secondary|ghost|highlight|correct|incorrect
- plot { description, x: {label,min,max}, y?: {label,min,max}, series: [{label, expr (function of x) | data: [[x,y]..], role}] }

## Interactive
- explorable { description, predictFirst?, state: {name: expr}, controls: [...], readouts: [{label, expr, digits?}], view: diagram|plot }
  controls: slider{name,label,min,max,step,initial?} toggle{name,label,initial?}
            button{label, do: "a = expr; b = expr", role?} play{label, do, fps?} reset{label?}
  Slider/toggle names and state names are variables usable in every expression of the explorable.
  "do" may only assign state variables; play repeats "do" fps times per second (use it for simulations).

## Activities
- drill { purpose: warmup|pretest|practice|exit, confidence (default true), items: [...] }
  item common: id, prompt, kcs, difficulty 1–5 (3 = standard), why, transfer?
  mcq{options, answer (index)} numeric{answer, tolerance?} short{answer (reference)} order{lines (correct order)}
- predict { prompt, options?, reveal, kcs }
- think-first { prompt, reveal }
- explain-back { prompt, kcs, rubric: [points a good answer covers] }
- task { id, title, scaffold 0–4, kcs, files?, goal, contract?, traps?, checkpoint?: { suite, expect: {passed, of} } }
- utility-link { md, prompt? }  open-loop { md }

## Expression language
Numbers, booleans, vectors [a, b, c], quaternions quat(w, x, y, z).
Operators: + - * / ^, comparisons, && || !, cond ? a : b, v.x/.y/.z, v[i], lambdas x -> expr.
Vectors: +, -, scalar *, /. Quaternions: q1 * q2 (Hamilton product), +, -, scalar *.
Constants: pi, e, true, false. iterate(n, x -> f(x), x0) applies f n times (n ≤ 10000).
Functions: ${fns}.
qexp(v) is the rotation by |v| about v (the exponential map of ω·dt); rotate(q, v) = q v q*.
`;
}
