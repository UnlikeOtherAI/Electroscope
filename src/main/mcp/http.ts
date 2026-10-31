import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import type { ClientInfo } from '../../shared/types.js';

export interface McpHttpOptions {
  port: number;
  host?: string;
  version: string;
  createServer: () => McpServer;
  onClientsChanged?: (clients: ClientInfo[]) => void;
  /** Sessions idle for longer than this are dropped. */
  sessionTtlMs?: number;
}

interface Session {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
  info: ClientInfo;
}

export interface McpHttp {
  port: number;
  url: string;
  clients(): ClientInfo[];
  close(): Promise<void>;
}

const MAX_BODY = 1_000_000;

/** Loopback only: reject anything whose Host or Origin is not localhost (DNS-rebinding protection). */
function isLocalHost(value: string | undefined): boolean {
  if (!value) return false;
  const host = value.replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase();
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

function isAllowedOrigin(origin: string | undefined): boolean {
  if (!origin) return true; // non-browser clients send none
  try {
    return isLocalHost(new URL(origin).host);
  } catch {
    return false;
  }
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (chunks.length === 0) return resolve(undefined);
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new SyntaxError('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) return;
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function rpcError(res: ServerResponse, status: number, code: number, message: string): void {
  sendJson(res, status, { jsonrpc: '2.0', error: { code, message }, id: null });
}

export async function startMcpHttp(opts: McpHttpOptions): Promise<McpHttp> {
  const host = opts.host ?? '127.0.0.1';
  const ttl = opts.sessionTtlMs ?? 30 * 60_000;
  const sessions = new Map<string, Session>();

  const emit = () => opts.onClientsChanged?.([...sessions.values()].map((s) => s.info));

  const drop = (id: string) => {
    const s = sessions.get(id);
    if (!s) return;
    sessions.delete(id);
    void s.server.close().catch(() => undefined);
    emit();
  };

  const sweeper = setInterval(() => {
    const cutoff = Date.now() - ttl;
    for (const [id, s] of sessions) if (Date.parse(s.info.lastSeen) < cutoff) drop(id);
  }, 60_000);
  sweeper.unref();

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (!isLocalHost(req.headers.host) || !isAllowedOrigin(req.headers.origin)) {
      return rpcError(res, 403, -32000, 'Forbidden: Electroscope only accepts local connections');
    }
    const url = new URL(req.url ?? '/', `http://${host}`);

    if (url.pathname === '/health') {
      return sendJson(res, 200, { name: 'electroscope', version: opts.version, ok: true, clients: sessions.size });
    }
    if (url.pathname !== '/mcp') {
      return sendJson(res, 404, { error: 'Not found. The MCP endpoint is /mcp' });
    }

    const sessionId = req.headers['mcp-session-id'];
    const sid = Array.isArray(sessionId) ? sessionId[0] : sessionId;

    if (req.method === 'POST') {
      let body: unknown;
      try {
        body = await readBody(req);
      } catch (e) {
        return rpcError(res, 400, -32700, (e as Error).message);
      }
      let session = sid ? sessions.get(sid) : undefined;
      if (!session) {
        if (sid || !isInitializeRequest(body)) {
          return rpcError(res, sid ? 404 : 400, -32000, sid ? 'Unknown session' : 'No session: send initialize first');
        }
        const params = (body as { params?: { clientInfo?: { name?: string; version?: string } } }).params;
        const now = new Date().toISOString();
        const info: ClientInfo = {
          id: '',
          name: params?.clientInfo?.name ?? 'unknown client',
          version: params?.clientInfo?.version ?? '',
          connectedAt: now,
          lastSeen: now,
        };
        const server = opts.createServer();
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => {
            info.id = id;
            sessions.set(id, { transport, server, info });
            emit();
          },
        });
        transport.onclose = () => {
          if (info.id) drop(info.id);
        };
        await server.connect(transport);
        session = { transport, server, info };
      }
      session.info.lastSeen = new Date().toISOString();
      await session.transport.handleRequest(req, res, body);
      return;
    }

    if (req.method === 'GET' || req.method === 'DELETE') {
      const session = sid ? sessions.get(sid) : undefined;
      if (!session) return rpcError(res, sid ? 404 : 400, -32000, 'Unknown or missing session');
      session.info.lastSeen = new Date().toISOString();
      await session.transport.handleRequest(req, res);
      if (req.method === 'DELETE' && sid) drop(sid);
      return;
    }

    res.setHeader('allow', 'GET, POST, DELETE');
    rpcError(res, 405, -32000, 'Method not allowed');
  };

  const httpServer: Server = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      rpcError(res, 500, -32603, err instanceof Error ? err.message : 'Internal error');
    });
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(opts.port, host, () => {
      httpServer.off('error', reject);
      resolve();
    });
  });

  const port = (httpServer.address() as AddressInfo).port;
  return {
    port,
    url: `http://127.0.0.1:${port}/mcp`,
    clients: () => [...sessions.values()].map((s) => s.info),
    close: async () => {
      clearInterval(sweeper);
      for (const id of [...sessions.keys()]) drop(id);
      httpServer.closeAllConnections();
      await new Promise<void>((r) => httpServer.close(() => r()));
    },
  };
}
