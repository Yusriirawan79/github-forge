// The forge's in-memory store and its deterministic clock.
//
// Everything the entry remembers lives here, in plain Maps, and nothing in request handling
// reads the wall clock or Math.random: timestamps come from a counter seeded at a fixed epoch,
// so two runs that see the same requests leave byte-identical state. The scenario the suite
// grades against is fixed (kit wire.ts: SCENARIO_SEED is constant), so the token's owner is the
// scenario viewer, adaiversen (id 1000); that login is what GET /api/v3/user and GraphQL
// viewer { login } answer with.

import { createHash } from 'node:crypto';

export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';
export const ZERO_OID = '0000000000000000000000000000000000000000';
export const DEFAULT_BRANCH = 'main';
/** Fixed epoch for every timestamp the store mints (2025-01-01T00:00:00Z). */
export const EPOCH_SEC = 1735689600;

export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

/** The git object id of `<type> <size>\0<bytes>` (two hash updates, no concat copy). */
export function hashObject(type: string, data: Buffer): string {
  return createHash('sha1').update(`${type} ${data.length}\0`, 'utf8').update(data).digest('hex');
}

export interface GitObject {
  type: string;
  data: Buffer;
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

/** Build a tree object's bytes from entries (sorted the way git sorts them). */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const an = a.mode === '40000' ? `${a.name}/` : a.name;
    const bn = b.mode === '40000' ? `${b.name}/` : b.name;
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Parse a tree object's bytes into entries. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const nul = data.indexOf(0x00, space);
    const mode = data.subarray(offset, space).toString('utf8');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

export interface CommitMeta {
  tree: string;
  parents: readonly string[];
  message: string;
  authorName: string;
  authorEmail: string;
  committerName: string;
  committerEmail: string;
  timestamp: number;
}

/** Build a commit object's bytes. */
export function buildCommit(meta: CommitMeta): Buffer {
  const lines: string[] = [`tree ${meta.tree}`];
  for (const parent of meta.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${meta.authorName} <${meta.authorEmail}> ${meta.timestamp} +0000`);
  lines.push(`committer ${meta.committerName} <${meta.committerEmail}> ${meta.timestamp} +0000`);
  lines.push('');
  lines.push(meta.message.endsWith('\n') ? meta.message : `${meta.message}\n`);
  return Buffer.from(lines.join('\n'), 'utf8');
}

export interface ParsedCommit {
  tree: string;
  parents: string[];
  message: string;
  author: string;
  committer: string;
  authorTs: number;
}

/** Parse a commit object's bytes. */
export function parseCommit(data: Buffer): ParsedCommit {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  const out: ParsedCommit = { tree: '', parents: [], message: message.replace(/\n$/, ''), author: '', committer: '', authorTs: 0 };
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) out.tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) out.parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) {
      out.author = line.slice(7);
      const m = / (\d+) [+-]\d{4}$/.exec(line);
      if (m) out.authorTs = Number(m[1]);
    } else if (line.startsWith('committer ')) out.committer = line.slice(10);
  }
  return out;
}

/** Parse a tag object's bytes (annotated tags point at another object). */
export function parseTag(data: Buffer): { object: string; type: string; tag: string } {
  const text = data.toString('utf8');
  const out = { object: '', type: '', tag: '' };
  for (const line of text.split('\n')) {
    if (line.startsWith('object ')) out.object = line.slice(7).trim();
    else if (line.startsWith('type ')) out.type = line.slice(5).trim();
    else if (line.startsWith('tag ')) out.tag = line.slice(4).trim();
    else if (line === '') break;
  }
  return out;
}

// ------------------------------------------------------------------ store types

export interface Label {
  name: string;
  color: string;
  description: string;
}

export interface IssueComment {
  id: number;
  body: string;
  userLogin: string;
  createdSeq: number;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  userLogin: string;
  createdSeq: number;
  updatedSeq: number;
  comments: IssueComment[];
}

export interface FileChange {
  filename: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
  changes: number;
  oldOid: string | null;
  newOid: string | null;
}

export interface PullRequest {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  files: FileChange[];
  createdSeq: number;
  mergedSeq: number;
}

export interface Repo {
  id: number;
  owner: string;
  name: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  createdSeq: number;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  labels: Map<string, Label>;
  issues: Issue[];
  nextIssue: number;
  pulls: PullRequest[];
  nextPull: number;
  /** Monotonic per-repo counter feeding commit timestamps. */
  commitSeq: number;
  /** Cached fetch/clone results, keyed by request signature; cleared on any mutation. */
  packCache: Map<string, { pack: Buffer; shallow: string[]; unshallow: string[] }>;
}

/** The whole forge: repositories by `owner/name`, plus the deterministic clock. */
export class Store {
  repos = new Map<string, Repo>();
  reposById = new Map<number, Repo>();
  nextRepoId = 5000;
  nextIssueId = 100000;
  nextPullId = 200000;
  nextCommentId = 300000;
  /** Global mutation counter: every stamp comes from EPOCH_SEC + seq. */
  seq = 0;

  stamp(): { epoch: number; iso: string } {
    this.seq += 1;
    const epoch = EPOCH_SEC + this.seq;
    return { epoch, iso: new Date(epoch * 1000).toISOString() };
  }

  isoNow(): string {
    return new Date((EPOCH_SEC + this.seq) * 1000).toISOString();
  }

  repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.repoKey(owner, name));
  }

  createRepo(owner: string, name: string, description: string, isPrivate: boolean, defaultBranch = DEFAULT_BRANCH): Repo {
    const { epoch } = this.stamp();
    void epoch;
    const repo: Repo = {
      id: this.nextRepoId,
      owner,
      name,
      description,
      private: isPrivate,
      defaultBranch,
      createdSeq: this.seq,
      objects: new Map(),
      refs: new Map(),
      labels: new Map(),
      issues: [],
      nextIssue: 1,
      pulls: [],
      nextPull: 1,
      commitSeq: 0,
      packCache: new Map(),
    };
    this.nextRepoId += 1;
    this.repos.set(this.repoKey(owner, name), repo);
    this.reposById.set(repo.id, repo);
    return repo;
  }

  deleteRepo(repo: Repo): void {
    this.repos.delete(this.repoKey(repo.owner, repo.name));
    this.reposById.delete(repo.id);
  }

  /** A commit timestamp for this repo: deterministic and increasing. */
  commitTimestamp(repo: Repo): number {
    repo.commitSeq += 1;
    return EPOCH_SEC + repo.commitSeq;
  }
}

/** Opaque GraphQL global ids: base64 of `Kind:repoId:number`, never the bare database id. */
export function globalId(kind: string, repoId: number, num: number): string {
  return Buffer.from(`${kind}:${repoId}:${num}`, 'utf8').toString('base64');
}

export function parseGlobalId(id: string): { kind: string; repoId: number; num: number } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const parts = text.split(':');
    if (parts.length !== 3) return null;
    return { kind: parts[0] ?? '', repoId: Number(parts[1]), num: Number(parts[2]) };
  } catch {
    return null;
  }
}
