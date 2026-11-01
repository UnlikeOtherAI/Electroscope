import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { hostname as osHostname } from 'node:os';
import { isIP } from 'node:net';
import type { AddressInfo } from 'node:net';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import type { ClientInfo } from '../../shared/types.js';

export interface McpHttpOptions {
  port: number;
  /** Interface to bind: 0.0.0.0 for the whole network (default), 127.0.0.1 for this computer only. */
  host?: string;
  /** Extra DNS names this computer answers to (its own hostname is always allowed). */
  names?: string[];
  version: string;
  /** Called once per agent session; the ClientInfo is live and gains its id once the session starts. */
  createServer: (client: ClientInfo) => McpServer;
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

/**
 * DNS-rebinding defence. A page on an attacker's domain can be made to resolve to this computer, but
 * its requests still carry that domain in Host. So accept only IP literals, localhost and this
 * computer's own names; anything else is refused.
 */
function hostAllowed(hostHeader: string | undefined, names: Set<string>): boolean {
  if (!hostHeader) return false;
  const name = hostHeader.replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase();
  return isIP(name) !== 0 || name === 'localhost' || names.has(name);
}

/** Browsers always send Origin on cross-site requests; a legitimate agent sends none. */
function originAllowed(origin: string | undefined, hostHeader: string | undefined): boolean {
  if (!origin) return true;
  try {
    return new URL(origin).host.toLowerCase() === hostHeader?.toLowerCase();
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
  const host = opts.host ?? '0.0.0.0';
  const own = osHostname().toLowerCase();
  const names = new Set([own, `${own}.local`, ...(opts.names ?? []).map((n) => n.toLowerCase())]);
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
    if (!hostAllowed(req.headers.host, names) || !originAllowed(req.headers.origin, req.headers.host)) {
      return rpcError(res, 403, -32000, 'Forbidden: connect using this computer\'s IP address or hostname');
    }
    const url = new URL(req.url ?? '/', 'http://electroscope');

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
        const server = opts.createServer(info);
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
        try {
          session.info.lastSeen = new Date().toISOString();
          await session.transport.handleRequest(req, res, body);
        } catch (e) {
          // The session id is only assigned once initialize succeeds; without it `drop` cannot
          // find this server later, so close it here rather than leak it for the app's lifetime.
          if (!info.id) await server.close().catch(() => undefined);
          throw e;
        }
        if (!info.id) await server.close().catch(() => undefined);
        return;
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
