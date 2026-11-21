import { afterEach, expect, it } from 'vitest';
import { request, type ClientRequest, type IncomingMessage } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startMcpHttp, type McpHttp } from '../src/main/mcp/http.js';

const GRACE = 150;

let http: McpHttp;
let announced: string[][] = [];

async function start(presenceLeaseMs?: number) {
  announced = [];
  http = await startMcpHttp({
    port: 0,
    host: '127.0.0.1',
    version: 'test',
    streamGraceMs: GRACE,
    presenceLeaseMs,
    createServer: () => new McpServer({ name: 'electroscope', version: 'test' }),
    onClientsChanged: (list) => announced.push(list.map((c) => c.name)),
  });
}

afterEach(async () => {
  await http.close();
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const names = () => http.clients().map((c) => c.name);

/** Aborting a fetch takes a moment to reach the other end, so wait for the effect, not a delay. */
async function until(done: () => boolean, ms = 4000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!done() && Date.now() < deadline) await sleep(25);
}

const INITIALIZE = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'raw-agent', version: '1.0.0' },
  },
};

/** Opens a session the way an agent does, and hands back its id. */
async function initialize(): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port: http.port,
        path: '/mcp',
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      },
      (res) => {
        const id = res.headers['mcp-session-id'];
        res.resume();
        res.on('end', () => (typeof id === 'string' ? resolve(id) : reject(new Error('no session id'))));
      },
    );
    req.on('error', reject);
    req.end(JSON.stringify(INITIALIZE));
  });
}

/** Opens the server-to-client event stream and leaves it open. */
async function openStream(sid: string): Promise<{ req: ClientRequest; res: IncomingMessage }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port: http.port,
        path: '/mcp',
        method: 'GET',
        headers: { accept: 'text/event-stream', 'mcp-session-id': sid },
      },
      (res) => {
        res.resume();
        resolve({ req, res });
      },
    );
    req.on('error', () => undefined);
    req.end();
  });
}

it('forgets an agent that walks away without saying so', async () => {
  await start();
  // The SDK's client closes its transport locally and never sends a DELETE, which is exactly
  // the case that used to leave a ghost in the window for half an hour.
  const client = new Client({ name: 'quiet-leaver', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${http.port}/mcp`)));
  // The client opens its event stream just after initialize, so do a round trip first: this is an
  // agent that worked for a while and then walked away, not one that never arrived.
  await client.ping();
  await sleep(200);
  expect(names()).toEqual(['quiet-leaver']);

  await client.close();
  await until(() => names().length === 0);
  expect(names()).toEqual([]);
  expect(announced.at(-1)).toEqual([]);
});

it('keeps an agent that loses its stream and comes straight back', async () => {
  await start();
  const sid = await initialize();
  const first = await openStream(sid);
  expect(names()).toEqual(['raw-agent']);

  first.req.destroy();
  await sleep(GRACE / 3);
  const second = await openStream(sid);
  await sleep(GRACE * 3);

  expect(names()).toEqual(['raw-agent']);
  second.req.destroy();
});

it('keeps an agent that never opens a stream at all', async () => {
  await start();
  // A POST-only client is legitimate; nothing about it says it has gone.
  await initialize();
  await sleep(GRACE * 3);
  expect(names()).toEqual(['raw-agent']);
});

it('does not evict an agent when a second stream is refused', async () => {
  await start();
  const sid = await initialize();
  const real = await openStream(sid);
  const refused = await openStream(sid);
  expect(refused.res.statusCode).toBe(409);

  await sleep(GRACE * 3);
  expect(names()).toEqual(['raw-agent']);
  real.req.destroy();
});

it('still removes an agent that says goodbye properly', async () => {
  await start();
  const sid = await initialize();
  await openStream(sid);
  const status = await new Promise<number>((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port: http.port, path: '/mcp', method: 'DELETE', headers: { 'mcp-session-id': sid } },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      },
    );
    req.on('error', reject);
    req.end();
  });
  expect(status).toBeLessThan(300);
  expect(names()).toEqual([]);
});

it.each(['POST only', 'open stream'])('expires and renews presence with %s', async (mode) => {
  const lease = 1200;
  await start(lease);
  const sid = await initialize();
  if (mode === 'open stream') await openStream(sid);
  const health = async () => (await fetch(new URL('/health', http.url))).json();
  const ping = () => fetch(http.url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-session-id': sid,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' }),
  });

  await sleep(lease * 0.6);
  expect((await ping()).status).toBe(200);
  await sleep(lease * 0.6);
  expect(names()).toEqual(['raw-agent']);
  await until(() => names().length === 0);
  expect(names()).toEqual([]);
  expect(announced.at(-1)).toEqual([]);
  expect(await health()).toMatchObject({ clients: 0 });

  expect((await ping()).status).toBe(200);
  expect(announced.at(-1)).toEqual(['raw-agent']);
  expect(await health()).toMatchObject({ clients: 1 });
});
