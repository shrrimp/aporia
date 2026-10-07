import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import { isWithin } from '@app/core';
import { AppError } from './errors.ts';
import { methods, type ClientMessage, type Method, type ServerMessage } from './protocol.ts';
import type { AppService } from './app.ts';

export interface ServeOptions {
  readonly app: AppService;
  readonly port?: number;
  /** Directory with the built UI, served at "/". */
  readonly staticDir?: string;
  /** Extra origins allowed to connect (e.g. the Vite dev server). The server's own origin is always allowed. */
  readonly allowedOrigins?: readonly string[];
  /** Fixed token (tests, Electron); random otherwise. */
  readonly token?: string;
}

export interface Served {
  readonly url: string;
  readonly token: string;
  close(): Promise<void>;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
};

const MAX_MESSAGE = 4 * 1024 * 1024;

/**
 * Serves the UI and the RPC WebSocket on 127.0.0.1. The socket requires the per-launch token
 * and an allowed Origin, so other local web pages cannot drive the app.
 */
export async function serve(opts: ServeOptions): Promise<Served> {
  const token = opts.token ?? randomBytes(24).toString('hex');
  const http: Server = createServer((req, res) => void serveStatic(req, res, opts.staticDir));
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE });
  await new Promise<void>((resolve) => http.listen(opts.port ?? 0, '127.0.0.1', resolve));
  const { port } = http.address() as AddressInfo;
  const self = `http://127.0.0.1:${port}`;
  const allowed = new Set([self, `http://localhost:${port}`, ...(opts.allowedOrigins ?? [])]);

  http.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', self);
    const origin = req.headers.origin;
    if (url.pathname !== '/rpc' || url.searchParams.get('token') !== token || (origin !== undefined && !allowed.has(origin))) {
      socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => connection(ws, opts.app));
  });

  return {
    url: self,
    token,
    async close() {
      for (const c of wss.clients) c.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      http.closeAllConnections();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}

function connection(ws: WebSocket, app: AppService): void {
  const send = (m: ServerMessage) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(m));
  };
  const unsubscribe = app.subscribe((event, data) => send({ event, data }));
  ws.on('close', unsubscribe);
  ws.on('message', (raw) => {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw.toString()) as ClientMessage;
    } catch {
      return; // not JSON: nothing to answer to
    }
    if (typeof msg !== 'object' || msg === null || typeof msg.id !== 'number' || typeof msg.method !== 'string') return;
    if (!Object.hasOwn(methods, msg.method)) {
      send({ id: msg.id, error: { code: 'unknown_method', message: `unknown method ${msg.method}` } });
      return;
    }
    app.call(msg.method as Method, msg.params).then(
      (result) => send({ id: msg.id, result }),
      (err: unknown) => {
        const e = err instanceof AppError ? err : new AppError('internal', String(err));
        send({ id: msg.id, error: { code: e.code, message: e.message, ...(e.data === undefined ? {} : { data: e.data }) } });
      },
    );
  });
}

/** The UI never needs the network: only itself and its own socket. Workers (the editor's) load from the app too. */
const SECURITY_HEADERS = {
  'content-security-policy':
    "default-src 'self'; connect-src 'self' ws://127.0.0.1:* ws://localhost:*; img-src 'self' data:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; worker-src 'self'",
  'x-content-type-options': 'nosniff',
};

async function serveStatic(req: IncomingMessage, res: ServerResponse, dir: string | undefined): Promise<void> {
  if (!dir || (req.method !== 'GET' && req.method !== 'HEAD')) {
    res.writeHead(404).end();
    return;
  }
  const pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
  const file = path.resolve(dir, `.${pathname === '/' ? '/index.html' : pathname}`);
  if (!isWithin(path.resolve(dir), file)) {
    res.writeHead(403).end();
    return;
  }
  try {
    const body = await readFile(file);
    res
      .writeHead(200, {
        'content-type': MIME[path.extname(file)] ?? 'application/octet-stream',
        // The UI never needs the network: only itself and its own socket.
        ...SECURITY_HEADERS,
      })
      .end(body);
  } catch {
    // Single-page app: unknown paths get the shell, under the same policy.
    try {
      const shell = await readFile(path.join(dir, 'index.html'));
      res.writeHead(200, { 'content-type': MIME['.html']!, ...SECURITY_HEADERS }).end(shell);
    } catch {
      res.writeHead(404).end();
    }
  }
}
