import type { LessonInput } from '../src/schema.ts';

/**
 * Golden lesson adapted from the Heavy Metal Physics artifact "Four Numbers, Three Speeds".
 * Used by catalog tests, renderer tests and as the authoring exemplar.
 */
export const fourNumbers: LessonInput = {
  schemaVersion: 1,
  catalogVersion: 1,
  id: 'hmp-09-four-numbers',
  title: 'Four Numbers, Three Speeds',
  standfirst:
    'A shoulder has three ways to move, but it takes four numbers to say where it is. This lesson splits the position vector $q$ from the velocity vector for good.',
  kind: 'build',
  kcs: ['quaternion.unit', 'quaternion.exp-map-side', 'joint.nq-nv', 'cpp.std-span'],
  estimateMin: 120,
  capability: 'Your tree gets ball joints and a root that can fly.',
  sections: [
    {
      id: 'warmup',
      role: 'warmup',
      title: 'Warm-up',
      blocks: [
        {
          type: 'drill',
          purpose: 'warmup',
          items: [
            {
              id: 'w1',
              kind: 'mcq',
              prompt: 'Which transform rule does `SpatialMomentum` use?',
              options: ['The motion rule', 'The force rule'],
              answer: 1,
              kcs: ['quaternion.unit'],
              difficulty: 2,
              why: 'Momentum is a force-type (dual) vector: angular momentum is taken about an origin.',
            },
          ],
        },
      ],
    },
    {
      id: 'why-not-derivative',
      role: 'concept',
      title: "Why q̇ can't be the derivative of q",
      blocks: [
        { type: 'prose', md: 'A ball joint has three degrees of freedom, but a unit quaternion stores **four** numbers.' },
        { type: 'math', tex: '\\dot p = \\tfrac12\\, p \\otimes (0, \\omega)', tag: '4.13' },
        {
          type: 'explorable',
          description: 'A unit cube rotated by q, over a dashed ghost of the true rotation normalize(q).',
          predictFirst: 'Which update keeps |q| = 1 to the last digit?',
          state: { q: 'quat_axis_angle([1, -2, 0.5], deg(50))' },
          controls: [
            { kind: 'button', label: 'x += 0.15', do: 'q = q + quat(0, 0.15, 0, 0)', role: 'incorrect' },
            { kind: 'button', label: 'Euler on Eq. 4.13 ×10', do: 'q = iterate(10, s -> s + s * quat(0, 0, 1.5, 0) * 0.025, q)' },
            { kind: 'button', label: 'q ⊗ exp(ω dt) ×10', do: 'q = iterate(10, s -> s * qexp([0, 1.5, 0] * 0.05), q)', role: 'correct' },
            { kind: 'button', label: 'normalize', do: 'q = normalize(q)' },
            { kind: 'reset' },
          ],
          readouts: [{ label: '|q|', expr: 'norm(q)', digits: 6 }],
          view: {
            type: 'diagram',
            dims: 3,
            description: 'Cube under mat3_cast(q) and the ghost under normalize(q).',
            extent: 1.5,
            elements: [
              { kind: 'box', size: '[1, 1, 1]', rotation: 'q', role: 'primary' },
              { kind: 'box', size: '[1, 1, 1]', rotation: 'normalize(q)', role: 'ghost' },
              { kind: 'frame', rotation: 'normalize(q)', size: 0.8, label: 'S' },
            ],
          },
        },
      ],
    },
    {
      id: 'side',
      role: 'concept',
      title: 'Moving q: the exponential map, on the correct side',
      blocks: [
        {
          type: 'predict',
          prompt: 'ω is given in child coordinates. Multiply exp(ω dt) on the left or on the right of Q?',
          options: ['Left', 'Right'],
          reveal: 'Right: $\\exp(R\\omega\\,dt)\\,R = R\\,\\exp(\\omega\\,dt)$.',
          kcs: ['quaternion.exp-map-side'],
        },
        {
          type: 'plot',
          description: 'Angle between the two updates over time.',
          x: { label: 't', min: 0, max: 5 },
          series: [{ label: 'difference', expr: 'abs(sin(x))' }],
        },
      ],
    },
    {
      id: 'build',
      role: 'build',
      title: 'Build it',
      blocks: [
        {
          type: 'task',
          id: 'step-2',
          title: 'integratePosition',
          scaffold: 3,
          kcs: ['quaternion.exp-map-side', 'cpp.std-span'],
          files: ['physics/joints/Joint.cpp'],
          goal: "Advance a joint's window of q by its velocity over dt.",
          contract: 'Ball: q is (w, x, y, z); v is ω in successor coordinates.',
          traps: ['Multiplying on the wrong side passes every test that starts at the identity.'],
          checkpoint: { suite: 'MultiDof', expect: { passed: 119, of: 148 } },
        },
        {
          type: 'code',
          kind: 'stub',
          lang: 'cpp',
          source:
            '// Advance this joint\'s window of q by velocity v over dt.\nvoid integratePosition(const Joint& j, std::span<double> q,\n                       std::span<const double> v, double dt) {\n    // TODO\n}',
        },
      ],
    },
    {
      id: 'exit',
      role: 'exit',
      blocks: [
        {
          type: 'explain-back',
          prompt: "A free joint's linear velocity is in child coordinates. Which orientation rotates it, and why the midpoint?",
          kcs: ['quaternion.exp-map-side'],
          rubric: ['velocity must be rotated into the parent frame', 'midpoint makes the step reversible and second-order'],
        },
      ],
    },
    { id: 'next', role: 'open-loop', blocks: [{ type: 'open-loop', md: 'Your chain now flies. Close it into a loop and it explodes. Why?' }] },
  ],
};
