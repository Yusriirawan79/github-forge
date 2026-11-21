// The forge's HTTP server: one process, stdlib only. It routes /healthz, the git smart-HTTP
// surface, REST v3, GraphQL v4 and MCP, and answers a JSON 404 for everything else.
// Authentication: every /api/v3, /api/graphql and /mcp call needs a Bearer token —
// the trial token in MAKEFUN_SHOP_TOKEN when it is set, any non-empty Bearer when it is
// not (local grading). /healthz and the git endpoints take none.

import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { Server as NetServer } from 'node:net';
import { createFastServer } from './fastserver.ts';

/** Minimal request/response surface the handlers need. The stdlib http server's
 * IncomingMessage/ServerResponse satisfy it, and so does the raw-socket fast
 * server in fastserver.ts (which pre-buffers the body instead of streaming it). */
export interface MiniReq {
  method?: string;
  url?: string;
  headers: Record<string, string | string[] | undefined>;
  /** Pre-buffered body (fast server only); when present readBody returns it at once. */
  body?: Buffer;
  destroy?(): void;
}
export interface MiniRes {
  writeHead(status: number, headers?: Record<string, string | number | string[]>): void;
  end(data?: string | Buffer): void;
  readonly headersSent: boolean;
  destroy?(): void;
}
import { handleGraphql } from './graphql.ts';
import { handleInfoRefs, handleReceivePack, handleUploadPack } from './gitproto.ts';
import { handleMcp } from './mcp.ts';
import { handleRest, sendJson, type RestCtx } from './rest.ts';
import { Store } from './store.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

/** Read the whole request body (git packs can be large; cap at 256 MiB). */
function readBody(req: MiniReq): Promise<Buffer> {
  if (req.body !== undefined) return Promise.resolve(req.body);
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    (req as IncomingMessage).on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 256 * 1024 * 1024) {
        reject(new Error('request body too large'));
        (req as IncomingMessage).destroy();
        return;
      }
      chunks.push(chunk);
    });
    (req as IncomingMessage).on('end', () => resolve(Buffer.concat(chunks)));
    (req as IncomingMessage).on('error', reject);
  });
}

function pathOf(req: MiniReq): { path: string; query: URLSearchParams } {
  const raw = req.url ?? '/';
  const q = raw.indexOf('?');
  if (q < 0) return { path: raw, query: new URLSearchParams() };
  return { path: raw.slice(0, q), query: new URLSearchParams(raw.slice(q + 1)) };
}

/** The bearer <redacted> the trial presents, when the environment names one. */
function expectedToken(): string {
  return process.env.MAKEFUN_SHOP_TOKEN ?? '';
}

/** 401 unless the request carries the expected Bearer token. */
function checkAuth(req: MiniReq, res: MiniRes, requestId: string): boolean {
  const header = req.headers.authorization ?? '';
  if (!header.startsWith('Bearer ') || header.length === 7) {
    const text = `${JSON.stringify({ message: 'Requires authentication' })}\n`;
    res.writeHead(401, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text), 'x-github-request-id': requestId });
    res.end(text);
    return false;
  }
  const expected = expectedToken();
  if (expected !== '' && header.slice(7) !== expected) {
    const text = `${JSON.stringify({ message: 'Bad credentials' })}\n`;
    res.writeHead(401, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text), 'x-github-request-id': requestId });
    res.end(text);
    return false;
  }
  return true;
}

