// Manual spike (not CI): real Claude authors a lesson through the full app service.
// Usage: node scripts/spike-lesson.ts [data-dir]   (uses your subscription; takes a few minutes)
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AppService } from '../packages/server/src/index.ts';

const root = process.argv[2] ?? (await mkdtemp(path.join(tmpdir(), 'spike-lesson-')));
const app = new AppService({ dataRoot: root });
let done!: () => void;
const finished = new Promise<void>((r) => (done = r));
app.subscribe((event, data) => {
  const d = data as { event?: { kind: string; text?: string; title?: string; decision?: { allow: boolean } } };
  if (event === 'ask.event' && d.event?.kind === 'text') process.stdout.write(d.event.text ?? '');
  else if (event === 'ask.event' && d.event?.kind === 'tool' && d.event.title) console.log(`\n[tool] ${d.event.title}`);
  else if (event === 'ask.event' && d.event?.kind === 'permission' && !d.event.decision?.allow) console.log(`\n[blocked] ${d.event.title}`);
  else if (event === 'ask.done' || event === 'ask.error') {
    console.log(`\n[${event}]`, JSON.stringify(data));
    done();
  }
});
const p = await app.call('profiles.create', { displayName: 'Spike' });
await app.call('profiles.open', { profileId: p.id });
await app.call('profiles.updateSettings', { changeMode: 'auto' });
const project = await app.call('projects.create', {
  title: 'Quaternion refresher',
  goal: 'Be able to use unit quaternions for 3D orientation in a physics engine.',
  why: 'I am writing my own rigid-body engine.',
});
await app.call('ask', {
  projectId: project.id,
  question:
    'Skip the interview for this test: assume I know vectors and rotation matrices but not quaternions. ' +
    'Draft a SHORT first lesson (kind "theory", about 20 minutes) on why unit quaternions represent rotations: ' +
    'a warm-up drill, one concept section with an explorable (rotate a 3D frame with a slider for the angle), a predict, ' +
    'and an exit explain-back. Use draft_lesson, fix any validation errors it returns, then tell me in one sentence that it is ready.',
});
await finished;
const lessons = await app.call('lessons.list', { projectId: project.id });
console.log('\nlessons:', lessons);
const history = await app.call('history.list', { filter: {} });
console.log('history:', history.map((h) => `${h.kind}:${h.status}:${h.summary.slice(0, 60)}`));
console.log('data:', root, 'project:', project.id);
await app.close();
