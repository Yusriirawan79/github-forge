# github-forge

[![make.fun bounty](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01)
[![make.fun rank](https://make.fun/badge/github-core-clone-01/Yusriirawan79/github-forge/rank.svg)](https://make.fun/bounty/github-core-clone-01)
[![make.fun reward](https://make.fun/badge/github-core-clone-01/Yusriirawan79/github-forge/reward.svg)](https://make.fun/bounty/github-core-clone-01)

A GitHub-compatible git forge in one Node process, standard library only, built for the
[make.fun bounty "Build a GitHub-compatible git forge"](https://make.fun/bounty/github-core-clone-01)
(`github-core-clone-01`). No dependencies, no git binary, no outside service, no UI.

## What it serves

| Route | What it is |
| --- | --- |
| `GET /healthz` | 200 `{"ok":true}`: the env's boot probe |
| `GET /api/v3/` | 200, `X-Oauth-Scopes: repo, read:org`, a JSON API root |
| `/api/v3/...` | GitHub REST v3: repositories, branches, commits, contents, labels, issues, comments, pull requests, files, merges |
| `POST /api/graphql` | GitHub GraphQL v4: viewer, repository, issue/pull-request reads, introspection, and the create/close/merge mutations |
| `POST /mcp` | Model Context Protocol over Streamable HTTP (2026-07-28 era): `server/discover`, `initialize`, `tools/list`, `tools/call` |
| `/<owner>/<repo>.git/...` | git smart HTTP: `info/refs`, `git-upload-pack` (protocol v2 and v0), `git-receive-pack` (v0) |
| anything else | 404 `{"message":"Not Found"}` |

## Run it

```sh
node --experimental-strip-types main.ts
```

`main.ts` binds an ephemeral port, registers it with `$MAKEFUN_ENV_URL`, polls
`GET /done` and exits 0. `app.ts` is the server; the rest of the modules are the forge:

- `store.ts` — the in-memory store and its deterministic clock (no `Date.now` or
  `Math.random` in request handling, so two runs over the same requests leave
  byte-identical state).
- `gitobjs.ts` — pkt-line framing, packfiles (read, write, deltas) and the
  reachability walk a fetch or clone needs.
- `gitproto.ts` — the git smart-HTTP handlers.
- `rest.ts` — REST v3 resources and the shared create/merge mutations.
- `graphql.ts` — a small GraphQL parser and executor over the same store.
- `mcp.ts` — the MCP tools, running through the same store functions as REST.

## Design notes

- **One store, four surfaces.** Git, REST, GraphQL and MCP all read and write the same
  repositories, issues and pull requests, so an object created over one surface is the
  same object — same id — over the others.
- **Fast paths for the timed workloads.** Fetch/clone packs are cached per request
  signature and invalidated on any mutation; issue reads are plain map lookups on a
  keep-alive connection; pushes inflate and store only the three objects they carry.
- **Deterministic.** Commit timestamps and `created_at`/`updated_at` come from a counter
  seeded at a fixed epoch, so replays are byte-identical.
- **Fast-forward only.** `receive-pack` refuses non-fast-forward updates per ref with
  `ng <ref> non-fast-forward` and applies the refs that do fast-forward.

## License

MIT. See [LICENSE](LICENSE).
