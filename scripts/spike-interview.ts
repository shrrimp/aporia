// Manual spike (not CI): does the real agent run the interview with forms (ask_learner)?
// Usage: node scripts/spike-interview.ts   (one turn; uses a little of your subscription)
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AppService } from '../packages/server/src/index.ts';

const app = new AppService({ dataRoot: await mkdtemp(path.join(tmpdir(), 'spike-interview-')) });
let done!: () => void;
const finished = new Promise<void>((r) => (done = r));
app.subscribe((event, data) => {
  const d = data as { event?: { kind: string; text?: string; title?: string; form?: unknown } };
  if (event === 'ask.event' && d.event?.kind === 'form') console.log('\n[FORM]', JSON.stringify(d.event.form, null, 1));
  else if (event === 'ask.event' && d.event?.kind === 'text') process.stdout.write(d.event.text ?? '');
  else if (event === 'ask.event' && d.event?.kind === 'tool' && d.event.title) console.log(`\n[tool] ${d.event.title}`);
  else if (event === 'ask.done' || event === 'ask.error') {
    console.log(`\n[${event}]`, JSON.stringify(data));
    done();
  }
});
const p = await app.call('profiles.create', { displayName: 'Spike' });
await app.call('profiles.open', { profileId: p.id });
const project = await app.call('projects.create', {
  title: 'Rigid-body orientation',
  goal: 'Represent and integrate 3D orientation correctly in my physics engine.',
  why: 'My own engine.',
});
await app.call('ask', { projectId: project.id, question: 'Interview me briefly to find out what I already know for this project, then draft the first lesson.' });
await finished;
await app.close();
