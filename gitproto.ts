// Git smart HTTP: info/refs advertisements, upload-pack (protocol v2 and v0) and
// receive-pack (v0 only). The wire shapes here mirror the kit's git-client.ts exactly:
// v2 advertisements start with `version 2`, ls-refs answers `unborn HEAD` on an empty
// repository, fetch answers in delimited sections, and push reports travel inside
// side-band-64k band 1 as pkt-lined `unpack`/`ok`/`ng` lines.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  decodePktLines,
  encodePktLines,
  pktDelim,
  pktFlush,
  pktLine,
  readPack,
  selectFetchObjects,
  splitPktAndRest,
  verifyPackChecksum,
  writePack,
  type Pkt,
} from './gitobjs.ts';
import { hashObject, parseCommit, parseTag, parseTree, ZERO_OID, type Repo, type Store } from './store.ts';

const AGENT = 'forge/1.0';

/** Every ref the repository advertises, HEAD first, then lexical order. */
export function advertisedRefs(repo: Repo): Array<{ oid: string; name: string; peeled?: string }> {
  const out: Array<{ oid: string; name: string; peeled?: string }> = [];
  const headTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (headTip !== undefined) out.push({ oid: headTip, name: 'HEAD' });
  const names = [...repo.refs.keys()].sort();
  for (const name of names) {
    const oid = repo.refs.get(name) as string;
    const entry: { oid: string; name: string; peeled?: string } = { oid, name };
    const obj = repo.objects.get(oid);
    if (obj !== undefined && obj.type === 'tag') entry.peeled = parseTag(obj.data).object;
    out.push(entry);
  }
  return out;
}

function headSymref(repo: Repo): string {
  return `refs/heads/${repo.defaultBranch}`;
}

/** Clear the cached fetch/clone packs: any ref or object change invalidates them. */
export function touchRepo(repo: Repo): void {
  repo.packCache.clear();
}

function isAncestor(repo: Repo, ancestor: string, tip: string): boolean {
  if (ancestor === tip) return true;
  const seen = new Set<string>();
  const queue = [tip];
  while (queue.length > 0) {
    const oid = queue.pop() as string;
    if (oid === ancestor) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = repo.objects.get(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    for (const parent of parseCommit(obj.data).parents) queue.push(parent);
  }
  return false;
}

// ------------------------------------------------------------------ advertisements

function v2Advertisement(repo: Repo, service: string): Buffer {
  const lines: Array<string | 'flush'> = [
    `# service=${service}\n`,
    'flush',
    'version 2\n',
    `agent=${AGENT}\n`,
    'object-format=sha1\n',
    'ls-refs=unborn\n',
    'fetch=shallow thin-pack no-progress ofs-delta filter wait-for-done\n',
    'server-option\n',
    'flush',
  ];
  return encodePktLines(lines);
}

function v0Advertisement(repo: Repo, service: string): Buffer {
  const caps =
    service === 'git-receive-pack'
      ? `report-status side-band-64k delete-refs ofs-delta agent=${AGENT} symref=HEAD:${headSymref(repo)}`
      : `multi_ack multi_ack_detailed thin-pack side-band side-band-64k ofs-delta shallow deepen-since deepen-not no-progress include-tag allow-tip-sha1-in-want allow-reachable-sha1-in-want no-done agent=${AGENT} symref=HEAD:${headSymref(repo)}`;
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), pktFlush()];
  const refs = advertisedRefs(repo);
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    refs.forEach((ref, index) => {
      const line = index === 0 ? `${ref.oid} ${ref.name}\0${caps}\n` : `${ref.oid} ${ref.name}\n`;
      parts.push(pktLine(line));
      if (ref.peeled !== undefined) parts.push(pktLine(`${ref.peeled} ${ref.name}^{}\n`));
    });
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

export function handleInfoRefs(repo: Repo | undefined, service: string, req: IncomingMessage, res: ServerResponse): void {
  if (repo === undefined || (service !== 'git-upload-pack' && service !== 'git-receive-pack')) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('Not Found');
    return;
  }
  const wantV2 = service === 'git-upload-pack' && (req.headers['git-protocol'] ?? '').includes('version=2');
  const body = wantV2 ? v2Advertisement(repo, service) : v0Advertisement(repo, service);
  res.writeHead(200, { 'content-type': `application/x-${service}-advertisement`, 'content-length': body.length });
  res.end(body);
}

