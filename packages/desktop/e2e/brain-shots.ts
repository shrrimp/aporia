// Visual check of the brain view: seeds a profile with a realistic skill map (domains, areas,
// bridges, evidence), opens the brain in the real Electron app and saves screenshots at a few
// zoom levels, with groups folded and not. For looking at, not for CI.
// Usage: node e2e/brain-shots.ts <out-dir>   (build the UI and the shell first)
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from '@playwright/test';
import { brand } from '@app/brand';
import { ProfileStore, SKILL_MAP_TARGET, edgeKey, type JsonValue } from '@app/core';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.resolve(process.argv[2] ?? 'brain-shots');
await mkdir(out, { recursive: true });
const data = await mkdtemp(path.join(tmpdir(), 'desktop-brain-'));

// Domains → areas → skills.
const tree: Record<string, { title: string; parent?: string; skills?: string[] }> = {
  graphics: { title: 'Graphics programming' },
  vulkan: { title: 'Vulkan', parent: 'graphics', skills: ['instance', 'swapchain', 'pipelines', 'descriptors', 'sync', 'memory'] },
  shaders: { title: 'Shaders', parent: 'graphics', skills: ['glsl', 'lighting', 'pbr', 'shadow-maps', 'post'] },
  opengl: { title: 'OpenGL', parent: 'graphics', skills: ['buffers', 'vao', 'textures', 'framebuffers'] },
  voxels: { title: 'Voxels', parent: 'graphics', skills: ['chunks', 'greedy-mesh', 'octrees', 'raymarch'] },
  sim: { title: 'Simulation' },
  rigid: { title: 'Rigid bodies', parent: 'sim', skills: ['inertia', 'impulses', 'featherstone', 'joints', 'spatial'] },
  integ: { title: 'Integration', parent: 'sim', skills: ['euler', 'rk4', 'symplectic', 'stability'] },
  collide: { title: 'Collision', parent: 'sim', skills: ['broadphase', 'gjk', 'epa', 'contacts'] },
  maths: { title: 'Mathematics' },
  linalg: { title: 'Linear algebra', parent: 'maths', skills: ['vectors', 'matrices', 'cross', 'dot', 'bases', 'eigen'] },
  rot: { title: 'Rotations', parent: 'maths', skills: ['quaternions', 'exp-map', 'euler-angles', 'slerp', 'so3'] },
  calc: { title: 'Calculus', parent: 'maths', skills: ['derivatives', 'odes', 'taylor', 'fourier'] },
  cpp: { title: 'C++' },
  cppmem: { title: 'Memory', parent: 'cpp', skills: ['raii', 'span', 'allocators', 'move'] },
  cpptpl: { title: 'Templates', parent: 'cpp', skills: ['concepts', 'constexpr', 'crtp'] },
  talk: { title: 'Communication', skills: ['explaining', 'listening', 'writing', 'presenting'] },
  music: { title: 'Music', skills: ['harmony', 'rhythm', 'synthesis'] },
  elec: { title: 'Electronics', skills: ['circuits', 'filters', 'microcontrollers'] },
};
const id = (g: string, s: string) => `${g}.${s}`;
const skills: Record<string, { title: string; group: string }> = {};
for (const [g, t] of Object.entries(tree)) for (const s of t.skills ?? []) skills[id(g, s)] = { title: s.replace(/-/g, ' '), group: g };
const links: [string, string, 'prereq' | 'related' | 'confusable'][] = [
  // Inside areas: chains.
  ...Object.entries(tree).flatMap(([g, t]) => (t.skills ?? []).slice(1).map((s, i) => [id(g, t.skills![i]!), id(g, s), 'prereq'] as [string, string, 'prereq'])),
  // Bridges: maths under graphics and simulation, calculus under integration, signals into music and electronics.
  ['linalg.matrices', 'vulkan.pipelines', 'related'],
  ['linalg.vectors', 'shaders.lighting', 'prereq'],
  ['linalg.dot', 'shaders.lighting', 'prereq'],
  ['linalg.bases', 'voxels.raymarch', 'related'],
  ['linalg.cross', 'rigid.inertia', 'prereq'],
  ['linalg.matrices', 'rigid.spatial', 'prereq'],
  ['rot.quaternions', 'rigid.joints', 'prereq'],
  ['rot.exp-map', 'integ.symplectic', 'related'],
  ['rot.quaternions', 'shaders.post', 'related'],
  ['calc.odes', 'integ.euler', 'prereq'],
  ['calc.taylor', 'integ.rk4', 'related'],
  ['calc.fourier', 'music.synthesis', 'prereq'],
  ['calc.fourier', 'elec.filters', 'prereq'],
  ['collide.gjk', 'linalg.dot', 'related'],
  ['cppmem.span', 'rigid.featherstone', 'related'],
  ['cppmem.allocators', 'vulkan.memory', 'related'],
  ['rot.euler-angles', 'rot.quaternions', 'confusable'],
];

