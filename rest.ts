// GitHub REST v3: repositories, branches, commits, contents, labels, issues, comments
// and pull requests. Every reply is JSON, carries X-GitHub-Request-Id, and names the
// token's owner (the scenario viewer) as the repository owner; the same repository name
// under any other login is 404, never 403.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { buildTreeFromFlat, flattenTree } from './gitobjs.ts';
import { touchRepo } from './gitproto.ts';
import {
  buildCommit,
  DEFAULT_BRANCH,
  EPOCH_SEC,
  hashObject,
  parseCommit,
  parseTree,
  VIEWER_EMAIL,
  VIEWER_ID,
  VIEWER_LOGIN,
  VIEWER_NAME,
  type FileChange,
  type Issue,
  type PullRequest,
  type Repo,
  type Store,
} from './store.ts';

export interface RestCtx {
  store: Store;
  req: IncomingMessage;
  res: ServerResponse;
  /** Path segments after /api/v3. */
  segments: string[];
  query: URLSearchParams;
  body: unknown;
  requestId: string;
}

const JSON_TYPE = 'application/json; charset=utf-8';

export function sendJson(ctx: RestCtx, status: number, payload: unknown, extra: Record<string, string> = {}): void {
  const text = `${JSON.stringify(payload)}\n`;
  ctx.res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': ctx.requestId,
    ...extra,
  });
  ctx.res.end(text);
}

/** Send an already-serialised JSON body. Entries flagged `terminated` already carry
 * the trailing newline (and count it in `length`), so they go out untouched instead
 * of being copied into a new string on every send. */
function sendJsonText(ctx: RestCtx, status: number, entry: { text: string; length: number; terminated?: boolean }, extra: Record<string, string> = {}): void {
  if (entry.terminated === true) {
    ctx.res.writeHead(status, {
      'content-type': JSON_TYPE,
      'content-length': entry.length,
      'x-github-request-id': ctx.requestId,
      ...extra,
    });
    ctx.res.end(entry.text);
    return;
  }
  ctx.res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': entry.length + 1,
    'x-github-request-id': ctx.requestId,
    ...extra,
  });
  ctx.res.end(`${entry.text}\n`);
}

export function sendError(ctx: RestCtx, status: number, message: string): void {
  sendJson(ctx, status, { message });
}

function isoOfSeq(seq: number): string {
  return new Date((EPOCH_SEC + seq) * 1000).toISOString();
}

function userJson(login: string, id: number): Record<string, unknown> {
  return { login, id, type: 'User', site_admin: false, html_url: `https://github.com/${login}`, url: `/api/v3/users/${login}` };
}

export function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: userJson(repo.owner, repo.owner === VIEWER_LOGIN ? VIEWER_ID : 1001),
    private: repo.private,
    html_url: `https://github.com/${repo.owner}/${repo.name}`,
    description: repo.description,
    fork: false,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    created_at: isoOfSeq(repo.createdSeq),
    updated_at: isoOfSeq(repo.createdSeq),
    pushed_at: isoOfSeq(repo.createdSeq),
    default_branch: repo.defaultBranch,
    has_issues: true,
    has_projects: true,
    has_wiki: true,
  };
}

function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return { name, color: label?.color ?? '000000', description: label?.description ?? '' };
    }),
    user: userJson(issue.userLogin, issue.userLogin === VIEWER_LOGIN ? VIEWER_ID : 1001),
    created_at: isoOfSeq(issue.createdSeq),
    updated_at: isoOfSeq(issue.updatedSeq),
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    comments_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}/comments`,
    comments: issue.comments.length,
  };
}

/**
 * The issue's REST JSON, serialised once per state and reused for repeat reads (the
 * read workload GETs one issue 2,000 times). The cache is self-validating: the key
 * covers every field issueJson reads that can change — updatedSeq (every title/body/
 * state/label PATCH and every close bumps it), the comment count, and the labels'
 * colour/description — so no mutation site needs to remember to invalidate it.
 * Kept in a WeakMap, never on the issue object, so the state export is untouched.
 */
const issueJsonCache = new WeakMap<Issue, { key: string; text: string; length: number; terminated: boolean }>();

function issueCacheKey(repo: Repo, issue: Issue): string {
  if (issue.labels.length === 0) return `${issue.updatedSeq}:${issue.comments.length}:`;
  const labelSig = issue.labels
    .map((name) => {
      const label = repo.labels.get(name);
      return label === undefined ? '' : `${label.color}/${label.description}`;
    })
    .join('|');
  return `${issue.updatedSeq}:${issue.comments.length}:${labelSig}`;
}

export function issueJsonText(repo: Repo, issue: Issue): { text: string; length: number; terminated: boolean } {
  const key = issueCacheKey(repo, issue);
  const cached = issueJsonCache.get(issue);
  if (cached !== undefined && cached.key === key) return cached;
  const text = `${JSON.stringify(issueJson(repo, issue))}\n`;
  const entry = { key, text, length: Buffer.byteLength(text), terminated: true };
  issueJsonCache.set(issue, entry);
  return entry;
}

export function mergeableOf(repo: Repo, pr: PullRequest): boolean {
  if (pr.merged || pr.state !== 'open') return false;
  for (const other of repo.pulls) {
    if (other.merged && other.mergedSeq > pr.createdSeq && other.baseRef === pr.baseRef) {
      const files = new Set(other.files.map((f) => f.filename));
      if (pr.files.some((f) => files.has(f.filename))) return false;
    }
  }
  return true;
}

function pullJson(repo: Repo, pr: PullRequest): Record<string, unknown> {
  return {
    id: pr.id,
    number: pr.number,
    title: pr.title,
    body: pr.body,
    state: pr.state,
    merged: pr.merged,
    mergeable: mergeableOf(repo, pr),
    merged_at: pr.mergedAt,
    merge_commit_sha: pr.mergeCommitSha,
    head: { ref: pr.headRef, sha: pr.headSha, repo: repoJson(repo) },
    base: { ref: pr.baseRef, sha: pr.baseSha, repo: repoJson(repo) },
    user: userJson(VIEWER_LOGIN, VIEWER_ID),
    created_at: isoOfSeq(pr.createdSeq),
    updated_at: isoOfSeq(pr.createdSeq),
    html_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pr.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pr.number}`,
  };
}

