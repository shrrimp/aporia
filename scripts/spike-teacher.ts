// Manual end-to-end spike (not CI): real Claude Code ↔ ACP host ↔ teacher MCP over HTTP ↔ core.
// Usage: node scripts/spike-teacher.ts   (uses a little of your subscription)
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AgentHost, claudeAgent } from '../packages/agent-host/src/index.ts';
import { ProfileStore, deriveLearnerState } from '../packages/core/src/index.ts';
import { TeacherHttpServer, registerLessonValidator, systemPrompt } from '../packages/teacher-mcp/src/index.ts';

const root = await mkdtemp(path.join(tmpdir(), 'spike-data-'));
const workspace = await mkdtemp(path.join(tmpdir(), 'spike-ws-'));
await writeFile(path.join(workspace, 'quat.cpp'), '// TODO: integrate orientation\n');
const store = new ProfileStore(root);
const profile = await store.open((await store.create('Spike')).id);
registerLessonValidator(profile.changes);
const teacher = await TeacherHttpServer.start();
const host = await AgentHost.spawn(claudeAgent);
const session = 'spike-1';
const reg = teacher.register({
  profile,
  projectId: 'spike',
  agent: { kind: 'agent', agent: claudeAgent.id, model: 'default', session },
  changeMode: () => 'auto',
});
const sessionId = await host.newSession(
  { cwd: workspace, additionalDirectories: [], mcpServers: [reg.acpServer], systemPrompt: systemPrompt() },
  { readRoots: [workspace], trustedMcpServers: ['aporia'] },
);
const prompt =
  process.argv[2] ??
  'The learner just answered a warm-up question about unit quaternions correctly and confidently, with no hints. ' +
    'Record that evidence (item "warmup-1", KC "quaternion.unit", standard difficulty, production). ' +
    'Then tell the learner, in two sentences, what to look at next. Do not write any code.';
await host.prompt(sessionId, prompt, (e) => {
  if (e.kind === 'text') process.stdout.write(e.text);
  else if (e.kind !== 'thought') console.log('\n[event]', JSON.stringify(e));
});
const state = deriveLearnerState(profile.journal.events, profile.journal.now());
console.log('\n\njournal events:', profile.journal.events.map((e) => `${e.type} by ${e.author.agent}`));
console.log('quaternion.unit:', state.kcs.get('quaternion.unit')?.rating, state.kcs.get('quaternion.unit')?.mastery);
await host.close();
await teacher.close();
await profile.close();