{
  const store = new ProfileStore(data);
  const p = await store.create('Jules');
  const profile = await store.open(p.id);
  const map = {
    schemaVersion: 1,
    groups: Object.fromEntries(Object.entries(tree).map(([g, t]) => [g, { title: t.title, ...(t.parent ? { parent: t.parent } : {}) }])),
    skills,
    edges: Object.fromEntries(links.map(([from, to, kind]) => [edgeKey({ from, to, kind }), { from, to, kind }])),
  };
  await profile.changes.propose({ author: { kind: 'system' }, target: SKILL_MAP_TARGET, patch: [{ op: 'add', path: '', value: map as unknown as JsonValue }], reason: 'seed' }, 'auto');
  // Evidence on about half the skills, from shaky to solid.
  const all = Object.keys(skills).sort();
  for (let i = 0; i < all.length; i++) {
    if (i % 2 === 1 && i % 5 !== 0) continue;
    const n = 1 + (i % 7);
    for (let k = 0; k < n; k++) {
      await profile.observations.recordEvidence({ author: { kind: 'learner' }, itemId: `i${i}-${k}`, kcs: [{ kc: all[i]!, weight: 1 }], difficulty: 2, evidenceType: 'production', outcome: i % 3 === 0 && k % 2 ? 0 : 1 });
    }
  }
  await profile.close();
}

const app = await electron.launch({ args: [path.join(here, '..')], env: { ...process.env, [`${brand.envPrefix}_DATA_DIR`]: data, ...(process.env['VISIBLE'] ? {} : { [`${brand.envPrefix}_HIDDEN_WINDOW`]: '1' }) } });
try {
  const page = await app.firstWindow();
  page.on('pageerror', (e) => console.error(`page error: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && console.error(`console: ${m.text().slice(0, 500)}`));
  console.log('opening the profile');
  await page.getByRole('button', { name: /Jules/ }).click();
  console.log('opening the brain');
  await page.getByRole('button', { name: 'Your brain' }).click();
  await page.locator('.brain-map').waitFor();
  await page.waitForTimeout(4000); // let it settle
  // Captured by Electron: a hidden window paints too rarely for Playwright's screenshots.
  const shot = async (name: string) => {
    console.log(`shot ${name}…`);
    // A still, hidden window paints no new frame on its own: ask for one first.
    const png = await app.evaluate(async ({ BrowserWindow }) => {
      const c = BrowserWindow.getAllWindows()[0]!.webContents;
      c.invalidate();
      return (await c.capturePage()).toPNG().toString('base64');
    });
    await writeFile(path.join(out, `${name}.png`), Buffer.from(png, 'base64'));
  };
  await shot('1-fit');
  const zoom = async (label: string, times: number) => {
    for (let i = 0; i < times; i++) await page.getByRole('button', { name: label }).dispatchEvent('click');
    await page.waitForTimeout(400);
  };
  await zoom('Zoom out', 2);
  await shot('2-out');
  await zoom('Zoom out', 2);
  await shot('3-far');
  await page.getByLabel('Fold groups when zoomed out').uncheck();
  await page.waitForTimeout(400);
  await shot('4-far-unfolded');
  await page.getByLabel('Fold groups when zoomed out').check();
  await page.getByRole('button', { name: 'Fit' }).dispatchEvent('click');
  await zoom('Zoom in', 3);
  await shot('5-in');
  console.log(`brain shots in ${out}`);
} finally {
  console.error((await readFile(path.join(data, 'logs', 'app.log'), 'utf8').catch(() => '')).slice(-2000));
  await app.close().catch(() => undefined);
  await rm(data, { recursive: true, force: true });
}
