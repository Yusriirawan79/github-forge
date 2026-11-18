// GitHub GraphQL v4: a small parser for the documents the suite sends (viewer,
// repository, __type introspection, issue/pull-request reads and the five mutations)
// plus an executor over the same store REST uses, so ids and objects agree everywhere.
// Unknown fields answer HTTP 200 with an errors array, as GitHub does.

import { createIssueInRepo, createPullInRepo, mergeableOf, mergePullInRepo, sendJson, type RestCtx } from './rest.ts';
import { EPOCH_SEC, globalId, parseGlobalId, VIEWER_ID, VIEWER_LOGIN, VIEWER_NAME, type Issue, type PullRequest, type Repo, type Store } from './store.ts';

// ------------------------------------------------------------------ lexer

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: string }
  | { kind: 'float'; value: string }
  | { kind: 'punct'; value: string }
  | { kind: 'eof' };

function lex(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i] as string;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < input.length && input[i] !== '\n') i += 1;
      continue;
    }
    if ('{}()[]:!=$@&|'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '.' && input.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < input.length && input[j] !== '"') {
        if (input[j] === '\\' && j + 1 < input.length) {
          const esc = input[j + 1] as string;
          out += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          j += 2;
        } else {
          out += input[j];
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      let isFloat = false;
      while (j < input.length && /[0-9.eE+-]/.test(input[j] as string)) {
        if (input[j] === '.' || input[j] === 'e' || input[j] === 'E') isFloat = true;
        j += 1;
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: input.slice(i, j) });
      i = j;
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      let j = i;
      while (j < input.length && /[_A-Za-z0-9]/.test(input[j] as string)) j += 1;
      tokens.push({ kind: 'name', value: input.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  tokens.push({ kind: 'eof' });
  return tokens;
}

// ------------------------------------------------------------------ parser

export type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; items: ValueNode[] }
  | { kind: 'object'; fields: Record<string, ValueNode> };

export interface FieldNode {
  kind: 'field';
  name: string;
  alias: string | null;
  args: Record<string, ValueNode>;
  children: SelectionNode[];
}

export interface InlineNode {
  kind: 'inline';
  typeCondition: string | null;
  children: SelectionNode[];
}

export type SelectionNode = FieldNode | InlineNode;

export interface Operation {
  kind: 'query' | 'mutation';
  name: string | null;
  variables: Record<string, ValueNode>;
  selections: SelectionNode[];
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.pos] as Token;
  }

  private next(): Token {
    const tok = this.tokens[this.pos] as Token;
    this.pos += 1;
    return tok;
  }

  private expectPunct(value: string): void {
    const tok = this.next();
    if (tok.kind !== 'punct' || tok.value !== value) throw new Error(`expected ${value}, got ${tok.kind} ${'value' in tok ? tok.value : ''}`);
  }

  private expectName(value?: string): string {
    const tok = this.next();
    if (tok.kind !== 'name') throw new Error(`expected a name, got ${tok.kind}`);
    if (value !== undefined && tok.value !== value) throw new Error(`expected ${value}, got ${tok.value}`);
    return tok.value;
  }

  parseDocument(): Operation[] {
    const ops: Operation[] = [];
    while (this.peek().kind !== 'eof') {
      ops.push(this.parseOperation());
    }
    return ops;
  }

  private parseOperation(): Operation {
    let kind: 'query' | 'mutation' = 'query';
    let name: string | null = null;
    const tok = this.peek();
    if (tok.kind === 'name' && (tok.value === 'query' || tok.value === 'mutation')) {
      kind = tok.value;
      this.next();
      const next = this.peek();
      if (next.kind === 'name') name = this.next().value as string;
    }
    const variables: Record<string, ValueNode> = {};
    if (this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '(') {
      this.next();
      while (!(this.peek().kind === 'punct' && (this.peek() as { value: string }).value === ')')) {
        this.expectPunct('$');
        const varName = this.expectName();
        this.expectPunct(':');
        // Skip the type (a name, possibly wrapped in [] and !).
        this.skipType();
        if (this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '=') {
          this.next();
          variables[varName] = this.parseValue();
        }
        if (this.peek().kind === 'punct' && (this.peek() as { value: string }).value === ',') this.next();
      }
      this.expectPunct(')');
    }
    const selections = this.parseSelections();
    return { kind, name, variables, selections };
  }

  private skipType(): void {
    const tok = this.next();
    if (tok.kind === 'punct' && tok.value === '[') {
      this.skipType();
      this.expectPunct(']');
    } else if (tok.kind !== 'name') {
      throw new Error('expected a type name');
    }
    if (this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '!') this.next();
  }

  private parseSelections(): SelectionNode[] {
    this.expectPunct('{');
    const out: SelectionNode[] = [];
    while (!(this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '}')) {
      if (this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '...') {
        this.next();
        let typeCondition: string | null = null;
        const next = this.peek();
        if (next.kind === 'name' && next.value === 'on') {
          this.next();
          typeCondition = this.expectName();
        }
        const children = this.parseSelections();
        out.push({ kind: 'inline', typeCondition, children });
        continue;
      }
      out.push(this.parseField());
    }
    this.expectPunct('}');
    return out;
  }

  private parseField(): FieldNode {
    const first = this.expectName();
    let name = first;
    let alias: string | null = null;
    if (this.peek().kind === 'punct' && (this.peek() as { value: string }).value === ':') {
      this.next();
      alias = first;
      name = this.expectName();
    }
    const args: Record<string, ValueNode> = {};
    if (this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '(') {
      this.next();
      while (!(this.peek().kind === 'punct' && (this.peek() as { value: string }).value === ')')) {
        const argName = this.expectName();
        this.expectPunct(':');
        args[argName] = this.parseValue();
        if (this.peek().kind === 'punct' && (this.peek() as { value: string }).value === ',') this.next();
      }
      this.expectPunct(')');
    }
    // Directives (@...) are not used by the suite; skip them.
    while (this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '@') {
      this.next();
      this.expectName();
      if (this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '(') {
        this.next();
        let depth = 1;
        while (depth > 0) {
          const t = this.next();
          if (t.kind === 'punct' && t.value === '(') depth += 1;
          else if (t.kind === 'punct' && t.value === ')') depth -= 1;
        }
      }
    }
    let children: SelectionNode[] = [];
    if (this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '{') {
      children = this.parseSelections();
    }
    return { kind: 'field', name, alias, args, children };
  }

  private parseValue(): ValueNode {
    const tok = this.next();
    if (tok.kind === 'punct' && tok.value === '$') return { kind: 'variable', name: this.expectName() };
    if (tok.kind === 'string') return { kind: 'string', value: tok.value };
    if (tok.kind === 'int') return { kind: 'int', value: Number(tok.value) };
    if (tok.kind === 'float') return { kind: 'float', value: Number(tok.value) };
    if (tok.kind === 'punct' && tok.value === '[') {
      const items: ValueNode[] = [];
      while (!(this.peek().kind === 'punct' && (this.peek() as { value: string }).value === ']')) {
        items.push(this.parseValue());
        if (this.peek().kind === 'punct' && (this.peek() as { value: string }).value === ',') this.next();
      }
      this.expectPunct(']');
      return { kind: 'list', items };
    }
    if (tok.kind === 'punct' && tok.value === '{') {
      const fields: Record<string, ValueNode> = {};
      while (!(this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '}')) {
        const key = this.expectName();
        this.expectPunct(':');
        fields[key] = this.parseValue();
        if (this.peek().kind === 'punct' && (this.peek() as { value: string }).value === ',') this.next();
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    if (tok.kind === 'name') {
      if (tok.value === 'true') return { kind: 'boolean', value: true };
      if (tok.value === 'false') return { kind: 'boolean', value: false };
      if (tok.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: tok.value };
    }
    throw new Error(`unexpected value token ${tok.kind}`);
  }
}

// ------------------------------------------------------------------ executor

interface ExecCtx {
  store: Store;
  variables: Record<string, unknown>;
  errors: Array<{ message: string }>;
}

function resolveValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name];
    case 'string':
    case 'enum':
      return node.value;
    case 'int':
    case 'float':
      return node.value;
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'list':
      return node.items.map((item) => resolveValue(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(node.fields)) out[key] = resolveValue(value, variables);
      return out;
    }
  }
}