function bodyOf(ctx: RestCtx): Record<string, unknown> {
  return (ctx.body ?? {}) as Record<string, unknown>;
}

function getRepoOr404(ctx: RestCtx, owner: string, name: string): Repo | null {
  const repo = ctx.store.getRepo(owner, name);
  if (repo === undefined) {
    sendError(ctx, 404, 'Not Found');
    return null;
  }
  return repo;
}

/** Commit `flat` on top of `baseTip` (null for an unborn branch) and move `branch`. Exported for GraphQL/MCP, which merge through the same path. */
export function commitFlat(
  ctx: RestCtx,
  repo: Repo,
  branch: string,
  baseTip: string | null,
  flat: ReadonlyMap<string, { oid: string; mode: string }>,
  message: string,
): string {
  const treeOid = buildTreeFromFlat(repo, flat);
  const ts = ctx.store.commitTimestamp(repo);
  const commit = buildCommit({
    tree: treeOid,
    parents: baseTip === null ? [] : [baseTip],
    message,
    authorName: VIEWER_NAME,
    authorEmail: VIEWER_EMAIL,
    committerName: VIEWER_NAME,
    committerEmail: VIEWER_EMAIL,
    timestamp: ts,
  });
  const commitOid = hashObject('commit', commit);
  repo.objects.set(commitOid, { type: 'commit', data: commit });
  repo.refs.set(`refs/heads/${branch}`, commitOid);
  touchRepo(repo);
  return commitOid;
}

