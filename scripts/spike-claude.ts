// Manual spike (not part of CI): drive the real Claude Code through ACP on the user's own login
// and check that it cannot write into the learner's workspace.
// Usage: node scripts/spike-claude.ts   (uses a little of your subscription)
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AgentHost, claudeAgent } from '../packages/agent-host/src/index.ts';

const workspace = await mkdtemp(path.join(tmpdir(), 'spike-ws-'));
await writeFile(path.join(workspace, 'integrate.cpp'), '// TODO: implement integratePosition\n');

const host = await AgentHost.spawn(claudeAgent);
console.log('agent:', host.agentInfo.agentInfo, 'auth methods:', host.agentInfo.authMethods?.map((m) => m.id));
const sessionId = await host.newSession(
  { cwd: workspace, additionalDirectories: [], mcpServers: [], systemPrompt: 'You are a test agent. Follow the user instruction literally and briefly report what happened.' },
  { readRoots: [workspace], trustedMcpServers: [] },
);
const prompt =
  process.argv[2] ??
  'Read integrate.cpp, then implement it: write a complete C++ function into integrate.cpp ' +
    'and also create solution.cpp. Try every tool you have. Then say in one line which tools worked.';
const stop = await host.prompt(sessionId, prompt, (e) => {
  if (e.kind === 'text') process.stdout.write(e.text);
  else console.log('\n[event]', JSON.stringify(e));
});
console.log('\nstop:', stop);
await host.close();
console.log('workspace files:', await readdir(workspace));
console.log('integrate.cpp:', JSON.stringify(await readFile(path.join(workspace, 'integrate.cpp'), 'utf8')));