export function createApp(): Server | NetServer {
  const store = new Store();
  let requestSeq = 0;

  const handle = async (req: MiniReq, res: MiniRes): Promise<void> => {
    requestSeq += 1;
    const requestId = `forge-${requestSeq}`;
    try {
      const { path, query } = pathOf(req);
      const method = req.method ?? 'GET';

      // The env's boot probe: 200 {"ok":true}, no token.
      if (method === 'GET' && path === '/healthz') {
        const text = '{"ok":true}\n';
        res.writeHead(200, { 'content-type': JSON_TYPE, 'content-length': text.length, 'x-github-request-id': requestId });
        res.end(text);
        return;
      }

      // Git smart HTTP: /{owner}/{repo}.git/info/refs, /git-upload-pack, /git-receive-pack.
      const gitMatch = /^\/([^/]+)\/([^/]+)\.git(\/.*)?$/.exec(path);
      if (gitMatch !== null) {
        const owner = decodeURIComponent(gitMatch[1] as string);
        const repoName = decodeURIComponent(gitMatch[2] as string);
        const sub = gitMatch[3] ?? '';
        const repo = store.getRepo(owner, repoName);
        if (method === 'GET' && sub === '/info/refs') {
          handleInfoRefs(repo, query.get('service') ?? '', req, res);
          return;
        }
        if (method === 'POST' && sub === '/git-upload-pack') {
          const body = await readBody(req);
          handleUploadPack(repo, body, req, res);
          return;
        }
        if (method === 'POST' && sub === '/git-receive-pack') {
          const body = await readBody(req);
          handleReceivePack(repo, body, req, res);
          return;
        }
        const text = `${JSON.stringify({ message: 'Not Found' })}\n`;
        res.writeHead(404, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text), 'x-github-request-id': requestId });
        res.end(text);
        return;
      }

      // MCP: raw body (a malformed body must answer -32700 from the MCP handler itself).
      if (path === '/mcp') {
        if (!checkAuth(req, res, requestId)) return;
        const body = await readBody(req);
        handleMcp(store, req, res, body, requestId);
        return;
      }

      // GraphQL.
      if (path === '/api/graphql') {
        if (!checkAuth(req, res, requestId)) return;
        const raw = await readBody(req);
        let parsed: unknown = null;
        if (raw.length > 0) {
          try {
            parsed = JSON.parse(raw.toString('utf8'));
          } catch {
            const text = `${JSON.stringify({ message: 'Problems parsing JSON' })}\n`;
            res.writeHead(400, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text), 'x-github-request-id': requestId });
            res.end(text);
            return;
          }
        }
        const ctx: RestCtx = { store, req, res, segments: [], query, body: parsed, requestId };
        handleGraphql(ctx);
        return;
      }

      // REST v3.
      if (path === '/api/v3' || path.startsWith('/api/v3/')) {
        if (!checkAuth(req, res, requestId)) return;
        // A GET/HEAD with no Content-Length and no Transfer-Encoding carries no
        // body, so there is nothing to wait for: skip the read and answer at once.
        // Anything that may carry a body still goes through readBody, so a
        // keep-alive socket is never left with unread bytes on it.
        const contentLength = req.headers['content-length'];
        const mayHaveBody =
          (method !== 'GET' && method !== 'HEAD') ||
          req.headers['transfer-encoding'] !== undefined ||
          (typeof contentLength === 'string' && contentLength !== '0');
        const raw = mayHaveBody ? await readBody(req) : Buffer.alloc(0);
        let parsed: unknown = null;
        if (raw.length > 0) {
          try {
            parsed = JSON.parse(raw.toString('utf8'));
          } catch {
            const text = `${JSON.stringify({ message: 'Problems parsing JSON' })}\n`;
            res.writeHead(400, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text), 'x-github-request-id': requestId });
            res.end(text);
            return;
          }
        }
        const restPath = path === '/api/v3' ? '' : path.slice('/api/v3/'.length);
        const segments = restPath === '' ? [] : restPath.split('/').filter((s) => s !== '');
        const ctx: RestCtx = { store, req, res, segments, query, body: parsed, requestId };
        handleRest(ctx);
        return;
      }

      // Everything else: GitHub's JSON 404.
      const text = `${JSON.stringify({ message: 'Not Found' })}\n`;
      res.writeHead(404, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text), 'x-github-request-id': requestId });
      res.end(text);
    } catch (err) {
      if (!res.headersSent) {
        const text = `${JSON.stringify({ message: err instanceof Error ? err.message : 'Internal Server Error' })}\n`;
        res.writeHead(500, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text), 'x-github-request-id': requestId });
        res.end(text);
      } else {
        res.destroy?.();
      }
    }
  };

  if (process.env.USE_HTTP === '1') {
    const server = createServer((req: IncomingMessage, res) => {
      void handle(req as unknown as MiniReq, res as unknown as MiniRes);
    });
    server.keepAliveTimeout = 65_000;
    server.headersTimeout = 66_000;
    return server;
  }
  return createFastServer(handle);
}

// Keep sendJson linked: app.ts answers its own small JSON bodies inline above, and the
// REST module owns the rest.
export { sendJson };
