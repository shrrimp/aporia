import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { McpServer as AcpMcpServer } from '@agentclientprotocol/sdk';
import { brand } from '@app/brand';
import { buildTeacherServer } from './tools.ts';
import type { TeacherContext } from './context.ts';

const MAX_BODY = 4 * 1024 * 1024;

export interface Registration {
  readonly token: string;
  /** What to pass to the agent in `session/new` `mcpServers`. */
  readonly acpServer: AcpMcpServer;
  revoke(): void;
}

/**
 * The teaching tools over MCP Streamable HTTP, bound to 127.0.0.1. Each agent session gets
 * its own bearer token, and the token decides which profile and project the tools touch.
 * Stateless: every request gets a fresh server bound to that context.
 */
export class TeacherHttpServer {
  readonly #http: Server;
  readonly #contexts = new Map<string, TeacherContext>();
  readonly url: string;

  private constructor(http: Server, url: string) {
    this.#http = http;
    this.url = url;
  }

  static async start(): Promise<TeacherHttpServer> {
    let self: TeacherHttpServer | undefined;
    const http = createServer((req, res) => {
      void self!.#handle(req, res);
    });
    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
    const { port } = http.address() as AddressInfo;
    self = new TeacherHttpServer(http, `http://127.0.0.1:${port}/mcp`);
    return self;
  }

  register(ctx: TeacherContext): Registration {
    const token = randomBytes(32).toString('hex');
    this.#contexts.set(token, ctx);
    return {
      token,
      acpServer: { type: 'http', name: brand.id, url: this.url, headers: [{ name: 'Authorization', value: `Bearer ${token}` }] },
      revoke: () => void this.#contexts.delete(token),
    };
  }

  async close(): Promise<void> {
    this.#contexts.clear();
    this.#http.closeAllConnections();
    await new Promise<void>((resolve) => this.#http.close(() => resolve()));
  }

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const reject = (status: number, message: string) => {
      res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify({ error: message }));
    };
    if (new URL(req.url ?? '/', 'http://x').pathname !== '/mcp') return reject(404, 'not found');
    const host = req.headers.host ?? '';
    if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) return reject(403, 'bad host'); // DNS rebinding
    if (req.headers.origin !== undefined) return reject(403, 'browsers may not call this endpoint');
    const auth = /^Bearer ([0-9a-f]{64})$/.exec(req.headers.authorization ?? '');
    const ctx = auth ? this.#contexts.get(auth[1]!) : undefined;
    if (!ctx) return reject(401, 'unknown or missing token');

    let body: unknown;
    if (req.method === 'POST') {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req) {
        size += (chunk as Buffer).length;
        if (size > MAX_BODY) return reject(413, 'request too large');
        chunks.push(chunk as Buffer);
      }
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        return reject(400, 'invalid JSON');
      }
    }
    const server = buildTeacherServer(ctx);
    // No session id generator: stateless mode, one transport per request.
    const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    // The SDK's types predate exactOptionalPropertyTypes; the runtime contract is met.
    await server.connect(transport as unknown as Transport);
    await transport.handleRequest(req, res, body);
  }
}