function argsOf(field: FieldNode, ctx: ExecCtx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(field.args)) out[key] = resolveValue(value, ctx.variables);
  return out;
}

function isoOfSeq(seq: number): string {
  return new Date((EPOCH_SEC + seq) * 1000).toISOString();
}

const ISSUE_FIELDS = ['id', 'number', 'title', 'body', 'state', 'author', 'assignees', 'labels', 'comments', 'createdAt', 'updatedAt', 'url', 'closed', 'locked', 'milestone', 'reactions', 'timelineItems', 'participants', 'projectCards', 'databaseId'];
const PULL_FIELDS = ['id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'headRef', 'baseRef', 'headRefOid', 'baseRefOid', 'files', 'author', 'createdAt', 'updatedAt', 'url', 'closed', 'additions', 'deletions', 'changedFiles', 'commits', 'reviews', 'reviewRequests', 'labels', 'assignees', 'milestone', 'databaseId'];
const REPO_FIELDS = ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'isPrivate', 'createdAt', 'updatedAt', 'url', 'forkCount', 'stargazerCount', 'watchers', 'labels', 'milestones', 'branches', 'defaultBranch'];
const SEARCH_ENUM = ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'MILESTONE', 'PROJECT', 'WIKI'];

type Parent =
  | { kind: 'Query' }
  | { kind: 'Viewer' }
  | { kind: 'Repository'; repo: Repo }
  | { kind: 'Issue'; repo: Repo; issue: Issue }
  | { kind: 'PullRequest'; repo: Repo; pr: PullRequest }
  | { kind: 'IssueConnection'; repo: Repo; issues: Issue[]; endCursor: string | null; hasNext: boolean }
  | { kind: 'PullConnection'; repo: Repo; pulls: PullRequest[] }
  | { kind: 'FileConnection'; files: Array<{ path: string }> }
  | { kind: 'CommentEdge'; id: string; body: string }
  | { kind: 'Owner'; login: string }
  | { kind: 'Ref'; name: string }
  | { kind: 'Type'; name: string }
  | { kind: 'PageInfo'; hasNextPage: boolean; endCursor: string | null };

