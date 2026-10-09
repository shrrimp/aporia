import * as acp from '@agentclientprotocol/sdk';
import type { McpServer } from '@agentclientprotocol/sdk';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { fourNumbers } from '../../catalog/fixtures/four-numbers.ts';

export interface FakeLog {
  prompts: string[];
  sessions: number;
  /** Sessions picked up from an earlier run (agents that can resume). */
  resumed?: string[];
}

/**
 * Scripted ACP agent that uses the app's MCP tools like a real tutor would.
 * "lesson" drafts the golden lesson; "evidence" records evidence; "slow" waits to be cancelled;
 * anything else answers with text.
 */
export function fakeTeacherAgent(log: FakeLog = { prompts: [], sessions: 0 }, opts: { auth?: string; resume?: boolean } = {}): acp.AgentApp {
  const servers = new Map<string, McpServer[]>();
  return acp
    .agent({ name: 'fake-teacher' })
    .onRequest(acp.methods.agent.initialize, async ({ client }) => {
      // Like the Claude adapter: report the login shortly after starting.
      if (opts.auth && opts.auth !== 'silent') setTimeout(() => void client.notify('_auth/status_update', { authStatus: { kind: opts.auth, label: opts.auth === 'none' ? 'Not logged in' : 'Claude Pro' } }), 20);
      return {
        protocolVersion: acp.PROTOCOL_VERSION,
        agentCapabilities: { ...(opts.auth ? { _meta: { authStatus: {} } } : {}), ...(opts.resume ? { sessionCapabilities: { resume: {} } } : {}) },
      };
    })
    .onRequest(acp.methods.agent.session.new, async ({ params }) => {
      const id = `s${++log.sessions}`;
      servers.set(id, params.mcpServers);
      return { sessionId: id };
    })
    // It remembers the sessions named s<number> (as the Claude adapter keeps its transcripts).
    .onRequest(acp.methods.agent.session.resume, async ({ params }) => {
      if (!/^s\d+$/.test(params.sessionId)) throw acp.RequestError.resourceNotFound(params.sessionId);
      (log.resumed ??= []).push(params.sessionId);
      servers.set(params.sessionId, params.mcpServers ?? []);
      return {};
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
        if (text.startsWith('<review-questions>')) {
          // Asked by the app to stock the review bank: two questions per skill, one of them a template.
          const n = log.prompts.length;
          const questions = [...text.matchAll(/^## ([a-z0-9.-]+):/gm)].flatMap(([, kc]) => [
            {
              kind: 'mcq',
              angle: 'apply',
              kcs: [kc],
              difficulty: 2,
              why: 'Its components squared add up to 1.',
              context: 'A unit quaternion $q = (w, x, y, z)$ has $w^2 + x^2 + y^2 + z^2 = 1$.',
              prompt: `Which of these is a unit quaternion? (${kc}, round ${n})`,
              options: ['$(1, 0, 0, 0)$', '$(1, 1, 0, 0)$'],
              answer: 0,
            },
            {
              kind: 'numeric',
              angle: 'predict',
              kcs: [kc],
              difficulty: 2,
              why: 'For a rotation by $\\theta$, $w = \\cos(\\theta / 2)$.',
              prompt: `A rotation of {{t}} degrees about z is a unit quaternion. What is its w, to 3 decimals? (${kc}, round ${n})`,
              vars: { t: { min: 10, max: 170, step: 10 } },
              answer: '{{ cos(t * pi / 360) }}',
              tolerance: 0.001,
            },
          ]);
          const r = await tool('write_review_questions', () => mcp.callTool({ name: 'write_review_questions', arguments: { questions, reason: 'stock the bank' } }));
          await say((r.content as { text: string }[])[0]!.text);
        } else if (question.startsWith('Interview me')) {
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
                    { id: 'norm', kind: 'single', prompt: 'What is $|q|$ for a rotation?', options: ['0', '1', 'any'], probe: { kcs: ['quaternion.unit'], difficulty: 2, answer: '1' } },
                    { id: 'bug', kind: 'line', prompt: 'Which line is wrong?', code: 'q = q * w;\nq = q + w;\nq = normalize(q);', probe: { kcs: ['quaternion.unit'], difficulty: 3, answer: 2 } },
                    { id: 'self', kind: 'scale', prompt: 'How well do you know quaternions?', low: 'not at all', high: 'very well', probe: { kcs: ['quaternion.unit'], difficulty: 3 } },
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
          if (question.includes('[plan]')) {
            await tool('update_skill_map', () =>
              mcp.callTool({
                name: 'update_skill_map',
                arguments: {
                  groups: [{ id: 'maths', title: 'Mathematics' }, { id: 'rotations', title: 'Rotations', parent: 'maths' }],
                  skills: [
                    { id: 'linalg.vectors', title: 'Vectors' },
                    { id: 'quaternion.unit', title: 'Unit quaternions', group: 'rotations' },
                    { id: 'quaternion.exp-map-side', title: 'Which side the exponential goes', group: 'rotations' },
                    { id: 'dyn.featherstone', title: 'Articulated bodies', suggested: true, why: 'Builds on the rotations you know' },
                  ],
                  edges: [
                    { from: 'linalg.vectors', to: 'quaternion.unit', kind: 'prereq' },
                    { from: 'quaternion.unit', to: 'quaternion.exp-map-side', kind: 'prereq' },
                    { from: 'quaternion.exp-map-side', to: 'dyn.featherstone', kind: 'prereq' },
                  ],
                  reason: 'interview',
                },
              }),
            );
            await tool('set_curriculum', () =>
              mcp.callTool({
                name: 'set_curriculum',
                arguments: {
                  goals: ['quaternion.exp-map-side'],
                  plan: [
                    { id: 'four', title: 'Four Numbers, Three Speeds', kcs: ['quaternion.unit', 'quaternion.exp-map-side'], lessonId: 'hmp-09-four-numbers' },
                    { id: 'next', title: 'Closing the loop', kcs: ['quaternion.exp-map-side'], capability: 'your chain closes' },
                  ],
                  reason: 'first plan',
                },
              }),
            );
            await tool('save_assessment', () =>
              mcp.callTool({ name: 'save_assessment', arguments: { summary: 'Comfortable with matrices; unit length is the place to start.', gaps: [{ text: 'unit length', kcs: ['quaternion.unit'] }] } }),
            );
          }
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
        } else if (question.startsWith('hint me')) {
          // "hint me 3": a hint at that level on the golden lesson's task.
          const level = Number(question.split(' ')[2] ?? 1);
          const r = await tool('record_hint', () => mcp.callTool({ name: 'record_hint', arguments: { lessonId: fourNumbers.id, taskId: 'step-2', level, summary: 'which side' } }));
          await say((r.content as { text: string }[])[0]!.text);
        } else if (question.startsWith('long')) {
          // A long answer, then more work: the app sees a turn in progress.
          await say('x'.repeat(5000));
          await pause(300);
          return { stopReason: 'end_turn' };
        } else if (question.startsWith('slow')) {
          await new Promise<void>((resolve) => {
            if (signal.aborted) resolve();
            signal.addEventListener('abort', () => resolve());
            setTimeout(resolve, 2000);
          });
          return { stopReason: 'cancelled' };
        } else if (question.startsWith('write a test')) {
          const r = await tool('write_file', () => mcp.callTool({ name: 'write_file', arguments: { path: 'aporia-tests/joint_test.cpp', content: '// checks the joint\n', reason: 'a first test' } }));
          await say((r.content as { text: string }[])[0]!.text);
        } else if (question.startsWith('edit my build')) {
          const r = await tool('write_file', () => mcp.callTool({ name: 'write_file', arguments: { path: 'CMakeLists.txt', content: 'project(engine)\nadd_subdirectory(aporia-tests)\n', reason: 'build the tests' } }));
          await say((r.content as { text: string }[])[0]!.text);
        } else if (question.startsWith('roadmap')) {
          const r = await tool('update_roadmap', () =>
            mcp.callTool({
              name: 'update_roadmap',
              arguments: {
                milestones: [
                  { id: 'stage-1', title: 'Rigid bodies', order: 1, capability: 'things fall' },
                  { id: 'stage-2', title: 'Joints', order: 2 },
                ],
                reason: 'from your repo',
              },
            }),
          );
          await say((r.content as { text: string }[])[0]!.text);
        } else if (question.startsWith('I already have work')) {
          await tool('update_skill_map', () =>
            mcp.callTool({
              name: 'update_skill_map',
              arguments: {
                skills: [
                  { id: 'quaternion.unit', title: 'Unit quaternions', claim: { from: 'workspace', basis: 'physics/Quat.cpp normalises after each step' } },
                  { id: 'linalg.vectors', title: 'Vectors', claim: { from: 'sources', basis: 'lesson 03 was about vectors' } },
                ],
                edges: [{ from: 'linalg.vectors', to: 'quaternion.unit', kind: 'prereq' }],
                reason: 'what your work suggests',
              },
            }),
          );
          await say('Your work suggests two skills; let us check them.');
        } else if (question.startsWith('crash')) {
          throw new Error('agent exploded');
        } else if (question.startsWith('logged out')) {
          throw acp.RequestError.authRequired();
        } else {
          await say(`You asked: ${question}`);
        }
      } finally {
        await mcp.close();
      }
      return { stopReason: 'end_turn' };
    });
}
