// Model Context Protocol over Streamable HTTP (JSON-RPC 2.0) at /mcp.
// The modern era (2026-07-28) is served: server/discover first, initialize as the
// legacy fallback. The tool set is one frozen constant, so two tools/list calls are
// byte-identical, and every tool runs through the same store functions REST uses,
// so MCP and REST see the same repositories, issues and pull requests with the same ids.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { createIssueInRepo, createPullInRepo, mergePullInRepo, repoJson } from './rest.ts';
import { VIEWER_LOGIN, type Repo, type Store } from './store.ts';

const SERVER_NAME = 'forge';
const SERVER_VERSION = '1.0.0';

interface McpTool {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

const TOOLS: readonly McpTool[] = Object.freeze([
  Object.freeze({
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: Object.freeze({
      type: 'object' as const,
      properties: Object.freeze({
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
        owner: { type: 'string', description: 'The owner login (defaults to the authenticated user).' },
      }),
      required: Object.freeze(['name']),
    }),
  }),
  Object.freeze({
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: Object.freeze({
      type: 'object' as const,
      properties: Object.freeze({
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      }),
      required: Object.freeze(['owner', 'repo']),
    }),
  }),
  Object.freeze({
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: Object.freeze({
      type: 'object' as const,
      properties: Object.freeze({
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      }),
      required: Object.freeze(['owner', 'repo', 'title']),
    }),
  }),
  Object.freeze({
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: Object.freeze({
      type: 'object' as const,
      properties: Object.freeze({
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Filter by state: open, closed or all.' },
      }),
      required: Object.freeze(['owner', 'repo']),
    }),
  }),
  Object.freeze({
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: Object.freeze({
      type: 'object' as const,
      properties: Object.freeze({
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      }),
      required: Object.freeze(['owner', 'repo', 'title', 'head', 'base']),
    }),
  }),
  Object.freeze({
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash merge.',
    inputSchema: Object.freeze({
      type: 'object' as const,
      properties: Object.freeze({
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'number', description: 'The pull request number.' },
      }),
      required: Object.freeze(['owner', 'repo', 'pull_number']),
    }),
  }),
]);

interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: unknown;
  isError?: boolean;
}

function toolOk(value: unknown): ToolResult {
  const text = JSON.stringify(value);
  return { content: [{ type: 'text', text }], structuredContent: value };
}

function toolErr(message: string): ToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function pickString(args: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === 'string' && value !== '') return value;
  }
  return undefined;
}

function pickNumber(args: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
    if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  }
  return undefined;
}

function splitFullName(value: string | undefined): { owner: string | undefined; repo: string | undefined } {
  if (value === undefined) return { owner: undefined, repo: undefined };
  const parts = value.split('/');
  if (parts.length === 2) return { owner: parts[0], repo: parts[1] };
  return { owner: undefined, repo: value };
}