function lineCounts(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

export function diffTrees(repo: Repo, baseTree: string | null, headTree: string | null): FileChange[] {
  const base = baseTree === null ? new Map() : flattenTree(repo, baseTree);
  const head = headTree === null ? new Map() : flattenTree(repo, headTree);
  const changes: FileChange[] = [];
  const paths = new Set([...base.keys(), ...head.keys()]);
  for (const path of [...paths].sort()) {
    const oldEntry = base.get(path);
    const newEntry = head.get(path);
    if (oldEntry !== undefined && newEntry !== undefined && oldEntry.oid === newEntry.oid) continue;
    const oldText = oldEntry === undefined ? '' : (repo.objects.get(oldEntry.oid)?.data.toString('utf8') ?? '');
    const newText = newEntry === undefined ? '' : (repo.objects.get(newEntry.oid)?.data.toString('utf8') ?? '');
    const oldLines = lineCounts(oldText);
    const newLines = lineCounts(newText);
    const oldCounts = new Map<string, number>();
    for (const line of oldLines) oldCounts.set(line, (oldCounts.get(line) ?? 0) + 1);
    let common = 0;
    for (const line of newLines) {
      const left = oldCounts.get(line) ?? 0;
      if (left > 0) {
        oldCounts.set(line, left - 1);
        common += 1;
      }
    }
    const additions = newLines.length - common;
    const deletions = oldLines.length - common;
    changes.push({
      filename: path,
      status: oldEntry === undefined ? 'added' : newEntry === undefined ? 'removed' : 'modified',
      additions,
      deletions,
      changes: additions + deletions,
      oldOid: oldEntry?.oid ?? null,
      newOid: newEntry?.oid ?? null,
    });
  }
  return changes;
}

function listCommits(repo: Repo, tip: string | undefined): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  if (tip === undefined) return out;
  const seen = new Set<string>();
  const queue = [tip];
  while (queue.length > 0) {
    const oid = queue.shift() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = repo.objects.get(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    const commit = parseCommit(obj.data);
    const date = new Date(commit.authorTs * 1000).toISOString();
    out.push({
      sha: oid,
      commit: {
        message: commit.message,
        author: { name: VIEWER_NAME, email: VIEWER_EMAIL, date },
        committer: { name: VIEWER_NAME, email: VIEWER_EMAIL, date },
      },
      author: userJson(VIEWER_LOGIN, VIEWER_ID),
      committer: userJson(VIEWER_LOGIN, VIEWER_ID),
    });
    for (const parent of commit.parents) queue.push(parent);
  }
  return out;
}

function parsePage(ctx: RestCtx): { perPage: number; page: number } {
  const perPage = Math.min(100, Math.max(1, Number(ctx.query.get('per_page') ?? '30') || 30));
  const page = Math.max(1, Number(ctx.query.get('page') ?? '1') || 1);
  return { perPage, page };
}

function pageLink(ctx: RestCtx, page: number, perPage: number, rel: string): string {
  const host = ctx.req.headers.host ?? '127.0.0.1';
  const base = `/api/v3/user/repos?per_page=${perPage}&page=${page}`;
  return `<http://${host}${base}>; rel="${rel}"`;
}

// ------------------------------------------------------------------ router

export function handleRest(ctx: RestCtx): void {
  const seg = ctx.segments;
  const method = ctx.req.method ?? 'GET';

  // API root.
  if (seg.length === 0) {
    sendJson(ctx, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
    return;
  }

  // Meta.
  if (method === 'GET' && seg.length === 1 && seg[0] === 'meta') {
    sendJson(ctx, 200, { installed_version: '1.0.0', verifiable_password_authentication: true });
    return;
  }

  // Authenticated user.
  if (method === 'GET' && seg.length === 1 && seg[0] === 'user') {
    sendJson(ctx, 200, {
      ...userJson(VIEWER_LOGIN, VIEWER_ID),
      name: VIEWER_NAME,
      email: VIEWER_EMAIL,
      avatar_url: '',
      public_repos: ctx.store.repos.size,
    });
    return;
  }

  // List / create the viewer's repositories.
  if (seg.length === 2 && seg[0] === 'user' && seg[1] === 'repos') {
    if (method === 'GET') {
      const { perPage, page } = parsePage(ctx);
      const all = [...ctx.store.repos.values()].filter((r) => r.owner === VIEWER_LOGIN).sort((a, b) => a.createdSeq - b.createdSeq);
      const slice = all.slice((page - 1) * perPage, page * perPage);
      const extra: Record<string, string> = {};
      if (page * perPage < all.length) {
        extra.link = `${pageLink(ctx, page + 1, perPage, 'next')}, ${pageLink(ctx, Math.ceil(all.length / perPage), perPage, 'last')}`;
      }
      sendJson(ctx, 200, slice.map(repoJson), extra);
      return;
    }
    if (method === 'POST') {
      const body = bodyOf(ctx);
      const name = typeof body.name === 'string' ? body.name : '';
      if (name === '' || !/^[A-Za-z0-9._-]+$/.test(name)) {
        sendError(ctx, 422, 'Invalid repository name');
        return;
      }
      if (ctx.store.getRepo(VIEWER_LOGIN, name) !== undefined) {
        sendError(ctx, 422, `Repository ${VIEWER_LOGIN}/${name} already exists`);
        return;
      }
      const repo = ctx.store.createRepo(
        VIEWER_LOGIN,
        name,
        typeof body.description === 'string' ? body.description : '',
        body.private === true,
        typeof body.default_branch === 'string' ? body.default_branch : DEFAULT_BRANCH,
      );
      sendJson(ctx, 201, repoJson(repo));
      return;
    }
  }

  // Everything below is /repos/{owner}/{repo}/...
  if (seg.length >= 3 && seg[0] === 'repos') {
    const owner = decodeURIComponent(seg[1] as string);
    const name = decodeURIComponent(seg[2] as string);
    const rest = seg.slice(3);
    handleRepoRoute(ctx, method, owner, name, rest);
    return;
  }

  sendError(ctx, 404, 'Not Found');
}

// ------------------------------------------------------------------ shared mutations (GraphQL/MCP)

// Create an issue through the same path REST uses; labels must already exist.
export function createIssueInRepo(
  store: Store,
  repo: Repo,
  title: string,
  body: string,
  labels: readonly string[],
): { issue: Issue } | { error: string } {
  for (const label of labels) {
    if (!repo.labels.has(label)) return { error: `Label "${label}" does not exist` };
  }
  store.stamp();
  const issue: Issue = {
    id: store.nextIssueId,
    number: repo.nextIssue,
    title,
    body,
    state: 'open',
    labels: [...labels],
    userLogin: VIEWER_LOGIN,
    createdSeq: store.seq,
    updatedSeq: store.seq,
    comments: [],
  };
  store.nextIssueId += 1;
  repo.nextIssue += 1;
  repo.issues.push(issue);
  return { issue };
}

// Open a pull request through the same path REST uses.
export function createPullInRepo(
  store: Store,
  repo: Repo,
  title: string,
  body: string,
  headRef: string,
  baseRef: string,
): { pr: PullRequest } | { error: string } {
  const headSha = repo.refs.get(`refs/heads/${headRef}`);
  const baseSha = repo.refs.get(`refs/heads/${baseRef}`);
  if (headSha === undefined || baseSha === undefined) return { error: 'Head or base branch does not exist' };
  const headCommit = repo.objects.get(headSha);
  const baseCommit = repo.objects.get(baseSha);
  const headTree = headCommit !== undefined && headCommit.type === 'commit' ? parseCommit(headCommit.data).tree : null;
  const baseTree = baseCommit !== undefined && baseCommit.type === 'commit' ? parseCommit(baseCommit.data).tree : null;
  const files = diffTrees(repo, baseTree, headTree);
  store.stamp();
  const pr: PullRequest = {
    id: store.nextPullId,
    number: repo.nextPull,
    title,
    body,
    state: 'open',
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    headRef,
    baseRef,
    headSha,
    baseSha,
    files,
    createdSeq: store.seq,
    mergedSeq: 0,
  };
  store.nextPullId += 1;
  repo.nextPull += 1;
  repo.pulls.push(pr);
  return { pr };
}

// Squash-merge a pull request through the same path REST uses.
export function mergePullInRepo(
  store: Store,
  repo: Repo,
  pr: PullRequest,
): { sha: string } | { error: string } {
  if (pr.merged || pr.state !== 'open') return { error: 'Pull request is already merged or closed' };
  if (!mergeableOf(repo, pr)) return { error: 'Merge conflict' };
  const baseSha = repo.refs.get(`refs/heads/${pr.baseRef}`);
  if (baseSha === undefined) return { error: 'Base branch does not exist' };
  const baseCommit = repo.objects.get(baseSha);
  const baseTree = baseCommit !== undefined && baseCommit.type === 'commit' ? parseCommit(baseCommit.data).tree : null;
  const flat = baseTree === null ? new Map<string, { oid: string; mode: string }>() : flattenTree(repo, baseTree);
  for (const file of pr.files) {
    if (file.status === 'removed') flat.delete(file.filename);
    else if (file.newOid !== null) flat.set(file.filename, { oid: file.newOid, mode: '100644' });
  }
  // commitFlat needs a RestCtx for the clock; the store's own stamp is equivalent here.
  const treeOid = buildTreeFromFlat(repo, flat);
  const ts = store.commitTimestamp(repo);
  const commit = buildCommit({
    tree: treeOid,
    parents: [baseSha],
    message: `${pr.title} (#${pr.number})`,
    authorName: VIEWER_NAME,
    authorEmail: VIEWER_EMAIL,
    committerName: VIEWER_NAME,
    committerEmail: VIEWER_EMAIL,
    timestamp: ts,
  });
  const commitOid = hashObject('commit', commit);
  repo.objects.set(commitOid, { type: 'commit', data: commit });
  repo.refs.set(`refs/heads/${pr.baseRef}`, commitOid);
  touchRepo(repo);
  store.stamp();
  pr.merged = true;
  pr.state = 'closed';
  pr.mergedAt = isoOfSeq(store.seq);
  pr.mergeCommitSha = commitOid;
  pr.mergedSeq = store.seq;
  return { sha: commitOid };
}

function handleRepoRoute(ctx: RestCtx, method: string, owner: string, name: string, rest: string[]): void {
  // Repository object itself.
  if (rest.length === 0) {
    if (method === 'GET') {
      const repo = getRepoOr404(ctx, owner, name);
      if (repo !== null) sendJson(ctx, 200, repoJson(repo));
      return;
    }
    if (method === 'PATCH') {
      const repo = getRepoOr404(ctx, owner, name);
      if (repo === null) return;
      const body = bodyOf(ctx);
      if (typeof body.description === 'string') repo.description = body.description;
      if (typeof body.default_branch === 'string') repo.defaultBranch = body.default_branch;
      sendJson(ctx, 200, repoJson(repo));
      return;
    }
    if (method === 'DELETE') {
      const repo = getRepoOr404(ctx, owner, name);
      if (repo === null) return;
      ctx.store.deleteRepo(repo);
      ctx.res.writeHead(204, { 'content-type': JSON_TYPE, 'x-github-request-id': ctx.requestId });
      ctx.res.end();
      return;
    }
    sendError(ctx, 404, 'Not Found');
    return;
  }

  const head = rest[0] as string;

  // Branches.
  if (head === 'branches') {
    const repo = getRepoOr404(ctx, owner, name);
    if (repo === null) return;
    if (method === 'GET' && rest.length === 1) {
      const list = [...repo.refs.keys()]
        .filter((ref) => ref.startsWith('refs/heads/'))
        .sort()
        .map((ref) => ({ name: ref.slice('refs/heads/'.length), commit: { sha: repo.refs.get(ref) }, protected: false }));
      sendJson(ctx, 200, list);
      return;
    }
    if (method === 'GET' && rest.length === 2) {
      const sha = repo.refs.get(`refs/heads/${decodeURIComponent(rest[1] as string)}`);
      if (sha === undefined) {
        sendError(ctx, 404, 'Not Found');
        return;
      }
      sendJson(ctx, 200, { name: decodeURIComponent(rest[1] as string), commit: { sha }, protected: false });
      return;
    }
    sendError(ctx, 404, 'Not Found');
    return;
  }

  // Commits.
  if (head === 'commits' && method === 'GET' && rest.length === 1) {
    const repo = getRepoOr404(ctx, owner, name);
    if (repo === null) return;
    const shaParam = ctx.query.get('sha');
    const branch = shaParam ?? repo.defaultBranch;
    const tip = repo.refs.get(`refs/heads/${branch}`) ?? (repo.objects.has(branch) ? branch : undefined);
    sendJson(ctx, 200, listCommits(repo, tip));
    return;
  }

  // Git refs (create a branch, read one).
  if (head === 'git' && rest[1] === 'refs') {
    if (method === 'POST' && rest.length === 2) {
      const repo = getRepoOr404(ctx, owner, name);
      if (repo === null) return;
      const body = bodyOf(ctx);
      const ref = typeof body.ref === 'string' ? body.ref : '';
      const sha = typeof body.sha === 'string' ? body.sha : '';
      if (!ref.startsWith('refs/') || !repo.objects.has(sha)) {
        sendError(ctx, 422, 'Invalid ref or sha');
        return;
      }
      if (repo.refs.has(ref)) {
        sendError(ctx, 422, 'Reference already exists');
        return;
      }
      repo.refs.set(ref, sha);
      touchRepo(repo);
      sendJson(ctx, 201, { ref, object: { sha, type: 'commit' } });
      return;
    }
    if (method === 'GET' && rest.length >= 3) {
      const repo = getRepoOr404(ctx, owner, name);
      if (repo === null) return;
      const ref = `refs/${rest.slice(2).map((s) => decodeURIComponent(s)).join('/')}`;
      const sha = repo.refs.get(ref);
      if (sha === undefined) {
        sendError(ctx, 404, 'Not Found');
        return;
      }
      sendJson(ctx, 200, { ref, object: { sha, type: 'commit' } });
      return;
    }
    sendError(ctx, 404, 'Not Found');
    return;
  }

  // Contents.
  if (head === 'contents') {
    handleContents(ctx, method, owner, name, rest.slice(1));
    return;
  }

  // Labels.
  if (head === 'labels') {
    const repo = getRepoOr404(ctx, owner, name);
    if (repo === null) return;
    if (method === 'GET' && rest.length === 1) {
      sendJson(ctx, 200, [...repo.labels.values()].map((l) => ({ name: l.name, color: l.color, description: l.description })));
      return;
    }
    if (method === 'POST' && rest.length === 1) {
      const body = bodyOf(ctx);
      const labelName = typeof body.name === 'string' ? body.name : '';
      const color = typeof body.color === 'string' ? body.color.replace(/^#/, '') : '000000';
      if (labelName === '') {
        sendError(ctx, 422, 'Invalid label name');
        return;
      }
      repo.labels.set(labelName, { name: labelName, color, description: typeof body.description === 'string' ? body.description : '' });
      sendJson(ctx, 201, { name: labelName, color, description: typeof body.description === 'string' ? body.description : '' });
      return;
    }
    sendError(ctx, 404, 'Not Found');
    return;
  }

  // Issues and comments.
  if (head === 'issues') {
    handleIssues(ctx, method, owner, name, rest.slice(1));
    return;
  }

  // Pull requests.
  if (head === 'pulls') {
    handlePulls(ctx, method, owner, name, rest.slice(1));
    return;
  }

  sendError(ctx, 404, 'Not Found');
}

// ------------------------------------------------------------------ contents

function handleContents(ctx: RestCtx, method: string, owner: string, name: string, pathSegs: string[]): void {
  const repo = getRepoOr404(ctx, owner, name);
  if (repo === null) return;
  const path = pathSegs.map((s) => decodeURIComponent(s)).join('/');
  const body = bodyOf(ctx);
  const branch = typeof body.branch === 'string' ? body.branch : ctx.query.get('ref') ?? repo.defaultBranch;
  const tip = repo.refs.get(`refs/heads/${branch}`);
  const tipCommit = tip === undefined ? undefined : repo.objects.get(tip);
  const tipTree = tipCommit !== undefined && tipCommit.type === 'commit' ? parseCommit(tipCommit.data).tree : null;
  const flat = tipTree === null ? new Map<string, { oid: string; mode: string }>() : flattenTree(repo, tipTree);

  if (method === 'GET') {
    if (tipTree === null) {
      sendError(ctx, 404, 'Not Found');
      return;
    }
    if (path === '') {
      // Root directory listing.
      const entries = listDir(repo, tipTree, '');
      sendJson(ctx, 200, entries);
      return;
    }
    const entry = flat.get(path);
    if (entry !== undefined) {
      const obj = repo.objects.get(entry.oid);
      const data = obj?.data ?? Buffer.alloc(0);
      sendJson(ctx, 200, {
        type: 'file',
        encoding: 'base64',
        size: data.length,
        name: path.split('/').pop(),
        path,
        content: data.toString('base64'),
        sha: entry.oid,
      });
      return;
    }
    // A directory: any flat path below `path/`.
    const prefix = `${path}/`;
    if ([...flat.keys()].some((p) => p.startsWith(prefix))) {
      sendJson(ctx, 200, listDir(repo, tipTree, path));
      return;
    }
    sendError(ctx, 404, 'Not Found');
    return;
  }

  if (method === 'PUT') {
    const contentB64 = typeof body.content === 'string' ? body.content : '';
    const message = typeof body.message === 'string' ? body.message : `Update ${path}`;
    let data: Buffer;
    try {
      data = Buffer.from(contentB64.replace(/[\r\n\t ]+/g, ''), 'base64');
    } catch {
      sendError(ctx, 422, 'Invalid base64 content');
      return;
    }
    const existing = flat.get(path);
    const isUpdate = existing !== undefined;
    if (isUpdate && typeof body.sha === 'string' && body.sha !== existing.oid) {
      sendError(ctx, 409, 'sha does not match the current blob');
      return;
    }
    if (!isUpdate && typeof body.sha === 'string' && body.sha !== '') {
      sendError(ctx, 409, 'sha does not match the current blob');
      return;
    }
    const blobOid = hashObject('blob', data);
    repo.objects.set(blobOid, { type: 'blob', data });
    flat.set(path, { oid: blobOid, mode: '100644' });
    const commitOid = commitFlat(ctx, repo, branch, tip ?? null, flat, message);
    sendJson(ctx, isUpdate ? 200 : 201, {
      content: { name: path.split('/').pop(), path, sha: blobOid, size: data.length, encoding: 'base64' },
      commit: { sha: commitOid, message },
    });
    return;
  }

  if (method === 'DELETE') {
    const existing = flat.get(path);
    if (existing === undefined) {
      sendError(ctx, 404, 'Not Found');
      return;
    }
    if (typeof body.sha === 'string' && body.sha !== existing.oid) {
      sendError(ctx, 409, 'sha does not match the current blob');
      return;
    }
    flat.delete(path);
    const message = typeof body.message === 'string' ? body.message : `Delete ${path}`;
    const commitOid = commitFlat(ctx, repo, branch, tip ?? null, flat, message);
    sendJson(ctx, 200, { commit: { sha: commitOid, message } });
    return;
  }

  sendError(ctx, 404, 'Not Found');
}

function listDir(repo: Repo, treeOid: string, dirPath: string): Array<Record<string, unknown>> {
  // Walk to the subtree for dirPath, then list its immediate children.
  let current = treeOid;
  if (dirPath !== '') {
    for (const part of dirPath.split('/')) {
      const obj = repo.objects.get(current);
      if (obj === undefined || obj.type !== 'tree') return [];
      const entry = parseTree(obj.data).find((e) => e.name === part && e.mode === '40000');
      if (entry === undefined) return [];
      current = entry.oid;
    }
  }
  const obj = repo.objects.get(current);
  if (obj === undefined || obj.type !== 'tree') return [];
  return parseTree(obj.data)
    .sort((a, b) => (a.name < b.name ? -1 : 1))
    .map((entry) => ({
      type: entry.mode === '40000' ? 'dir' : 'file',
      name: entry.name,
      path: dirPath === '' ? entry.name : `${dirPath}/${entry.name}`,
      sha: entry.oid,
      size: entry.mode === '40000' ? 0 : (repo.objects.get(entry.oid)?.data.length ?? 0),
    }));
}

// ------------------------------------------------------------------ issues

function handleIssues(ctx: RestCtx, method: string, owner: string, name: string, rest: string[]): void {
  const repo = getRepoOr404(ctx, owner, name);
  if (repo === null) return;

  if (rest.length === 0) {
    if (method === 'POST') {
      const body = bodyOf(ctx);
      const title = typeof body.title === 'string' ? body.title : '';
      if (title === '') {
        sendError(ctx, 422, 'Title is required');
        return;
      }
      const labels: string[] = Array.isArray(body.labels) ? body.labels.filter((l): l is string => typeof l === 'string') : [];
      for (const label of labels) {
        if (!repo.labels.has(label)) {
          sendError(ctx, 422, `Label "${label}" does not exist`);
          return;
        }
      }
      const { epoch } = ctx.store.stamp();
      void epoch;
      const issue: Issue = {
        id: ctx.store.nextIssueId,
        number: repo.nextIssue,
        title,
        body: typeof body.body === 'string' ? body.body : '',
        state: 'open',
        labels,
        userLogin: VIEWER_LOGIN,
        createdSeq: ctx.store.seq,
        updatedSeq: ctx.store.seq,
        comments: [],
      };
      ctx.store.nextIssueId += 1;
      repo.nextIssue += 1;
      repo.issues.push(issue);
      sendJsonText(ctx, 201, issueJsonText(repo, issue));
      return;
    }
    if (method === 'GET') {
      const state = ctx.query.get('state') ?? 'open';
      const sort = ctx.query.get('sort') ?? 'created';
      const direction = ctx.query.get('direction') ?? 'desc';
      let list = repo.issues.filter((i) => state === 'all' || i.state === state);
      if (sort === 'created') {
        list = [...list].sort((a, b) => (direction === 'asc' ? a.createdSeq - b.createdSeq || a.number - b.number : b.createdSeq - a.createdSeq || b.number - a.number));
      }
      const items = list.map((i) => issueJsonText(repo, i));
      const text = `[${items.map((e) => e.text).join(',')}]`;
      const length = items.reduce((sum, e) => sum + e.length, 0) + Math.max(0, items.length - 1) + 2;
      sendJsonText(ctx, 200, { text, length });
      return;
    }
    sendError(ctx, 404, 'Not Found');
    return;
  }

  const number = Number(rest[0]);
  const issue = repo.issues.find((i) => i.number === number);
  if (issue === undefined) {
    sendError(ctx, 404, 'Not Found');
    return;
  }

  if (rest.length === 1) {
    if (method === 'GET') {
      sendJsonText(ctx, 200, issueJsonText(repo, issue));
      return;
    }
    if (method === 'PATCH') {
      const body = bodyOf(ctx);
      if (typeof body.title === 'string') issue.title = body.title;
      if (typeof body.body === 'string') issue.body = body.body;
      if (body.state === 'open' || body.state === 'closed') issue.state = body.state;
      if (Array.isArray(body.labels)) {
        const labels = body.labels.filter((l): l is string => typeof l === 'string');
        for (const label of labels) {
          if (!repo.labels.has(label)) {
            sendError(ctx, 422, `Label "${label}" does not exist`);
            return;
          }
        }
        issue.labels = labels;
      }
      ctx.store.stamp();
      issue.updatedSeq = ctx.store.seq;
      sendJsonText(ctx, 200, issueJsonText(repo, issue));
      return;
    }
    sendError(ctx, 404, 'Not Found');
    return;
  }

  if (rest.length === 2 && rest[1] === 'comments') {
    if (method === 'GET') {
      sendJson(
        ctx,
        200,
        issue.comments.map((c) => ({ id: c.id, body: c.body, user: userJson(c.userLogin, c.userLogin === VIEWER_LOGIN ? VIEWER_ID : 1001), created_at: isoOfSeq(c.createdSeq), updated_at: isoOfSeq(c.createdSeq) })),
      );
      return;
    }
    if (method === 'POST') {
      const body = bodyOf(ctx);
      const commentBody = typeof body.body === 'string' ? body.body : '';
      if (commentBody === '') {
        sendError(ctx, 422, 'Body is required');
        return;
      }
      ctx.store.stamp();
      const comment = { id: ctx.store.nextCommentId, body: commentBody, userLogin: VIEWER_LOGIN, createdSeq: ctx.store.seq };
      ctx.store.nextCommentId += 1;
      issue.comments.push(comment);
      sendJson(ctx, 201, { id: comment.id, body: comment.body, user: userJson(VIEWER_LOGIN, VIEWER_ID), created_at: isoOfSeq(comment.createdSeq), updated_at: isoOfSeq(comment.createdSeq) });
      return;
    }
  }

  sendError(ctx, 404, 'Not Found');
}

// ------------------------------------------------------------------ pulls

function handlePulls(ctx: RestCtx, method: string, owner: string, name: string, rest: string[]): void {
  const repo = getRepoOr404(ctx, owner, name);
  if (repo === null) return;

  if (rest.length === 0) {
    if (method === 'POST') {
      const body = bodyOf(ctx);
      const title = typeof body.title === 'string' ? body.title : '';
      const headRef = typeof body.head === 'string' ? body.head : '';
      const baseRef = typeof body.base === 'string' ? body.base : repo.defaultBranch;
      if (title === '' || headRef === '') {
        sendError(ctx, 422, 'Title and head are required');
        return;
      }
      const headSha = repo.refs.get(`refs/heads/${headRef}`);
      const baseSha = repo.refs.get(`refs/heads/${baseRef}`);
      if (headSha === undefined || baseSha === undefined) {
        sendError(ctx, 422, 'Head or base branch does not exist');
        return;
      }
      const headCommit = repo.objects.get(headSha);
      const baseCommit = repo.objects.get(baseSha);
      const headTree = headCommit !== undefined && headCommit.type === 'commit' ? parseCommit(headCommit.data).tree : null;
      const baseTree = baseCommit !== undefined && baseCommit.type === 'commit' ? parseCommit(baseCommit.data).tree : null;
      const files = diffTrees(repo, baseTree, headTree);
      ctx.store.stamp();
      const pr: PullRequest = {
        id: ctx.store.nextPullId,
        number: repo.nextPull,
        title,
        body: typeof body.body === 'string' ? body.body : '',
        state: 'open',
        merged: false,
        mergedAt: null,
        mergeCommitSha: null,
        headRef,
        baseRef,
        headSha,
        baseSha,
        files,
        createdSeq: ctx.store.seq,
        mergedSeq: 0,
      };
      ctx.store.nextPullId += 1;
      repo.nextPull += 1;
      repo.pulls.push(pr);
      sendJson(ctx, 201, pullJson(repo, pr));
      return;
    }
    if (method === 'GET') {
      const state = ctx.query.get('state') ?? 'open';
      const list = repo.pulls.filter((p) => state === 'all' || p.state === state);
      sendJson(ctx, 200, list.map((p) => pullJson(repo, p)));
      return;
    }
    sendError(ctx, 404, 'Not Found');
    return;
  }

  const number = Number(rest[0]);
  const pr = repo.pulls.find((p) => p.number === number);
  if (pr === undefined) {
    sendError(ctx, 404, 'Not Found');
    return;
  }

  if (rest.length === 1 && method === 'GET') {
    sendJson(ctx, 200, pullJson(repo, pr));
    return;
  }

  if (rest.length === 2 && rest[1] === 'files' && method === 'GET') {
    sendJson(
      ctx,
      200,
      pr.files.map((f) => ({
        filename: f.filename,
        status: f.status === 'modified' ? 'modified' : f.status,
        additions: f.additions,
        deletions: f.deletions,
        changes: f.changes,
        sha: f.newOid ?? f.oldOid ?? '',
      })),
    );
    return;
  }

  if (rest.length === 2 && rest[1] === 'merge' && method === 'PUT') {
    if (pr.merged || pr.state !== 'open') {
      sendError(ctx, 405, 'Pull request is already merged or closed');
      return;
    }
    if (!mergeableOf(repo, pr)) {
      sendError(ctx, 405, 'Merge conflict');
      return;
    }
    const body = bodyOf(ctx);
    const mergeMethod = typeof body.merge_method === 'string' ? body.merge_method : 'merge';
    void mergeMethod;
    // Squash: apply the pull request's files onto the base branch's tree.
    const baseSha = repo.refs.get(`refs/heads/${pr.baseRef}`);
    if (baseSha === undefined) {
      sendError(ctx, 422, 'Base branch does not exist');
      return;
    }
    const baseCommit = repo.objects.get(baseSha);
    const baseTree = baseCommit !== undefined && baseCommit.type === 'commit' ? parseCommit(baseCommit.data).tree : null;
    const flat = baseTree === null ? new Map<string, { oid: string; mode: string }>() : flattenTree(repo, baseTree);
    for (const file of pr.files) {
      if (file.status === 'removed') flat.delete(file.filename);
      else if (file.newOid !== null) flat.set(file.filename, { oid: file.newOid, mode: '100644' });
    }
    const commitOid = commitFlat(ctx, repo, pr.baseRef, baseSha, flat, `${pr.title} (#${pr.number})`);
    ctx.store.stamp();
    pr.merged = true;
    pr.state = 'closed';
    pr.mergedAt = isoOfSeq(ctx.store.seq);
    pr.mergeCommitSha = commitOid;
    pr.mergedSeq = ctx.store.seq;
    sendJson(ctx, 200, { sha: commitOid, merged: true, message: 'Pull request successfully merged' });
    return;
  }

  sendError(ctx, 404, 'Not Found');
}