function cursorOf(index: number): string {
  return Buffer.from(`cursor:${index}`, 'utf8').toString('base64');
}

function indexOfCursor(cursor: string | null): number {
  if (cursor === null) return -1;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const m = /^cursor:(\d+)$/.exec(text);
    return m ? Number(m[1]) : -1;
  } catch {
    return -1;
  }
}

function executeSelections(parent: Parent, selections: SelectionNode[], ctx: ExecCtx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const sel of selections) {
    if (sel.kind === 'inline') {
      const typeName = parent.kind === 'Repository' ? 'Repository' : parent.kind === 'Issue' ? 'Issue' : parent.kind === 'PullRequest' ? 'PullRequest' : parent.kind;
      if (sel.typeCondition !== null && sel.typeCondition !== typeName) continue;
      Object.assign(out, executeSelections(parent, sel.children, ctx));
      continue;
    }
    const key = sel.alias ?? sel.name;
    out[key] = executeField(parent, sel, ctx);
  }
  return out;
}

function unknownField(parent: Parent, field: FieldNode, ctx: ExecCtx): null {
  ctx.errors.push({ message: `Cannot query field "${field.name}" on type "${parent.kind === 'Query' ? 'Query' : parent.kind}".` });
  return null;
}

function executeField(parent: Parent, field: FieldNode, ctx: ExecCtx): unknown {
  const args = argsOf(field, ctx);
  switch (parent.kind) {
    case 'Query': {
      if (field.name === 'viewer') {
        if (field.children.length === 0) return { login: VIEWER_LOGIN };
        return executeSelections({ kind: 'Viewer' }, field.children, ctx);
      }
      if (field.name === 'repository') {
        const owner = String(args.owner ?? '');
        const name = String(args.name ?? '');
        const repo = ctx.store.getRepo(owner, name);
        if (repo === undefined) return null;
        if (field.children.length === 0) return {};
        return executeSelections({ kind: 'Repository', repo }, field.children, ctx);
      }
      if (field.name === 'node') {
        const parsed = parseGlobalId(String(args.id ?? ''));
        if (parsed === null) return null;
        const repo = ctx.store.reposById.get(parsed.repoId);
        if (repo === undefined) return null;
        if (field.children.length === 0) return {};
        return executeSelections({ kind: 'Repository', repo }, field.children, ctx);
      }
      if (field.name === '__type') {
        return executeSelections({ kind: 'Type', name: String(args.name ?? '') }, field.children, ctx);
      }
      if (field.name === '__schema') {
        return { queryType: { name: 'Query' }, mutationType: { name: 'Mutation' } };
      }
      return unknownField(parent, field, ctx);
    }
    case 'Viewer': {
      if (field.name === 'login') return VIEWER_LOGIN;
      if (field.name === 'id') return globalId('User', VIEWER_ID, 0);
      if (field.name === 'name') return VIEWER_NAME;
      if (field.name === 'email') return '';
      if (field.name === '__typename') return 'User';
      return unknownField(parent, field, ctx);
    }
    case 'Owner': {
      if (field.name === 'login') return parent.login;
      if (field.name === '__typename') return 'User';
      return unknownField(parent, field, ctx);
    }
    case 'Ref': {
      if (field.name === 'name') return parent.name;
      if (field.name === '__typename') return 'Ref';
      return unknownField(parent, field, ctx);
    }
    case 'Type': {
      if (field.name === 'name') return parent.name;
      if (field.name === 'kind') return parent.name === 'SearchType' ? 'ENUM' : 'OBJECT';
      if (field.name === 'fields') {
        const names = parent.name === 'Issue' ? ISSUE_FIELDS : parent.name === 'PullRequest' ? PULL_FIELDS : parent.name === 'Repository' ? REPO_FIELDS : [];
        return names.map((n) => ({ name: n, description: null, type: { name: 'String', kind: 'SCALAR' } }));
      }
      if (field.name === 'enumValues') {
        if (parent.name !== 'SearchType') return [];
        return SEARCH_ENUM.map((n) => ({ name: n, description: null }));
      }
      if (field.name === '__typename') return '__Type';
      return unknownField(parent, field, ctx);
    }
    case 'Repository': {
      const repo = parent.repo;
      if (field.name === '__typename') return 'Repository';
      if (field.name === 'id') return globalId('Repository', repo.id, 0);
      if (field.name === 'databaseId') return repo.id;
      if (field.name === 'name') return repo.name;
      if (field.name === 'nameWithOwner') return `${repo.owner}/${repo.name}`;
      if (field.name === 'owner') return executeSelections({ kind: 'Owner', login: repo.owner }, field.children, ctx);
      if (field.name === 'defaultBranchRef') return executeSelections({ kind: 'Ref', name: repo.defaultBranch }, field.children, ctx);
      if (field.name === 'defaultBranch') return repo.defaultBranch;
      if (field.name === 'viewerPermission') return 'ADMIN';
      if (field.name === 'hasIssuesEnabled') return true;
      if (field.name === 'description') return repo.description;
      if (field.name === 'isPrivate') return repo.private;
      if (field.name === 'createdAt') return isoOfSeq(repo.createdSeq);
      if (field.name === 'updatedAt') return isoOfSeq(repo.createdSeq);
      if (field.name === 'url') return `https://github.com/${repo.owner}/${repo.name}`;
      if (field.name === 'issue') {
        const issue = repo.issues.find((i) => i.number === Number(args.number));
        if (issue === undefined) return null;
        return executeSelections({ kind: 'Issue', repo, issue }, field.children, ctx);
      }
      if (field.name === 'issues') {
        const first = typeof args.first === 'number' ? args.first : 10;
        const after = typeof args.after === 'string' ? args.after : null;
        let list = [...repo.issues];
        const states = Array.isArray(args.states) ? (args.states as string[]) : [];
        if (states.length > 0) list = list.filter((i) => states.includes(i.state.toUpperCase()));
        const orderBy = (args.orderBy ?? {}) as Record<string, unknown>;
        const direction = String(orderBy.direction ?? 'DESC');
        list.sort((a, b) => (direction === 'DESC' ? b.createdSeq - a.createdSeq || b.number - a.number : a.createdSeq - b.createdSeq || a.number - b.number));
        const start = indexOfCursor(after) + 1;
        const page = list.slice(start, start + first);
        const endCursor = page.length > 0 ? cursorOf(start + page.length - 1) : null;
        const conn: Parent = { kind: 'IssueConnection', repo, issues: page, endCursor, hasNext: start + first < list.length };
        return executeSelections(conn, field.children, ctx);
      }
      if (field.name === 'pullRequests') {
        const first = typeof args.first === 'number' ? args.first : 10;
        const page = [...repo.pulls].slice(0, first);
        const conn: Parent = { kind: 'PullConnection', repo, pulls: page };
        return executeSelections(conn, field.children, ctx);
      }
      if (field.name === 'pullRequest') {
        const pr = repo.pulls.find((p) => p.number === Number(args.number));
        if (pr === undefined) return null;
        return executeSelections({ kind: 'PullRequest', repo, pr }, field.children, ctx);
      }
      return unknownField(parent, field, ctx);
    }
    case 'Issue': {
      const { issue, repo } = parent;
      if (field.name === '__typename') return 'Issue';
      if (field.name === 'id') return globalId('Issue', repo.id, issue.number);
      if (field.name === 'databaseId') return issue.id;
      if (field.name === 'number') return issue.number;
      if (field.name === 'title') return issue.title;
      if (field.name === 'body') return issue.body;
      if (field.name === 'state') return issue.state.toUpperCase();
      if (field.name === 'createdAt') return isoOfSeq(issue.createdSeq);
      if (field.name === 'updatedAt') return isoOfSeq(issue.updatedSeq);
      if (field.name === 'url') return `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`;
      if (field.name === 'closed') return issue.state === 'closed';
      return unknownField(parent, field, ctx);
    }
    case 'PullRequest': {
      const { pr, repo } = parent;
      if (field.name === '__typename') return 'PullRequest';
      if (field.name === 'id') return globalId('PullRequest', repo.id, pr.number);
      if (field.name === 'databaseId') return pr.id;
      if (field.name === 'number') return pr.number;
      if (field.name === 'title') return pr.title;
      if (field.name === 'body') return pr.body;
      if (field.name === 'state') return pr.state.toUpperCase();
      if (field.name === 'merged') return pr.merged;
      if (field.name === 'mergeable') return mergeableOf(repo, pr) ? 'MERGEABLE' : 'CONFLICTING';
      if (field.name === 'headRefName') return pr.headRef;
      if (field.name === 'baseRefName') return pr.baseRef;
      if (field.name === 'headRefOid') return pr.headSha;
      if (field.name === 'baseRefOid') return pr.baseSha;
      if (field.name === 'createdAt') return isoOfSeq(pr.createdSeq);
      if (field.name === 'updatedAt') return isoOfSeq(pr.createdSeq);
      if (field.name === 'url') return `https://github.com/${repo.owner}/${repo.name}/pull/${pr.number}`;
      if (field.name === 'closed') return pr.state === 'closed';
      if (field.name === 'files') {
        const first = typeof args.first === 'number' ? args.first : 10;
        const conn: Parent = { kind: 'FileConnection', files: pr.files.slice(0, first).map((f) => ({ path: f.filename })) };
        return executeSelections(conn, field.children, ctx);
      }
      return unknownField(parent, field, ctx);
    }
    case 'IssueConnection': {
      if (field.name === 'nodes') {
        return parent.issues.map((issue) => executeSelections({ kind: 'Issue', repo: parent.repo, issue }, field.children, ctx));
      }
      if (field.name === 'edges') {
        return parent.issues.map((issue) => ({ node: executeSelections({ kind: 'Issue', repo: parent.repo, issue }, field.children.length > 0 ? field.children : [], ctx) }));
      }
      if (field.name === 'pageInfo') {
        return executeSelections({ kind: 'PageInfo', hasNextPage: parent.hasNext, endCursor: parent.endCursor }, field.children, ctx);
      }
      if (field.name === 'totalCount') return parent.issues.length;
      return unknownField(parent, field, ctx);
    }
    case 'PullConnection': {
      if (field.name === 'nodes') {
        return parent.pulls.map((pr) => executeSelections({ kind: 'PullRequest', repo: parent.repo, pr }, field.children, ctx));
      }
      if (field.name === 'pageInfo') {
        return executeSelections({ kind: 'PageInfo', hasNextPage: false, endCursor: null }, field.children, ctx);
      }
      if (field.name === 'totalCount') return parent.pulls.length;
      return unknownField(parent, field, ctx);
    }
    case 'FileConnection': {
      if (field.name === 'nodes') {
        return parent.files.map((f) => {
          const out: Record<string, unknown> = {};
          for (const child of field.children) if (child.kind === 'field') out[child.alias ?? child.name] = child.name === 'path' ? f.path : null;
          return out;
        });
      }
      if (field.name === 'pageInfo') {
        return executeSelections({ kind: 'PageInfo', hasNextPage: false, endCursor: null }, field.children, ctx);
      }
      return unknownField(parent, field, ctx);
    }
    case 'CommentEdge': {
      if (field.name === 'node') {
        const out: Record<string, unknown> = {};
        for (const child of field.children) {
          if (child.kind !== 'field') continue;
          if (child.name === 'id') out[child.alias ?? 'id'] = parent.id;
          else if (child.name === 'body') out[child.alias ?? 'body'] = parent.body;
          else out[child.alias ?? child.name] = null;
        }
        return out;
      }
      return unknownField(parent, field, ctx);
    }
    case 'PageInfo': {
      if (field.name === 'hasNextPage') return parent.hasNextPage;
      if (field.name === 'endCursor') return parent.endCursor;
      if (field.name === 'hasPreviousPage') return false;
      if (field.name === 'startCursor') return null;
      return unknownField(parent, field, ctx);
    }
  }
}

