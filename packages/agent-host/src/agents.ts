import { createRequire } from 'node:module';
import type { McpServer } from '@agentclientprotocol/sdk';

export interface AgentLaunch {
  readonly command: string;
  readonly args: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
}

export interface SessionOptions {
  readonly cwd: string;
  readonly additionalDirectories: readonly string[];
  readonly mcpServers: readonly McpServer[];
  /** The app's teaching rules, given to agents that accept a system prompt. */
  readonly systemPrompt?: string;
}

/** How to start and configure one kind of ACP agent. */
export interface AgentSpec {
  readonly id: string;
  readonly displayName: string;
  launch(): AgentLaunch;
  /** Agent-specific `_meta` for `session/new`. */
  sessionMeta(opts: SessionOptions): Record<string, unknown> | undefined;
}

/** Built-in Claude Code tools that only read. Everything else (Edit, Write, Bash…) is withheld. */
export const CLAUDE_READ_ONLY_TOOLS = ['Read', 'Grep', 'Glob'] as const;

/** Tools that write or execute: listed explicitly as a second, independent barrier. */
export const CLAUDE_WRITE_TOOLS = [
  'Edit',
  'MultiEdit',
  'Write',
  'NotebookEdit',
  'Bash',
  'BashOutput',
  'KillShell',
  'Task',
  'Agent',
] as const;

const require = createRequire(import.meta.url);

/**
 * Claude Code through the official ACP adapter, on the user's own login. The app passes an
 * explicit read-only tool list, an explicit deny list, no user/project settings and no MCP
 * servers other than its own (isolation, privacy), and its own system prompt.
 */
export const claudeAgent: AgentSpec = {
  id: 'claude',
  displayName: 'Claude Code',
  launch() {
    return {
      command: process.execPath,
      args: [require.resolve('@agentclientprotocol/claude-agent-acp/dist/index.js')],
      // Inside the desktop shell, execPath is the Electron binary: make it behave as plain Node.
      env: { ELECTRON_RUN_AS_NODE: '1' },
    };
  },
  sessionMeta(opts) {
    return {
      claudeCode: {
        options: {
          tools: [...CLAUDE_READ_ONLY_TOOLS],
          disallowedTools: [...CLAUDE_WRITE_TOOLS],
          settingSources: [],
          // Only the app's MCP servers: hides account-level connectors (mail, drives…).
          strictMcpConfig: true,
          ...(opts.systemPrompt === undefined ? {} : { systemPrompt: opts.systemPrompt }),
        },
      },
    };
  },
};

/** Any other ACP agent: launched as configured, no agent-specific options. */
export function genericAgent(id: string, displayName: string, launch: AgentLaunch): AgentSpec {
  return { id, displayName, launch: () => launch, sessionMeta: () => undefined };
}
