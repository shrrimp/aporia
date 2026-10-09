import { BUILTINS } from './expr/builtins.ts';

const EXAMPLE = {
  schemaVersion: 1,
  catalogVersion: 1,
  id: 'example-unit-length',
  title: 'Why |q| must be 1',
  standfirst: 'A rotation quaternion has length one. Here is what breaks when it does not.',
  kind: 'theory',
  kcs: ['quaternion.unit'],
  estimateMin: 10,
  sections: [
    { id: 'warmup', role: 'warmup', blocks: [{ type: 'drill', purpose: 'warmup', items: [{ id: 'w1', kind: 'mcq', prompt: 'What is $|q|$ for a rotation?', options: ['0', '1', 'any'], answer: 1, kcs: ['quaternion.unit'], difficulty: 2, why: 'Only unit quaternions are rotations.' }] }] },
    {
      id: 'idea',
      role: 'concept',
      blocks: [
        { type: 'prose', md: 'Scaling $q$ by $s$ scales $q\\,v\\,q^*$ by $s^2$.' },
        { type: 'explorable', description: 'A vector rotated by a scaled quaternion', controls: [{ kind: 'slider', name: 's', label: 'scale s', min: 0.5, max: 1.5, step: 0.05, initial: 1 }], readouts: [{ label: '|q|', expr: 's' }], view: { type: 'diagram', dims: 2, description: 'v and its image', elements: [{ kind: 'vector', to: '[1, 0]', label: 'v' }, { kind: 'vector', to: '[0, s * s]', role: 'highlight', label: "v'" }] } },
        { type: 'predict', prompt: 'At $s = 1.1$, how long is the image of a unit vector?', reveal: '$1.21$: the length is scaled by $s^2$.', kcs: ['quaternion.unit'] },
      ],
    },
    { id: 'exit', role: 'exit', blocks: [{ type: 'explain-back', prompt: 'Why do engines renormalize orientations?', kcs: ['quaternion.unit'], rubric: ['rounding drifts |q| away from 1', 'non-unit q scales and skews'] }] },
    { id: 'next', role: 'open-loop', blocks: [{ type: 'open-loop', md: 'Next: integrating $\\omega$ without leaving the unit sphere.' }] },
  ],
};

/** Agent-facing reference for the component catalog. Semantic only: nothing about looks. */
export function catalogGuide(): string {
  const fns = Object.keys(BUILTINS).sort().join(', ');
  return `# Component catalog v1

A lesson: { schemaVersion: 1, catalogVersion: 1, id, title, standfirst, kind: build|theory|review|source-study,
kcs: [kc ids], estimateMin, capability?, sections: [{ id, role, title?, blocks: [component…] }] }
Section roles: warmup, hook, concept, practice, build, exit, open-loop.
Ids are lowercase slugs. KC ids look like "quaternion.exp-map-side".
Text fields use CommonMark + $TeX$ maths + \`code\`. No HTML.

FIELD NAMES (exactly):
- every block says what it is with "type":            {"type": "drill", ...}  {"type": "diagram", ...}
- diagram elements, explorable controls, drill items use "kind":
                                                       {"kind": "vector", ...} {"kind": "slider", ...} {"kind": "mcq", ...}
- a code block has both: {"type": "code", "kind": "stub", ...}

A complete minimal lesson (valid as-is):
${JSON.stringify(EXAMPLE)}

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
  mcq{options, answer (index), reason?{prompt?, options, answer}} numeric{answer, tolerance?} short{answer (reference)} order{lines (correct order)}
  Choosing a format (R8): to check understanding, prefer short (explain, predict in words) or numeric. Use mcq where
  recall would mostly fail (pretests, beginners), with distractors that are real misconceptions, and add a reason tier:
  the right reason and wrong ones drawn from misconceptions. Credit needs both; a right answer with a wrong reason is
  a guess or elimination, and shows you which misconception to address.
- predict { prompt, options?, reveal, kcs }
- think-first { prompt, reveal }
- explain-back { prompt, kcs, rubric: [points a good answer covers] }
- task { id, title, scaffold 0–4, kcs, files?, goal, contract?, traps?, checkpoint?: { suite, expect: {passed, of} } }
  checkpoint.suite: a plain test name or filter (letters, digits, . _ : / * ? - …). The app runs the learner's own
  test command; the suite goes where they put {suite} in it, otherwise the whole suite runs and counts.
- utility-link { md, prompt? }  open-loop { md }

## Review questions (write_review_questions, not in lessons)
Asked on the Review page with the lesson closed, when one of their skills is due. Like a drill item without id, plus:
  angle: apply|explain|predict|spot-the-error|compare|recall   context?: what the question needs to make sense on its own
  vars?: { name: {min, max, step} }, used as {{ expression }} in the text, and as a numeric answer: "{{ r * w }}"
  Kinds: mcq, numeric, order. Never point back at a lesson, section or figure; never repeat or reword an earlier question.

## Expression language
Numbers, booleans, vectors [a, b, c], quaternions quat(w, x, y, z).
Operators: + - * / ^, comparisons, && || !, cond ? a : b, v.x/.y/.z, v[i], lambdas x -> expr.
Vectors: +, -, scalar *, /. Quaternions: q1 * q2 (Hamilton product), +, -, scalar *.
Constants: pi, e, true, false. iterate(n, x -> f(x), x0) applies f n times (n ≤ 10000).
Functions: ${fns}.
qexp(v) is the rotation by |v| about v (the exponential map of ω·dt); rotate(q, v) = q v q*.
`;
}
