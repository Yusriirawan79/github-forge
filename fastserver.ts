// Raw-socket HTTP/1.1 server for the bench hot paths. Node's http.Server spends
// most of a tiny request's CPU on its parser, IncomingMessage/ServerResponse
// allocation, writeHead machinery and per-request header objects. The bench's
// workloads are thousands of small exchanges on keep-alive sockets, so this
// server parses the request line + headers itself, pre-buffers the body, and
// answers with a single socket.write of [head, body]. It speaks exactly what
// the harness clients send: HTTP/1.1, Content-Length bodies (and chunked, for
// safety), keep-alive, sequential requests per socket. Anything malformed
// closes the socket; the handlers above still own all semantics.

import { createServer as createNetServer, type Server as NetServer, type Socket } from 'node:net';
import type { MiniReq, MiniRes } from './app.ts';

const REASONS: Record<number, string> = {
  200: 'OK',
  201: 'Created',
  202: 'Accepted',
  204: 'No Content',
  400: 'Bad Request',
  401: 'Unauthorized',
  404: 'Not Found',
  405: 'Method Not Allowed',
  500: 'Internal Server Error',
};

interface ParsedRequest {
  method: string;
  target: string;
  headers: Record<string, string | undefined>;
  body: Buffer;
  consumed: number;
  keepAlive: boolean;
}

/** Parse one complete request from `buf`, or null when more bytes are needed. */
function tryParse(buf: Buffer, socket: Socket, sent100: { value: boolean }): ParsedRequest | null {
  const headEnd = buf.indexOf('\r\n\r\n');
  if (headEnd < 0) {
    if (buf.length > 65536) throw new Error('request head too large');
    return null;
  }
  const head = buf.subarray(0, headEnd).toString('ascii');
  const lines = head.split('\r\n');
  const requestLine = lines[0] as string;
  const sp1 = requestLine.indexOf(' ');
  const sp2 = requestLine.indexOf(' ', sp1 + 1);
  if (sp1 < 0 || sp2 < 0) throw new Error('bad request line');
  const method = requestLine.slice(0, sp1);
  const target = requestLine.slice(sp1 + 1, sp2);
  if (method.length === 0 || !target.startsWith('/')) throw new Error('bad request line');
  const headers: Record<string, string | undefined> = {};
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i] as string;
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    const prev = headers[name];
    headers[name] = prev === undefined ? value : `${prev}, ${value}`;
  }
  const expect = headers.expect ?? '';
  if (expect.toLowerCase() === '100-continue' && !sent100.value) {
    sent100.value = true;
    socket.write('HTTP/1.1 100 Continue\r\n\r\n');
  }
  const te = (headers['transfer-encoding'] ?? '').toLowerCase();
  let bodyStart = headEnd + 4;
  let body: Buffer;
  let consumed: number;
  if (te.includes('chunked')) {
    // Decode chunked bodies in place; null until the terminating chunk + trailers arrive.
    let pos = bodyStart;
    const chunks: Buffer[] = [];
    for (;;) {
      const eol = buf.indexOf('\r\n', pos);
      if (eol < 0) return null;
      const size = parseInt(buf.subarray(pos, eol).toString('ascii').trim(), 16);
      if (Number.isNaN(size) || size < 0) throw new Error('bad chunk size');
      const dataStart = eol + 2;
      if (size === 0) {
        // Trailers end at the first empty line.
        const trailerEnd = buf.indexOf('\r\n\r\n', dataStart);
        if (trailerEnd < 0) {
          const single = buf.indexOf('\r\n', dataStart);
          if (single < 0) return null;
          consumed = single + 2;
        } else {
          consumed = trailerEnd + 4;
        }
        body = chunks.length === 1 ? (chunks[0] as Buffer) : Buffer.concat(chunks);
        break;
      }
      if (buf.length < dataStart + size + 2) return null;
      chunks.push(buf.subarray(dataStart, dataStart + size));
      pos = dataStart + size + 2;
    }
  } else {
    const len = headers['content-length'] === undefined ? 0 : parseInt(headers['content-length'], 10);
    if (Number.isNaN(len) || len < 0) throw new Error('bad content-length');
    if (buf.length < bodyStart + len) return null;
    body = len === 0 ? Buffer.alloc(0) : buf.subarray(bodyStart, bodyStart + len);
    consumed = bodyStart + len;
  }
  const connection = (headers.connection ?? '').toLowerCase();
  const http10 = requestLine.endsWith('HTTP/1.0');
  const keepAlive = connection === 'close' ? false : connection === 'keep-alive' ? true : !http10;
  return { method, target, headers, body, consumed, keepAlive };
}

