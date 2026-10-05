import * as acp from '@agentclientprotocol/sdk';
import type { McpServer } from '@agentclientprotocol/sdk';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { fourNumbers } from '../../catalog/fixtures/four-numbers.ts';

export interface FakeLog {
  prompts: string[];
  sessions: number;
}

/**
 * Scripted ACP agent that uses the app's MCP tools like a real tutor would.
 * "lesson" drafts the golden lesson; "evidence" records evidence; "slow" waits to be cancelled;
 * anything else answers with text.
 */
export function fakeTeacherAgent(log: FakeLog = { prompts: [], sessions: 0 }): acp.AgentApp {
  const servers = new Map<string, McpServer[]>();
  return acp
    .agent({ name: 'fake-teacher' })
    .onRequest(acp.methods.agent.initialize, async () => ({ protocolVersion: acp.PROTOCOL_VERSION, agentCapabilities: {} }))
    .onRequest(acp.methods.agent.session.new, async ({ params }) => {
      const id = `s${++log.sessions}`;
      servers.set(id, params.mcpServers);
      return { sessionId: id };
    })
    .onNotification(acp.methods.agent.session.cancel, async () => undefined)
    .onRequest(acp.methods.agent.session.prompt, async ({ params, client, signal }) => {
      const text = params.prompt.map((b) => (b.type === 'text' ? b.text : '')).join('');
      log.prompts.push(text);
      const say = (t: string) =>
        client.notify(acp.methods.client.session.update, {
          sessionId: params.sessionId,
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: t } },
        });
      const server = servers.get(params.sessionId)![0] as McpServer & { url: string; headers: { name: string; value: string }[] };
      const mcp = new Client({ name: 'fake', version: '0' });
      await mcp.connect(
        new StreamableHTTPClientTransport(new URL(server.url), {
          requestInit: { headers: Object.fromEntries(server.headers.map((h) => [h.name, h.value])) },
        }) as unknown as Parameters<Client['connect']>[0],
      );
      // Report tool use the way real agents do, so the UI's activity labels are exercised.
      let toolN = 0;
      const tool = async <T,>(name: string, fn: () => Promise<T>): Promise<T> => {
        const toolCallId = `tc${++toolN}`;
        await client.notify(acp.methods.client.session.update, {
          sessionId: params.sessionId,
          update: { sessionUpdate: 'tool_call', toolCallId, title: `mcp__aporia__${name}`, kind: 'other', status: 'pending' },
        });
        const r = await fn();
        await client.notify(acp.methods.client.session.update, {
          sessionId: params.sessionId,
          update: { sessionUpdate: 'tool_call_update', toolCallId, status: 'completed' },
        });
        return r;
      };
      const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
      try {
        const question = text.split('The learner asks:\n')[1] ?? '';
        if (question.startsWith('Interview me')) {
          await tool('get_teaching_context', () => mcp.callTool({ name: 'get_teaching_context', arguments: {} }));
          await pause(900);
          await say("Let's find your starting point. A few quick questions: click what fits, and guessing is fine.");
          await tool('ask_learner', () =>
            mcp.callTool({
              name: 'ask_learner',
              arguments: {
                  title: 'Where you are starting from',
                  intro: 'No wrong answers here: this only decides where the first lesson begins.',
                  questions: [
                    { id: 'background', kind: 'single', prompt: 'How have you worked with 3D rotations so far?', options: ['Never really', 'Euler angles in a game or tool', 'Rotation matrices by hand', 'Quaternions in code'], allowOther: true },
                    { id: 'comfort', kind: 'scale', prompt: 'How comfortable are you with linear algebra?', low: 'shaky', high: 'fluent' },
                    { id: 'tools', kind: 'multi', prompt: 'Which of these have you used?', options: ['glm', 'Eigen', 'numpy', 'a physics engine (Bullet, PhysX…)'] },
                    { id: 'probe', kind: 'text', prompt: 'You rotate $v$ by $q\\,v\\,q^*$. What goes wrong if $|q| \\neq 1$?', placeholder: 'One sentence is enough' },
                    { id: 'order', kind: 'rank', prompt: 'Order what matters most to you right now:', options: ['Understanding the maths', 'Working code fast', 'Avoiding numerical drift'] },
                  ],
                  submitLabel: 'Send answers',
              },
            }),
          );
        } else if (question.startsWith('Answers to the form')) {
          await tool('record_evidence', () =>
            mcp.callTool({
              name: 'record_evidence',
              arguments: { itemId: 'interview-probe', kcs: [{ kc: 'quaternion.unit' }], difficulty: 3, evidenceType: 'probe', outcome: 0.5 },
            }),
          );
          await pause(600);
          await say('Thanks. Here is what I understood: you are comfortable with matrices and want the maths to make sense before the code. ');
          await say('The probe tells me the unit-length condition is the place to start. I will draft a first lesson around it.');
        } else if (question.startsWith('lesson')) {
          const r = await tool('draft_lesson', () => mcp.callTool({ name: 'draft_lesson', arguments: { lesson: fourNumbers } }));
          await say((r.content as { text: string }[])[0]!.text);
        } else if (question.startsWith('evidence')) {
          await mcp.callTool({
            name: 'record_evidence',
            arguments: { itemId: 'probe-1', kcs: [{ kc: 'quaternion.unit' }], difficulty: 3, evidenceType: 'probe', outcome: 1 },
          });
          await say('noted');
        } else if (question.startsWith('observe')) {
          await mcp.callTool({ name: 'record_instruction', arguments: { kcs: ['quaternion.unit'] } });
          const r = await mcp.callTool({ name: 'record_insight', arguments: { stance: 'propose', text: 'Likes the maths first' } });
          const id = /insight (ins_\S+)\./.exec((r.content as { text: string }[])[0]!.text)![1]!;
          await mcp.callTool({ name: 'record_insight', arguments: { stance: 'contradict', insightId: id } });
          await mcp.callTool({ name: 'record_insight', arguments: { stance: 'support', insightId: id } });
          await mcp.callTool({
            name: 'record_evidence',
            arguments: { itemId: 'h', kcs: [{ kc: 'quaternion.unit' }], difficulty: 3, evidenceType: 'production', outcome: 0.5, hintLevel: 2 },
          });
          await say('observed');
        } else if (question.startsWith('slow')) {
          await new Promise<void>((resolve) => {
            if (signal.aborted) resolve();
            signal.addEventListener('abort', () => resolve());
            setTimeout(resolve, 2000);
          });
          return { stopReason: 'cancelled' };
        } else if (question.startsWith('crash')) {
          throw new Error('agent exploded');
        } else {
          await say(`You asked: ${question}`);
        }
      } finally {
        await mcp.close();
      }
      return { stopReason: 'end_turn' };
    });
}
