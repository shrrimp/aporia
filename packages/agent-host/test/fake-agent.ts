import * as acp from '@agentclientprotocol/sdk';
import type { NewSessionRequest, PermissionOption, ToolCallUpdate } from '@agentclientprotocol/sdk';

export interface FakeAgentLog {
  sessions: NewSessionRequest[];
  cancelled: string[];
}

const OPTIONS = [
  { optionId: 'yes', name: 'Allow', kind: 'allow_once' as const },
  { optionId: 'always', name: 'Always', kind: 'allow_always' as const },
  { optionId: 'no', name: 'Reject', kind: 'reject_once' as const },
];

/**
 * A scripted ACP agent. The first word of the prompt selects a behaviour; it reports what
 * happened as agent text so tests can assert on the client's answers.
 */
export function fakeAgent(log: FakeAgentLog = { sessions: [], cancelled: [] }): acp.AgentApp {
  let n = 0;
  return acp
    .agent({ name: 'fake-agent' })
    .onRequest(acp.methods.agent.initialize, async () => ({
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: { loadSession: false },
      agentInfo: { name: 'fake', version: '0.0.0' },
    }))
    .onRequest(acp.methods.agent.session.new, async ({ params }) => {
      log.sessions.push(params);
      return { sessionId: `s${++n}` };
    })
    .onNotification(acp.methods.agent.session.cancel, async ({ params }) => {
      log.cancelled.push(params.sessionId);
    })
    .onRequest(acp.methods.agent.session.prompt, async ({ params, client }) => {
      const sessionId = params.sessionId;
      const first = params.prompt[0];
      const text = first?.type === 'text' ? first.text : '';
      const [cmd, arg = ''] = text.split(' ');
      const say = (t: string) =>
        client.notify(acp.methods.client.session.update, {
          sessionId,
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: t } },
        });
      const ask = async (toolCall: ToolCallUpdate, options: PermissionOption[] = OPTIONS) => {
        const r = await client.request(acp.methods.client.session.requestPermission, { sessionId, toolCall, options });
        return r.outcome.outcome === 'selected' ? r.outcome.optionId : 'cancelled';
      };
      switch (cmd) {
        case 'hello':
          await client.notify(acp.methods.client.session.update, {
            sessionId,
            update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'hmm' } },
          });
          await client.notify(acp.methods.client.session.update, {
            sessionId,
            update: { sessionUpdate: 'agent_message_chunk', content: { type: 'image', data: '', mimeType: 'image/png' } },
          });
          await client.notify(acp.methods.client.session.update, {
            sessionId,
            update: { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Read', kind: 'read', status: 'pending' },
          });
          await client.notify(acp.methods.client.session.update, {
            sessionId,
            update: { sessionUpdate: 'tool_call_update', toolCallId: 't1' },
          });
          await client.notify(acp.methods.client.session.update, {
            sessionId,
            update: { sessionUpdate: 'plan', entries: [] },
          });
          await say('hi');
          break;
        case 'edit':
          await say(`permission:${await ask({ toolCallId: 'e', title: 'Edit', kind: 'edit', locations: [{ path: arg }] })}`);
          break;
        case 'search':
          await say(`permission:${await ask({ toolCallId: 'r', title: 'Grep', kind: 'search', locations: [{ path: arg }] })}`);
          break;
        case 'nooptions':
          await say(`permission:${await ask({ toolCallId: 'x', title: 'Edit', kind: 'edit' }, [OPTIONS[1]!])}`);
          break;
        case 'mcp':
          await say(
            `permission:${await ask({
              toolCallId: 'm',
              title: 'Record evidence',
              kind: 'other',
              _meta: { claudeCode: { mcpServer: { name: arg, source: 'acp' } } },
            })}`,
          );
          break;
        case 'mcpname':
          await say(`permission:${await ask({ toolCallId: 'm', title: 't', _meta: { claudeCode: { toolName: arg } } })}`);
          break;
        case 'write':
          try {
            await client.request(acp.methods.client.fs.writeTextFile, { sessionId, path: arg, content: 'SOLUTION' });
            await say('write:ok');
          } catch (err) {
            await say(`write:error:${(err as Error).message}`);
          }
          break;
        case 'read': {
          const [p, line, limit] = arg.split(':');
          try {
            const r = await client.request(acp.methods.client.fs.readTextFile, {
              sessionId,
              path: p!,
              ...(line ? { line: Number(line) } : {}),
              ...(limit ? { limit: Number(limit) } : {}),
            });
            await say(`read:${r.content}`);
          } catch (err) {
            await say(`read:error:${(err as Error).message}`);
          }
          break;
        }
        default:
          await say(`unknown:${text}`);
      }
      return { stopReason: 'end_turn' };
    });
}