// ------------------------------------------------------------------ mutations

function executeMutation(op: Operation, ctx: ExecCtx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const sel of op.selections) {
    if (sel.kind !== 'field') continue;
    const key = sel.alias ?? sel.name;
    const args = argsOf(sel, ctx);
    const input = (args.input ?? {}) as Record<string, unknown>;
    if (sel.name === 'createIssue') {
      const parsed = parseGlobalId(String(input.repositoryId ?? ''));
      const repo = parsed === null ? undefined : ctx.store.reposById.get(parsed.repoId);
      if (repo === undefined) {
        ctx.errors.push({ message: 'Could not resolve to a Repository with the id provided.' });
        out[key] = null;
        continue;
      }
      const created = createIssueInRepo(ctx.store, repo, String(input.title ?? ''), String(input.body ?? ''), []);
      if ('error' in created) {
        ctx.errors.push({ message: created.error });
        out[key] = null;
        continue;
      }
      const payload: Record<string, unknown> = {};
      for (const child of sel.children) {
        if (child.kind === 'field' && child.name === 'issue') {
          payload.issue = executeSelections({ kind: 'Issue', repo, issue: created.issue }, child.children, ctx);
        }
      }
      out[key] = payload;
      continue;
    }
    if (sel.name === 'closeIssue') {
      const parsed = parseGlobalId(String(input.issueId ?? ''));
      const repo = parsed === null ? undefined : ctx.store.reposById.get(parsed.repoId);
      const issue = repo?.issues.find((i) => i.number === parsed?.num);
      if (repo === undefined || issue === undefined) {
        ctx.errors.push({ message: 'Could not resolve to an Issue with the id provided.' });
        out[key] = null;
        continue;
      }
      issue.state = 'closed';
      ctx.store.stamp();
      issue.updatedSeq = ctx.store.seq;
      const payload: Record<string, unknown> = {};
      for (const child of sel.children) {
        if (child.kind === 'field' && child.name === 'issue') {
          payload.issue = executeSelections({ kind: 'Issue', repo, issue }, child.children, ctx);
        }
      }
      out[key] = payload;
      continue;
    }
    if (sel.name === 'createPullRequest') {
      const parsed = parseGlobalId(String(input.repositoryId ?? ''));
      const repo = parsed === null ? undefined : ctx.store.reposById.get(parsed.repoId);
      if (repo === undefined) {
        ctx.errors.push({ message: 'Could not resolve to a Repository with the id provided.' });
        out[key] = null;
        continue;
      }
      const created = createPullInRepo(ctx.store, repo, String(input.title ?? ''), String(input.body ?? ''), String(input.headRefName ?? ''), String(input.baseRefName ?? ''));
      if ('error' in created) {
        ctx.errors.push({ message: created.error });
        out[key] = null;
        continue;
      }
      const payload: Record<string, unknown> = {};
      for (const child of sel.children) {
        if (child.kind === 'field' && child.name === 'pullRequest') {
          payload.pullRequest = executeSelections({ kind: 'PullRequest', repo, pr: created.pr }, child.children, ctx);
        }
      }
      out[key] = payload;
      continue;
    }
    if (sel.name === 'mergePullRequest') {
      const parsed = parseGlobalId(String(input.pullRequestId ?? ''));
      const repo = parsed === null ? undefined : ctx.store.reposById.get(parsed.repoId);
      const pr = repo?.pulls.find((p) => p.number === parsed?.num);
      if (repo === undefined || pr === undefined) {
        ctx.errors.push({ message: 'Could not resolve to a PullRequest with the id provided.' });
        out[key] = null;
        continue;
      }
      const merged = mergePullInRepo(ctx.store, repo, pr);
      if ('error' in merged) {
        ctx.errors.push({ message: merged.error });
        out[key] = null;
        continue;
      }
      const payload: Record<string, unknown> = {};
      for (const child of sel.children) {
        if (child.kind === 'field' && child.name === 'pullRequest') {
          payload.pullRequest = executeSelections({ kind: 'PullRequest', repo, pr }, child.children, ctx);
        }
      }
      out[key] = payload;
      continue;
    }
    if (sel.name === 'addComment') {
      const parsed = parseGlobalId(String(input.subjectId ?? ''));
      const repo = parsed === null ? undefined : ctx.store.reposById.get(parsed.repoId);
      const issue = repo?.issues.find((i) => i.number === parsed?.num);
      if (repo === undefined || issue === undefined) {
        ctx.errors.push({ message: 'Could not resolve to an Issue with the id provided.' });
        out[key] = null;
        continue;
      }
      ctx.store.stamp();
      const comment = { id: ctx.store.nextCommentId, body: String(input.body ?? ''), userLogin: VIEWER_LOGIN, createdSeq: ctx.store.seq };
      ctx.store.nextCommentId += 1;
      issue.comments.push(comment);
      const payload: Record<string, unknown> = {};
      for (const child of sel.children) {
        if (child.kind === 'field' && child.name === 'commentEdge') {
          const edge: Parent = { kind: 'CommentEdge', id: globalId('IssueComment', repo.id, comment.id), body: comment.body };
          payload.commentEdge = executeSelections(edge, child.children, ctx);
        }
      }
      out[key] = payload;
      continue;
    }
    ctx.errors.push({ message: `Unknown mutation "${sel.name}".` });
    out[key] = null;
  }
  return out;
}

