// Demo/dev server (no real agent): seeds a profile with the golden lesson and serves the built UI.
// Usage: node scripts/demo-server.ts [port]  → prints the URL to open.
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentHost, genericAgent } from '../packages/agent-host/src/index.ts';
import { AppService, serve } from '../packages/server/src/index.ts';
import { fakeTeacherAgent } from '../packages/server/test/fake-teacher-agent.ts';

const root = process.env.DEMO_DATA ?? (await mkdtemp(path.join(tmpdir(), 'demo-')));
const app = new AppService({
  dataRoot: root,
  agent: genericAgent('demo', 'Demo tutor (scripted)', { command: 'unused', args: [] }),
  hostFactory: (spec) => AgentHost.inProcess(fakeTeacherAgent(), spec),
});
const profiles = await app.call('profiles.list', {});
if (profiles.length === 0) {
  const p = await app.call('profiles.create', { displayName: 'Jules' });
  await app.call('profiles.open', { profileId: p.id });
  const project = await app.call('projects.create', {
    title: 'Heavy Metal Physics',
    goal: 'Understand and build a reduced-coordinate rigid-body solver (Featherstone).',
    why: 'My own physics engine for a destructible vehicle game.',
  });
  await app.call('profiles.updateSettings', { changeMode: 'auto' });
  // The scripted tutor drafts the golden lesson when asked for "lesson".
  await app.call('ask', { projectId: project.id, question: 'lesson please' });
  await new Promise((r) => setTimeout(r, 500));
}
const ui = path.join(path.dirname(fileURLToPath(import.meta.url)), '../packages/ui/dist');
const served = await serve({ app, staticDir: ui, port: Number(process.argv[2] ?? 0), token: 'demo' });
console.log(`${served.url}/#token=demo`);
console.log(`data: ${root}`);