function callTool(store: Store, name: string, rawArgs: unknown): ToolResult {
  const args = (rawArgs ?? {}) as Record<string, unknown>;
  const full = splitFullName(pickString(args, 'full_name'));
  const owner = pickString(args, 'owner', 'owner_login') ?? full.owner ?? VIEWER_LOGIN;
  const repoName = pickString(args, 'repo', 'repository', 'name') ?? full.repo;
  switch (name) {
    case 'create_repo': {
      const repoNameArg = pickString(args, 'name', 'repo', 'repository');
      if (repoNameArg === undefined) return toolErr('missing required argument: name');
      const existing = store.getRepo(VIEWER_LOGIN, repoNameArg);
      if (existing !== undefined) return toolErr(`Repository ${VIEWER_LOGIN}/${repoNameArg} already exists`);
      const repo = store.createRepo(
        VIEWER_LOGIN,
        repoNameArg,
        pickString(args, 'description') ?? '',
        args.private === true,
      );
      return toolOk(repoJson(repo));
    }
    case 'get_repo': {
      if (repoName === undefined) return toolErr('missing required argument: repo');
      const repo = store.getRepo(owner, repoName);
      if (repo === undefined) return toolErr(`Repository ${owner}/${repoName} not found`);
      return toolOk(repoJson(repo));
    }
    case 'create_issue': {
      if (repoName === undefined) return toolErr('missing required argument: repo');
      const title = pickString(args, 'title');
      if (title === undefined) return toolErr('missing required argument: title');
      const repo = store.getRepo(owner, repoName);
      if (repo === undefined) return toolErr(`Repository ${owner}/${repoName} not found`);
      const created = createIssueInRepo(store, repo, title, pickString(args, 'body') ?? '', []);
      if ('error' in created) return toolErr(created.error);
      const issue = created.issue;
      return toolOk({
        id: issue.id,
        number: issue.number,
        title: issue.title,
        body: issue.body,
        state: issue.state,
        labels: issue.labels,
        url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
      });
    }
    case 'list_issues': {
      if (repoName === undefined) return toolErr('missing required argument: repo');
      const repo = store.getRepo(owner, repoName);
      if (repo === undefined) return toolErr(`Repository ${owner}/${repoName} not found`);
      const state = pickString(args, 'state') ?? 'open';
      const list = repo.issues
        .filter((i) => state === 'all' || i.state === state)
        .map((i) => ({ id: i.id, number: i.number, title: i.title, body: i.body, state: i.state, labels: i.labels }));
      return toolOk(list);
    }
    case 'create_pull_request': {
      if (repoName === undefined) return toolErr('missing required argument: repo');
      const title = pickString(args, 'title');
      const head = pickString(args, 'head', 'head_branch');
      const base = pickString(args, 'base', 'base_branch');
      if (title === undefined) return toolErr('missing required argument: title');
      if (head === undefined) return toolErr('missing required argument: head');
      if (base === undefined) return toolErr('missing required argument: base');
      const repo = store.getRepo(owner, repoName);
      if (repo === undefined) return toolErr(`Repository ${owner}/${repoName} not found`);
      const created = createPullInRepo(store, repo, title, pickString(args, 'body') ?? '', head, base);
      if ('error' in created) return toolErr(created.error);
      const pr = created.pr;
      return toolOk({
        id: pr.id,
        number: pr.number,
        title: pr.title,
        body: pr.body,
        state: pr.state,
        head: { ref: pr.headRef, sha: pr.headSha },
        base: { ref: pr.baseRef, sha: pr.baseSha },
      });
    }
    case 'merge_pull_request': {
      if (repoName === undefined) return toolErr('missing required argument: repo');
      const number = pickNumber(args, 'pull_number', 'number', 'pull_request_number');
      if (number === undefined) return toolErr('missing required argument: pull_number');
      const repo = store.getRepo(owner, repoName);
      if (repo === undefined) return toolErr(`Repository ${owner}/${repoName} not found`);
      const pr = repo.pulls.find((p) => p.number === number);
      if (pr === undefined) return toolErr(`Pull request #${number} not found`);
      const merged = mergePullInRepo(store, repo, pr);
      if ('error' in merged) return toolErr(merged.error);
      return toolOk({ number: pr.number, merged: true, state: pr.state, sha: merged.sha });
    }
    default:
      return toolErr(`Unknown tool: ${name}`);
  }
}

function sendRpc(res: ServerResponse, status: number, payload: unknown): void {
  const text = `${JSON.stringify(payload)}\n`;
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

export function handleMcp(store: Store, req: IncomingMessage, res: ServerResponse, rawBody: Buffer, requestId: string): void {
  void requestId;
  if (req.method === 'GET' || req.method === 'DELETE') {
    res.writeHead(405, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ message: 'Method Not Allowed' }));
    return;
  }
  if (req.method !== 'POST') {
    res.writeHead(405, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ message: 'Method Not Allowed' }));
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString('utf8'));
  } catch {
    sendRpc(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    sendRpc(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } });
    return;
  }
  const body = parsed as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };
  const id = body.id === undefined ? null : body.id;
  const method = typeof body.method === 'string' ? body.method : '';
  const params = (body.params ?? {}) as Record<string, unknown>;
  // A notification (no id) is answered 202 with no body.
  if (body.id === undefined) {
    res.writeHead(202);
    res.end();
    return;
  }
  const ok = (result: unknown): void => sendRpc(res, 200, { jsonrpc: '2.0', id, result });
  const err = (code: number, message: string): void => sendRpc(res, 200, { jsonrpc: '2.0', id, error: { code, message } });

  if (method === 'server/discover') {
    ok({
      protocolVersion: '2026-07-28',
      supportedVersions: ['2026-07-28', '2025-11-25'],
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      capabilities: { tools: {} },
      _meta: { 'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION } },
    });
    return;
  }
  if (method === 'initialize') {
    const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : '2026-07-28';
    ok({
      protocolVersion: offered,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    });
    return;
  }
  if (method === 'ping') {
    ok({});
    return;
  }
  if (method === 'tools/list') {
    ok({ tools: TOOLS });
    return;
  }
  if (method === 'tools/call') {
    const toolName = typeof params.name === 'string' ? params.name : '';
    const tool = TOOLS.find((t) => t.name === toolName);
    if (tool === undefined) {
      err(-32602, `Unknown tool: ${toolName}`);
      return;
    }
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    // Missing required arguments answer isError:true (the suite accepts that or -32602).
    const missing = tool.inputSchema.required.filter((key) => args[key] === undefined || args[key] === null || args[key] === '');
    if (missing.length > 0) {
      ok({ content: [{ type: 'text', text: `missing required argument: ${missing.join(', ')}` }], isError: true });
      return;
    }
    ok(callTool(store, toolName, args));
    return;
  }
  err(-32601, `Method not found: ${method}`);
}

// Referenced by app.ts for the shared store type.
export type { Repo };