// ------------------------------------------------------------------ HTTP entry

export function handleGraphql(ctx: RestCtx): void {
  const raw = ctx.body;
  const runOne = (entry: unknown): Record<string, unknown> => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      return { errors: [{ message: 'Expected a GraphQL request object.' }] };
    }
    const { query, variables, operationName } = entry as { query?: unknown; variables?: unknown; operationName?: unknown };
    if (typeof query !== 'string') return { errors: [{ message: 'Must provide query string.' }] };
    let operations: Operation[];
    try {
      operations = new Parser(lex(query)).parseDocument();
    } catch (err) {
      return { errors: [{ message: err instanceof Error ? err.message : 'GraphQL parse error' }] };
    }
    const vars = (variables ?? {}) as Record<string, unknown>;
    const op = operations.find((o) => operationName === undefined || operationName === null || o.name === operationName) ?? operations[0];
    if (op === undefined) return { errors: [{ message: 'No operation to run.' }] };
    const execCtx: ExecCtx = { store: ctx.store, variables: vars, errors: [] };
    let data: Record<string, unknown>;
    if (op.kind === 'mutation') data = executeMutation(op, execCtx);
    else data = executeSelections({ kind: 'Query' }, op.selections, execCtx);
    const result: Record<string, unknown> = { data };
    if (execCtx.errors.length > 0) result.errors = execCtx.errors;
    return result;
  };
  if (Array.isArray(raw)) {
    sendJson(ctx, 200, raw.map(runOne));
    return;
  }
  sendJson(ctx, 200, runOne(raw));
}