/** The fast response: buffers everything, then writes head + body in one go. */
class FastRes implements MiniRes {
  headersSent = false;
  private status = 200;
  private headers: Record<string, string | number | string[]> = {};
  private parts: Buffer[] = [];
  private done = false;
  private readonly socket: Socket;
  private readonly onDone: (keepAlive: boolean) => void;
  private readonly keepAlive: boolean;

  constructor(socket: Socket, onDone: (keepAlive: boolean) => void, keepAlive: boolean) {
    this.socket = socket;
    this.onDone = onDone;
    this.keepAlive = keepAlive;
  }

  writeHead(status: number, headers?: Record<string, string | number | string[]>): void {
    if (this.headersSent) throw new Error('headers already sent');
    this.status = status;
    if (headers !== undefined) this.headers = headers;
  }

  write(chunk: string | Buffer): boolean {
    this.parts.push(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk);
    return true;
  }

  end(data?: string | Buffer): void {
    if (this.done) return;
    this.done = true;
    if (data !== undefined) this.parts.push(typeof data === 'string' ? Buffer.from(data, 'utf8') : data);
    const body = this.parts.length === 1 ? (this.parts[0] as Buffer) : Buffer.concat(this.parts);
    const headerLines: string[] = [`HTTP/1.1 ${this.status} ${REASONS[this.status] ?? ''}`];
    let hasLength = false;
    for (const [name, value] of Object.entries(this.headers)) {
      const key = name.toLowerCase();
      if (key === 'content-length') hasLength = true;
      headerLines.push(`${key}: ${value}`);
    }
    if (!hasLength) headerLines.push(`content-length: ${body.length}`);
    headerLines.push(`date: ${new Date().toUTCString()}`);
    const head = Buffer.from(`${headerLines.join('\r\n')}\r\n\r\n`, 'ascii');
    this.headersSent = true;
    this.socket.write(Buffer.concat([head, body]));
    this.onDone(this.keepAlive);
  }

  destroy(): void {
    this.socket.destroy();
  }
}

export type FastHandler = (req: MiniReq, res: MiniRes) => Promise<void> | void;

export function createFastServer(handle: FastHandler): NetServer {
  return createNetServer((socket: Socket) => {
    socket.setNoDelay(true);
    socket.setTimeout(120_000, () => socket.destroy());
    let buf = Buffer.alloc(0);
    let busy = false;
    let dead = false;
    const sent100 = { value: false };

    const pump = (): void => {
      if (busy || dead) return;
      let parsed: ParsedRequest | null;
      try {
        parsed = tryParse(buf, socket, sent100);
      } catch {
        dead = true;
        socket.destroy();
        return;
      }
      if (parsed === null) return;
      buf = buf.subarray(parsed.consumed);
      sent100.value = false;
      busy = true;
      const req: MiniReq = {
        method: parsed.method,
        url: parsed.target,
        headers: parsed.headers,
        body: parsed.body,
        destroy: () => socket.destroy(),
      };
      const res = new FastRes(socket, (keepAlive: boolean) => {
        busy = false;
        if (!keepAlive || dead) {
          dead = true;
          socket.end();
          return;
        }
        pump();
      }, parsed.keepAlive);
      try {
        const out = handle(req, res);
        if (out !== undefined) {
          void Promise.resolve(out).catch(() => {
            if (!res.headersSent) {
              try {
                res.writeHead(500, { 'content-type': 'application/json; charset=utf-8', 'content-length': 22 });
                res.end('{"message":"error"}\n');
              } catch {
                socket.destroy();
              }
            } else {
              socket.destroy();
            }
          });
        }
      } catch {
        if (!res.headersSent) {
          try {
            res.writeHead(500, { 'content-type': 'application/json; charset=utf-8', 'content-length': 22 });
            res.end('{"message":"error"}\n');
          } catch {
            socket.destroy();
          }
        } else {
          socket.destroy();
        }
      }
    };

    socket.on('data', (chunk: Buffer) => {
      buf = buf.length === 0 ? chunk : Buffer.concat([buf, chunk]);
      pump();
    });
    socket.on('error', () => {
      dead = true;
    });
    socket.on('close', () => {
      dead = true;
    });
  });
}
