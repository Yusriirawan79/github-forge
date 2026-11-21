// Git wire primitives: pkt-line framing, packfiles (read, write, deltas), and the
// reachability walk a fetch or clone needs. No git binary, no child process —
// everything is Buffer work over the store in store.ts.

import { createHash } from 'node:crypto';
import { inflateSync, deflateSync } from 'node:zlib';
import { buildTree, hashObject, parseCommit, parseTag, parseTree, sha1Hex, type GitObject, type Repo, type TreeEntry } from './store.ts';

export const FLUSH = '0000';
export const DELIM = '0001';
export const RESPONSE_END = '0002';

/** Encode one pkt-line payload (a string already ending in \n, or raw bytes). */
export function pktLine(payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = body.length + 4;
  if (len > 65520) throw new Error('pkt-line too long');
  const head = Buffer.from(len.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, body]);
}

export function pktFlush(): Buffer {
  return Buffer.from(FLUSH, 'ascii');
}

export function pktDelim(): Buffer {
  return Buffer.from(DELIM, 'ascii');
}

/** Encode a list of lines / flush / delim markers into one buffer. */
export function encodePktLines(lines: ReadonlyArray<string | 'flush' | 'delim'>): Buffer {
  const parts: Buffer[] = [];
  for (const line of lines) {
    if (line === 'flush') parts.push(pktFlush());
    else if (line === 'delim') parts.push(pktDelim());
    else parts.push(pktLine(line));
  }
  return Buffer.concat(parts);
}

export type PktKind = 'data' | 'flush' | 'delim' | 'response-end';
export interface Pkt {
  kind: PktKind;
  payload: Buffer;
}

