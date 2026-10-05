import path from 'node:path';
import { PathEscapeError, isWithin, resolveInsideReal } from '@app/core';
import type { PermissionOption, RequestPermissionRequest, RequestPermissionResponse } from '@agentclientprotocol/sdk';

/**
 * What the agent may touch in one session. The agent never writes anywhere: lessons, learner
 * data and everything else go through the app's MCP tools, which validate and record changes.
 */
export interface SessionScope {
  /** Absolute directories the agent may read (workspace, lesson dir, imported sources). */
  readonly readRoots: readonly string[];
  /** MCP server names whose tools the agent may call (the app's own teaching server). */
  readonly trustedMcpServers: readonly string[];
}

export type Decision =
  | { readonly allow: true; readonly reason: string }
  | { readonly allow: false; readonly reason: string };

/** ACP tool kinds that never modify anything. */
const READ_ONLY_KINDS = new Set(['read', 'search', 'think']);

/** True when `target` (absolute) is inside one of `roots`, following symlinks. */
export async function isInsideRoots(target: string, roots: readonly string[]): Promise<boolean> {
  if (!path.isAbsolute(target)) return false;
  for (const root of roots) {
    const rel = path.relative(root, target);
    if (!isWithin(root, target)) continue;
    try {
      if (rel === '') return true;
      await resolveInsideReal(root, rel);
      return true;
    } catch (err) {
      if (err instanceof PathEscapeError) continue;
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue; // root itself missing
      throw err;
    }
  }
  return false;
}

function mcpServerOf(req: RequestPermissionRequest): string | undefined {
  const meta = req.toolCall._meta as { claudeCode?: { mcpServer?: { name?: unknown }; toolName?: unknown } } | undefined | null;
  const named = meta?.claudeCode?.mcpServer?.name;
  if (typeof named === 'string') return named;
  const toolName = meta?.claudeCode?.toolName;
  if (typeof toolName === 'string') {
    const m = /^mcp__([^_]+(?:_[^_]+)*)__/.exec(toolName);
    if (m) return m[1];
  }
  return undefined;
}

/**
 * Decide a permission request. Default deny: only the app's own MCP tools and read-only
 * tools whose every location lies inside the read roots are allowed.
 */
export async function decidePermission(req: RequestPermissionRequest, scope: SessionScope): Promise<Decision> {
  const server = mcpServerOf(req);
  if (server !== undefined) {
    return scope.trustedMcpServers.includes(server)
      ? { allow: true, reason: `trusted MCP server "${server}"` }
      : { allow: false, reason: `untrusted MCP server "${server}"` };
  }
  const kind = req.toolCall.kind ?? 'other';
  if (!READ_ONLY_KINDS.has(kind)) return { allow: false, reason: `tool kind "${kind}" is not allowed` };
  for (const loc of req.toolCall.locations ?? []) {
    if (!(await isInsideRoots(loc.path, scope.readRoots))) {
      return { allow: false, reason: `outside readable roots: ${loc.path}` };
    }
  }
  return { allow: true, reason: `read-only "${kind}"` };
}

/**
 * Turn a decision into an ACP response. Only ever picks a *once* option, so nothing is
 * persisted into the user's own agent settings.
 */
export function toResponse(decision: Decision, options: readonly PermissionOption[]): RequestPermissionResponse {
  const wanted = decision.allow ? 'allow_once' : 'reject_once';
  const option = options.find((o) => o.kind === wanted);
  return option ? { outcome: { outcome: 'selected', optionId: option.optionId } } : { outcome: { outcome: 'cancelled' } };
}