// ------------------------------------------------------------------ upload-pack

interface FetchRequest {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
}

/** Chunk a pack into side-band-64k band-1 pkt-lines (payload <= 65515 bytes). */
function sidebandPack(pack: Buffer): Buffer[] {
  const out: Buffer[] = [];
  const CHUNK = 65515;
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    const slice = pack.subarray(offset, Math.min(pack.length, offset + CHUNK));
    out.push(pktLine(Buffer.concat([Buffer.from([1]), slice])));
  }
  if (pack.length === 0) out.push(pktLine(Buffer.concat([Buffer.from([1]), writePack([])])));
  return out;
}

function fetchPackFor(repo: Repo, req: FetchRequest): { pack: Buffer; shallow: string[]; unshallow: string[] } {
  const key = JSON.stringify({ w: [...req.wants].sort(), h: [...req.haves].sort(), s: [...req.shallow].sort(), d: req.depth });
  const cached = repo.packCache.get(key);
  if (cached !== undefined) return cached;
  const sel = selectFetchObjects(repo, req.wants, req.haves, req.shallow, req.depth);
  const result = { pack: writePack(sel.objects), shallow: sel.shallow, unshallow: sel.unshallow };
  repo.packCache.set(key, result);
  return result;
}

function v2Fetch(repo: Repo, req: FetchRequest): Buffer {
  const { pack, shallow, unshallow } = fetchPackFor(repo, req);
  const parts: Buffer[] = [];
  const ackLines: string[] = [];
  if (req.haves.length === 0) ackLines.push('NAK\n');
  else {
    for (const have of req.haves) if (repo.objects.has(have)) ackLines.push(`ACK ${have}\n`);
    if (ackLines.length === 0) ackLines.push('NAK\n');
  }
  ackLines.push('ready\n');
  parts.push(pktLine('acknowledgments\n'));
  for (const line of ackLines) parts.push(pktLine(line));
  parts.push(pktDelim());
  if (req.depth !== null || req.shallow.length > 0 || shallow.length > 0 || unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(pktDelim());
  }
  const wantedRefs: string[] = [];
  for (const want of req.wants) {
    for (const [name, oid] of repo.refs) if (oid === want) wantedRefs.push(`${want} ${name}\n`);
  }
  if (wantedRefs.length > 0) {
    parts.push(pktLine('wanted-refs\n'));
    for (const line of wantedRefs) parts.push(pktLine(line));
    parts.push(pktDelim());
  }
  parts.push(pktLine('packfile\n'));
  for (const chunk of sidebandPack(pack)) parts.push(chunk);
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

function v0Fetch(repo: Repo, req: FetchRequest): Buffer {
  const { pack, shallow, unshallow } = fetchPackFor(repo, req);
  const parts: Buffer[] = [];
  if (req.haves.length === 0) parts.push(pktLine('NAK\n'));
  else {
    let acked = false;
    for (const have of req.haves) {
      if (repo.objects.has(have)) {
        parts.push(pktLine(`ACK ${have}\n`));
        acked = true;
      }
    }
    if (!acked) parts.push(pktLine('NAK\n'));
  }
  for (const oid of shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  for (const chunk of sidebandPack(pack)) parts.push(chunk);
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

function parseV2Lines(packets: Pkt[]): { command: string; args: string[] } {
  let command = '';
  const args: string[] = [];
  let pastDelim = false;
  for (const packet of packets) {
    if (packet.kind !== 'data') {
      if (packet.kind === 'delim') pastDelim = true;
      continue;
    }
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (!pastDelim && line.startsWith('command=')) command = line.slice('command='.length);
    else if (line.startsWith('agent=') || line.startsWith('object-format=')) continue;
    else args.push(line);
  }
  return { command, args };
}

function v2LsRefs(repo: Repo, args: readonly string[]): Buffer {
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const arg of args) {
    if (arg === 'peel') peel = true;
    else if (arg === 'symrefs') symrefs = true;
    else if (arg === 'unborn') unborn = true;
    else if (arg.startsWith('ref-prefix ')) prefixes.push(arg.slice('ref-prefix '.length));
  }
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
  const parts: Buffer[] = [];
  const headTip = repo.refs.get(headSymref(repo));
  if (keep('HEAD')) {
    if (headTip === undefined) {
      if (unborn) parts.push(pktLine(`unborn HEAD${symrefs ? ` symref-target:${headSymref(repo)}` : ''}\n`));
    } else {
      parts.push(pktLine(`${headTip} HEAD${symrefs ? ` symref-target:${headSymref(repo)}` : ''}\n`));
    }
  }
  const names = [...repo.refs.keys()].sort();
  for (const name of names) {
    if (!keep(name)) continue;
    const oid = repo.refs.get(name) as string;
    let line = `${oid} ${name}`;
    if (symrefs && name === headSymref(repo)) line += ` symref-target:${headSymref(repo)}`;
    if (peel) {
      const obj = repo.objects.get(oid);
      if (obj !== undefined && obj.type === 'tag') line += ` peeled:${parseTag(obj.data).object}`;
    }
    parts.push(pktLine(`${line}\n`));
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

export function handleUploadPack(repo: Repo | undefined, body: Buffer, req: IncomingMessage, res: ServerResponse): void {
  if (repo === undefined) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('Not Found');
    return;
  }
  let packets: Pkt[];
  try {
    packets = decodePktLines(body);
  } catch {
    res.writeHead(400, { 'content-type': 'text/plain' });
    res.end('bad pkt-line');
    return;
  }
  const isV2 = (req.headers['git-protocol'] ?? '').includes('version=2');
  if (isV2) {
    const { command, args } = parseV2Lines(packets);
    if (command === 'ls-refs') {
      const out = v2LsRefs(repo, args);
      res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-result', 'content-length': out.length });
      res.end(out);
      return;
    }
    if (command === 'fetch') {
      const fetchReq: FetchRequest = { wants: [], haves: [], shallow: [], depth: null };
      for (const arg of args) {
        if (arg.startsWith('want ')) fetchReq.wants.push(arg.slice(5).trim());
        else if (arg.startsWith('have ')) fetchReq.haves.push(arg.slice(5).trim());
        else if (arg.startsWith('shallow ')) fetchReq.shallow.push(arg.slice(8).trim());
        else if (arg.startsWith('deepen ')) fetchReq.depth = Number(arg.slice(7).trim());
      }
      if (fetchReq.wants.length === 0) {
        res.writeHead(400, { 'content-type': 'text/plain' });
        res.end('no wants');
        return;
      }
      const out = v2Fetch(repo, fetchReq);
      res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-result', 'content-length': out.length });
      res.end(out);
      return;
    }
    res.writeHead(400, { 'content-type': 'text/plain' });
    res.end('unknown command');
    return;
  }
  // Protocol v0: want/have/shallow/deepen lines in two sections.
  const fetchReq: FetchRequest = { wants: [], haves: [], shallow: [], depth: null };
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    const firstSpace = line.indexOf(' ');
    const verb = firstSpace < 0 ? line : line.slice(0, firstSpace);
    const rest = firstSpace < 0 ? '' : line.slice(firstSpace + 1);
    if (verb === 'want') fetchReq.wants.push(rest.split(' ')[0] as string);
    else if (verb === 'have') fetchReq.haves.push(rest.trim());
    else if (verb === 'shallow') fetchReq.shallow.push(rest.trim());
    else if (verb === 'deepen') fetchReq.depth = Number(rest.trim());
  }
  if (fetchReq.wants.length === 0) {
    res.writeHead(400, { 'content-type': 'text/plain' });
    res.end('no wants');
    return;
  }
  const out = v0Fetch(repo, fetchReq);
  res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-result', 'content-length': out.length });
  res.end(out);
}

// ------------------------------------------------------------------ receive-pack

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

export function handleReceivePack(repo: Repo | undefined, body: Buffer, _req: IncomingMessage, res: ServerResponse): void {
  if (repo === undefined) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('Not Found');
    return;
  }
  let split: { packets: Pkt[]; rest: Buffer };
  try {
    split = splitPktAndRest(body);
  } catch {
    res.writeHead(400, { 'content-type': 'text/plain' });
    res.end('bad pkt-line');
    return;
  }
  const commands: PushCommand[] = [];
  for (const packet of split.packets) {
    if (packet.kind !== 'data') continue;
    let line = packet.payload.toString('utf8').replace(/\n$/, '');
    const nul = line.indexOf('\0');
    if (nul >= 0) line = line.slice(0, nul);
    const parts = line.split(' ');
    if (parts.length !== 3) {
      res.writeHead(400, { 'content-type': 'text/plain' });
      res.end('bad command line');
      return;
    }
    commands.push({ oldOid: parts[0] as string, newOid: parts[1] as string, ref: parts[2] as string });
  }
  if (commands.length === 0) {
    res.writeHead(400, { 'content-type': 'text/plain' });
    res.end('no commands');
    return;
  }
  // Unpack first: a pack the client sent is stored even when a ref update is refused,
  // exactly like git's unpack step.
  let unpackOk = true;
  let unpackDetail = 'ok';
  if (split.rest.length > 0) {
    try {
      const checksum = verifyPackChecksum(split.rest);
      if (!checksum.ok) throw new Error('pack checksum mismatch');
      const read = readPack(split.rest, (oid) => repo.objects.get(oid));
      for (const [oid, obj] of read.objects) repo.objects.set(oid, obj);
    } catch (err) {
      unpackOk = false;
      unpackDetail = err instanceof Error ? err.message : 'unpack error';
    }
  }
  const results: Array<{ ref: string; ok: boolean; reason: string }> = [];
  if (unpackOk) {
    for (const cmd of commands) {
      const current = repo.refs.get(cmd.ref);
      if (cmd.newOid === ZERO_OID) {
        // Delete.
        if (current === undefined) {
          results.push({ ref: cmd.ref, ok: false, reason: 'remote ref does not exist' });
        } else if (cmd.oldOid !== ZERO_OID && cmd.oldOid !== current) {
          results.push({ ref: cmd.ref, ok: false, reason: 'remote ref does not match expected value' });
        } else {
          repo.refs.delete(cmd.ref);
          results.push({ ref: cmd.ref, ok: true, reason: '' });
        }
        continue;
      }
      const target = repo.objects.get(cmd.newOid);
      if (target === undefined || target.type !== 'commit') {
        // A ref may point at an annotated tag; anything else is a missing object.
        if (target === undefined || target.type !== 'tag') {
          results.push({ ref: cmd.ref, ok: false, reason: 'object not found' });
          continue;
        }
      }
      if (current === undefined) {
        if (cmd.oldOid !== ZERO_OID) {
          results.push({ ref: cmd.ref, ok: false, reason: 'remote ref does not exist' });
          continue;
        }
        repo.refs.set(cmd.ref, cmd.newOid);
        results.push({ ref: cmd.ref, ok: true, reason: '' });
        continue;
      }
      if (cmd.oldOid !== current) {
        results.push({ ref: cmd.ref, ok: false, reason: 'remote ref does not match expected value' });
        continue;
      }
      if (cmd.oldOid === cmd.newOid) {
        results.push({ ref: cmd.ref, ok: true, reason: '' });
        continue;
      }
      if (!isAncestor(repo, cmd.oldOid, cmd.newOid)) {
        results.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' });
        continue;
      }
      repo.refs.set(cmd.ref, cmd.newOid);
      results.push({ ref: cmd.ref, ok: true, reason: '' });
    }
    touchRepo(repo);
  } else {
    for (const cmd of commands) results.push({ ref: cmd.ref, ok: false, reason: unpackDetail });
  }
  const reportLines: string[] = [unpackOk ? 'unpack ok\n' : `unpack ${unpackDetail}\n`];
  for (const result of results) {
    reportLines.push(result.ok ? `ok ${result.ref}\n` : `ng ${result.ref} ${result.reason}\n`);
  }
  const inner = encodePktLines(reportLines);
  const outer = pktLine(Buffer.concat([Buffer.from([1]), inner]));
  const out = Buffer.concat([outer, pktFlush()]);
  res.writeHead(200, { 'content-type': 'application/x-git-receive-pack-result', 'content-length': out.length });
  res.end(out);
}