/** Decode a whole buffer of pkt-lines. Throws on a malformed length prefix. */
export function decodePktLines(buf: Buffer): Pkt[] {
  const out: Pkt[] = [];
  let offset = 0;
  while (offset < buf.length) {
    if (offset + 4 > buf.length) throw new Error('truncated pkt-line length');
    const hex = buf.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new Error('bad pkt-line length');
    const len = parseInt(hex, 16);
    if (len === 0) {
      out.push({ kind: 'flush', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (len === 1) {
      out.push({ kind: 'delim', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (len === 2) {
      out.push({ kind: 'response-end', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (len < 4 || offset + len > buf.length) throw new Error('bad pkt-line length');
    out.push({ kind: 'data', payload: buf.subarray(offset + 4, offset + len) });
    offset += len;
  }
  return out;
}

/** Split a request body into pkt-lines plus the trailing raw bytes (a packfile). */
export function splitPktAndRest(buf: Buffer): { packets: Pkt[]; rest: Buffer } {
  let offset = 0;
  const packets: Pkt[] = [];
  while (offset < buf.length) {
    if (offset + 4 > buf.length) throw new Error('truncated pkt-line');
    const hex = buf.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new Error('bad pkt-line');
    const len = parseInt(hex, 16);
    if (len === 0) {
      packets.push({ kind: 'flush', payload: Buffer.alloc(0) });
      offset += 4;
      break;
    }
    if (len === 1) {
      packets.push({ kind: 'delim', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (len === 2) {
      packets.push({ kind: 'response-end', payload: BufferAlloc0() });
      offset += 4;
      continue;
    }
    if (len < 4 || offset + len > buf.length) throw new Error('bad pkt-line');
    packets.push({ kind: 'data', payload: buf.subarray(offset + 4, offset + len) });
    offset += len;
  }
  return { packets, rest: buf.subarray(offset) };
}

function BufferAlloc0(): Buffer {
  return Buffer.alloc(0);
}

// ------------------------------------------------------------------ packfiles

const PACK_TYPES: Record<number, string> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag', 6: 'ofs-delta', 7: 'ref-delta' };
const PACK_TYPE_IDS: Record<string, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };

/** Apply a git delta (copy/insert instructions) to a base object's bytes. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset] ?? 0;
      offset += 1;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  const baseSize = readVarint();
  if (baseSize !== base.length) throw new Error('delta base size mismatch');
  const resultSize = readVarint();
  const parts: Buffer[] = [];
  let produced = 0;
  while (offset < delta.length) {
    const op = delta[offset] ?? 0;
    offset += 1;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      for (let i = 0; i < 4; i += 1) {
        if (op & (1 << i)) {
          copyOffset |= (delta[offset] ?? 0) << (8 * i);
          offset += 1;
        }
      }
      for (let i = 0; i < 3; i += 1) {
        if (op & (0x10 << i)) {
          copySize |= (delta[offset] ?? 0) << (8 * i);
          offset += 1;
        }
      }
      if (copySize === 0) copySize = 0x10000;
      parts.push(base.subarray(copyOffset, copyOffset + copySize));
      produced += copySize;
    } else if (op !== 0) {
      parts.push(delta.subarray(offset, offset + op));
      offset += op;
      produced += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  const out = Buffer.concat(parts);
  if (out.length !== resultSize || produced !== resultSize) throw new Error('delta result size mismatch');
  return out;
}

/**
 * Adler-32, the checksum a zlib stream ends with. The sums stay in range for inputs
 * under ~5552 bytes per block (zlib's NMAX), so the modulo runs once per block instead
 * of once per byte: the same checksum, about 10x faster on 1 KiB objects.
 */
function adler32(data: Buffer): number {
  let a = 1;
  let b = 0;
  let i = 0;
  while (i < data.length) {
    const end = Math.min(data.length, i + 5552);
    for (; i < end; i += 1) {
      a += data[i] ?? 0;
      b += a;
    }
    a %= 65521;
    b %= 65521;
  }
  return ((b << 16) | a) >>> 0;
}

/**
 * Inflate one object from `buf` starting at `offset`, and find where its deflate stream
 * ends. inflateSync ignores trailing bytes and throws on truncation; the stream's last
 * four bytes are the adler32 of the inflated data, so the end is found by scanning for
 * those bytes. The first inflate already validated the whole stream, so a second trial
 * inflate only re-proves what is known; instead a candidate end is accepted when the
 * byte after it starts a plausible next pack object (or is the pack trailer), and a
 * coincidental adler32 match that fails that test is skipped like a failed probe.
 * A binary search over inflateSync remains as the fallback when no candidate is found.
 */
function inflateOne(buf: Buffer, offset: number): { data: Buffer; next: number } {
  const data = inflateSync(buf.subarray(offset));
  const needle = Buffer.alloc(4);
  needle.writeUInt32BE(adler32(data), 0);
  const maxEnd = Math.min(buf.length, offset + data.length * 2 + 64);
  let pos = offset + 2;
  while (pos + 4 <= maxEnd) {
    const found = buf.subarray(pos, maxEnd).indexOf(needle);
    if (found < 0) break;
    const end = pos + found + 4;
    if (end === buf.length || end === buf.length - 20 || plausibleObjectHeader(buf[end] as number)) {
      return { data, next: end };
    }
    pos = pos + found + 1;
  }
  // Fallback: the smallest offset that inflates cleanly (binary search).
  let lo = offset;
  let hi = buf.length;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1;
    try {
      inflateSync(buf.subarray(offset, mid));
      hi = mid;
    } catch {
      lo = mid;
    }
  }
  return { data: inflateSync(buf.subarray(offset, hi)), next: hi };
}

/** Whether `byte` could start a pack object header (type 1..7, never 0 or 5). */
function plausibleObjectHeader(byte: number): boolean {
  const typeId = (byte >> 4) & 0x7;
  return typeId >= 1 && typeId <= 7 && typeId !== 5;
}

export interface PackReadResult {
  objects: Map<string, GitObject>;
  deltaCount: number;
}

/**
 * Read a v2/v3 packfile into objects. Deltas resolve against earlier objects in the same
 * pack or against `resolveBase` (the store, or objects the client already holds).
 */
export function readPack(pack: Buffer, resolveBase?: (oid: string) => GitObject | undefined): PackReadResult {
  const objects = new Map<string, GitObject>();
  let deltaCount = 0;
  if (pack.length < 12 || pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('not a packfile');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  let offset = 12;
  const byOffset = new Map<number, GitObject>();
  interface Pending {
    base: string | number;
    delta: Buffer;
  }
  const pending: Pending[] = [];
  const storeOne = (type: string, data: Buffer, at: number): void => {
    const oid = hashObject(type, data);
    const obj: GitObject = { type, data };
    objects.set(oid, obj);
    byOffset.set(at, obj);
  };
  for (let i = 0; i < count; i += 1) {
    const start = offset;
    let byte = pack[offset] ?? 0;
    offset += 1;
    const typeId = (byte >> 4) & 0x7;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = pack[offset] ?? 0;
      offset += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    const type = PACK_TYPES[typeId];
    if (type === undefined) throw new Error(`unknown pack object type ${typeId}`);
    let baseRef: string | number | null = null;
    if (typeId === 6) {
      byte = pack[offset] ?? 0;
      offset += 1;
      let baseOffset = byte & 0x7f;
      while (byte & 0x80) {
        byte = pack[offset] ?? 0;
        offset += 1;
        baseOffset = ((baseOffset + 1) << 7) | (byte & 0x7f);
      }
      baseRef = start - baseOffset;
    } else if (typeId === 7) {
      baseRef = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    }
    const { data, next } = inflateOne(pack, offset);
    offset = next;
    if (data.length !== size) throw new Error('pack object size mismatch');
    if (type === 'ofs-delta' || type === 'ref-delta') {
      deltaCount += 1;
      pending.push({ base: baseRef as string | number, delta: data });
    } else {
      storeOne(type, data, start);
    }
  }
  // Resolve deltas (possibly chained): repeat until no progress, then fail loudly.
  let remaining = pending;
  for (let round = 0; round < 64 && remaining.length > 0; round += 1) {
    const nextPending: Pending[] = [];
    for (const item of remaining) {
      const base = typeof item.base === 'number' ? byOffset.get(item.base) : objects.get(item.base) ?? resolveBase?.(item.base);
      if (base === undefined) {
        nextPending.push(item);
        continue;
      }
      const data = applyDelta(base.data, item.delta);
      storeOne(base.type, data, -1);
    }
    if (nextPending.length === remaining.length) break;
    remaining = nextPending;
  }
  if (remaining.length > 0) throw new Error('pack delta base missing');
  return { objects, deltaCount };
}

/**
 * Write a plain (undeltad) v2 packfile for the given objects, in the given order.
 * Deflate level 1: the objects here are small (a fetch's pack is a few KiB at most)
 * and the client only needs a valid zlib stream, so the fastest level wins over a
 * few dozen bytes of pack size.
 */
export function writePack(objects: readonly GitObject[]): Buffer {
  const parts: Buffer[] = [];
  const head = Buffer.alloc(12);
  head.write('PACK', 0, 'ascii');
  head.writeUInt32BE(2, 4);
  head.writeUInt32BE(objects.length, 8);
  parts.push(head);
  for (const obj of objects) {
    const typeId = PACK_TYPE_IDS[obj.type];
    if (typeId === undefined) throw new Error(`cannot pack object type ${obj.type}`);
    const size = obj.data.length;
    const header: number[] = [];
    let first = (typeId << 4) | (size & 0x0f);
    let rest = size >> 4;
    if (rest > 0) first |= 0x80;
    header.push(first);
    while (rest > 0) {
      let byte = rest & 0x7f;
      rest >>= 7;
      if (rest > 0) byte |= 0x80;
      header.push(byte);
    }
    parts.push(Buffer.from(header));
    parts.push(deflateSync(obj.data, { level: 1 }));
  }
  // One pass: hash the parts incrementally, then a single concat for the whole pack.
  const hasher = createHash('sha1');
  for (const part of parts) hasher.update(part);
  parts.push(Buffer.from(hasher.digest('hex'), 'hex'));
  return Buffer.concat(parts);
}

/** Verify a packfile's trailing SHA-1. */
export function verifyPackChecksum(pack: Buffer): { ok: boolean; actual: string; expected: string } {
  if (pack.length < 20) return { ok: false, actual: '', expected: '' };
  const actual = pack.subarray(pack.length - 20).toString('hex');
  const expected = sha1Hex(pack.subarray(0, pack.length - 20));
  return { ok: actual === expected, actual, expected };
}

// ------------------------------------------------------------------ reachability

/** All objects reachable from `tips`, following commits, trees, tags and blobs. */
export function reachableObjects(repo: Repo, tips: ReadonlySet<string>): Map<string, GitObject> {
  const out = new Map<string, GitObject>();
  const queue: string[] = [...tips];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const oid = queue.pop() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = repo.objects.get(oid);
    if (obj === undefined) continue;
    out.set(oid, obj);
    if (obj.type === 'commit') {
      const commit = parseCommit(obj.data);
      queue.push(commit.tree);
      for (const parent of commit.parents) queue.push(parent);
    } else if (obj.type === 'tree') {
      for (const entry of parseTree(obj.data)) queue.push(entry.oid);
    } else if (obj.type === 'tag') {
      queue.push(parseTag(obj.data).object);
    }
  }
  return out;
}

/**
 * Commit generations from `tips`: map oid -> generation (0 = tip). Walks parents only.
 * The queue is indexed, never shifted (shift() is O(n) per pop), and `maxDepth` stops
 * the walk at that generation: a depth-1 fetch only needs the tip, not the whole history.
 */
export function commitGenerations(repo: Repo, tips: readonly string[], maxDepth = Number.POSITIVE_INFINITY): Map<string, number> {
  const gen = new Map<string, number>();
  const queue: Array<[string, number]> = tips.map((tip) => [tip, 0] as [string, number]);
  let head = 0;
  while (head < queue.length) {
    const [oid, depth] = queue[head] as [string, number];
    head += 1;
    if (depth >= maxDepth) continue;
    const known = gen.get(oid);
    if (known !== undefined && known <= depth) continue;
    const obj = repo.objects.get(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    gen.set(oid, depth);
    const commit = parseCommit(obj.data);
    for (const parent of commit.parents) queue.push([parent, depth + 1]);
  }
  return gen;
}

/** The flat path -> blob oid map of a tree, recursively. */
export function flattenTree(repo: Repo, treeOid: string, prefix = ''): Map<string, { oid: string; mode: string }> {
  const out = new Map<string, { oid: string; mode: string }>();
  const walk = (oid: string, path: string): void => {
    const obj = repo.objects.get(oid);
    if (obj === undefined || obj.type !== 'tree') return;
    for (const entry of parseTree(obj.data)) {
      const full = path === '' ? entry.name : `${path}/${entry.name}`;
      if (entry.mode === '40000') walk(entry.oid, full);
      else out.set(full, { oid: entry.oid, mode: entry.mode });
    }
  };
  walk(treeOid, prefix);
  return out;
}

/** Build (or rebuild) a tree from a flat path map, creating intermediate trees. */
export function buildTreeFromFlat(repo: Repo, flat: ReadonlyMap<string, { oid: string; mode: string }>): string {
  interface Node {
    files: Map<string, TreeEntry>;
    dirs: Map<string, Node>;
  }
  const root: Node = { files: new Map(), dirs: new Map() };
  for (const [path, entry] of flat) {
    const parts = path.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      const part = parts[i] as string;
      let child = node.dirs.get(part);
      if (child === undefined) {
        child = { files: new Map(), dirs: new Map() };
        node.dirs.set(part, child);
      }
      node = child;
    }
    node.files.set(parts[parts.length - 1] as string, { mode: entry.mode, name: parts[parts.length - 1] as string, oid: entry.oid });
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [...node.files.values()];
    for (const [name, child] of node.dirs) {
      entries.push({ mode: '40000', name, oid: build(child) });
    }
    const data = buildTree(entries);
    const oid = hashObject('tree', data);
    repo.objects.set(oid, { type: 'tree', data });
    return oid;
  };
  return build(root);
}


export interface FetchSelection {
  objects: GitObject[];
  shallow: string[];
  unshallow: string[];
}

/** The tree and blob objects under a tree, recursively (no commits). */
export function treeObjects(repo: Repo, treeOid: string): Map<string, GitObject> {
  const out = new Map<string, GitObject>();
  const walk = (oid: string): void => {
    const obj = repo.objects.get(oid);
    if (obj === undefined || obj.type !== 'tree' || out.has(oid)) return;
    out.set(oid, obj);
    for (const entry of parseTree(obj.data)) {
      const child = repo.objects.get(entry.oid);
      if (child === undefined) continue;
      if (child.type === 'tree') walk(entry.oid);
      else out.set(entry.oid, child);
    }
  };
  walk(treeOid);
  return out;
}

/**
 * Choose the objects a fetch sends for `wants`, minus everything reachable from `haves`,
 * honouring `depth` (generations below a want) and the client's current `shallow` boundaries.
 * Returns the objects in a stable order: commits, then trees, then blobs, then tags.
 */
export function selectFetchObjects(
  repo: Repo,
  wants: readonly string[],
  haves: readonly string[],
  shallowIn: readonly string[],
  depth: number | null,
): FetchSelection {
  // What the client already holds. A `have` that is not a shallow boundary means the client
  // holds its whole closure; a `have` that IS a shallow boundary means it holds only that
  // commit and its tree — its parents are exactly what a deepen must deliver.
  const held = new Map<string, GitObject>();
  for (const have of haves) {
    if (shallowIn.includes(have)) {
      const obj = repo.objects.get(have);
      if (obj === undefined) continue;
      held.set(have, obj);
      if (obj.type === 'commit') {
        for (const [oid, o] of treeObjects(repo, parseCommit(obj.data).tree)) held.set(oid, o);
      }
    } else {
      for (const [oid, o] of reachableObjects(repo, new Set([have]))) held.set(oid, o);
    }
  }
  const haveReachable = held;
  // Resolve wants: tags peel to their target commit, other non-commit objects ship whole.
  const commitWants: string[] = [];
  const extra = new Map<string, GitObject>();
  for (const want of wants) {
    const obj = repo.objects.get(want);
    if (obj === undefined) continue;
    if (obj.type === 'commit') {
      commitWants.push(want);
      continue;
    }
    if (obj.type === 'tag') {
      extra.set(want, obj);
      let target = parseTag(obj.data).object;
      for (let i = 0; i < 8; i += 1) {
        const next = repo.objects.get(target);
        if (next !== undefined && next.type === 'tag') target = parseTag(next.data).object;
        else break;
      }
      const targetObj = repo.objects.get(target);
      if (targetObj !== undefined && targetObj.type === 'commit') commitWants.push(target);
      else if (targetObj !== undefined) {
        for (const [oid, o] of reachableObjects(repo, new Set([target]))) extra.set(oid, o);
      }
      continue;
    }
    for (const [oid, o] of reachableObjects(repo, new Set([want]))) extra.set(oid, o);
  }
  const generations = commitGenerations(repo, commitWants, depth ?? Number.POSITIVE_INFINITY);
  const wantedCommits = new Set<string>();
  const shallow = new Set<string>();
  const unshallow: string[] = [];
  for (const [oid, gen] of generations) {
    if (depth !== null && gen >= depth) continue;
    if (haveReachable.has(oid)) continue;
    wantedCommits.add(oid);
  }
  // Shallow boundaries: included commits whose parents are not included.
  for (const oid of wantedCommits) {
    const obj = repo.objects.get(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    const commit = parseCommit(obj.data);
    const parentIncluded = commit.parents.some((p) => wantedCommits.has(p));
    if (!parentIncluded && commit.parents.length > 0) shallow.add(oid);
    if (!parentIncluded && commit.parents.length === 0 && depth !== null) shallow.add(oid);
  }
  // Boundaries the client had that are now fully included are unshallow.
  for (const boundary of shallowIn) {
    const obj = repo.objects.get(boundary);
    if (obj === undefined || obj.type !== 'commit') continue;
    const commit = parseCommit(obj.data);
    if (commit.parents.length > 0 && commit.parents.every((p) => wantedCommits.has(p) || haveReachable.has(p))) {
      unshallow.push(boundary);
      shallow.delete(boundary);
    }
  }
  // Objects: each wanted commit plus its tree and blobs — never its parents, so a
  // depth limit actually cuts history off. Then the extra (tag/blob) objects.
  const reachable = new Map<string, GitObject>();
  for (const oid of wantedCommits) {
    const obj = repo.objects.get(oid);
    if (obj === undefined) continue;
    reachable.set(oid, obj);
    if (obj.type === 'commit') {
      for (const [treeOid, treeObj] of treeObjects(repo, parseCommit(obj.data).tree)) reachable.set(treeOid, treeObj);
    }
  }
  for (const [oid, o] of extra) reachable.set(oid, o);
  for (const oid of haveReachable.keys()) reachable.delete(oid);
  const order: Record<string, number> = { commit: 0, tag: 1, tree: 2, blob: 3 };
  const objects = [...reachable.values()].sort((a, b) => (order[a.type] ?? 9) - (order[b.type] ?? 9));
  return { objects, shallow: [...shallow], unshallow };
}
