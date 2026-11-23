// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/* ---------------- section 5: tiered line matching ---------------- */

function normTrail(s: string): string { return s.replace(/[ \t]+$/, ''); }
function normTrim(s: string): string { return s.replace(/^[ \t]+|[ \t]+$/g, ''); }
function leadWS(s: string): string { const m = /^[ \t]*/.exec(s); return m ? m[0] : ''; }

function equalNorm(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return normTrail(a) === normTrail(b);
  return normTrim(a) === normTrim(b);
}

function matchAt(lines: string[], i: number, O: string[], tier: number): boolean {
  for (let j = 0; j < O.length; j++) {
    if (i + j >= lines.length) return false;
    if (!equalNorm(O[j]!, lines[i + j]!, tier)) return false;
  }
  return true;
}

function occurrences(lines: string[], O: string[], tier: number): number[] {
  const out: number[] = [];
  for (let i = 0; i + O.length <= lines.length; i++) {
    if (matchAt(lines, i, O, tier)) out.push(i);
  }
  return out;
}

/** First tier (0, then 1, then 2; only 0 with --strict) at which O occurs at least once. */
function findTier(lines: string[], O: string[], strict: boolean): number | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    if (occurrences(lines, O, tier).length > 0) return tier;
  }
  return null;
}

function reindent(line: string, tier: number, F: string, P: string): string {
  if (tier !== 2) return line;
  if (line === '' || /^[ \t]*$/.test(line)) return line;
  if (line.startsWith(P)) return F + line.slice(P.length);
  return line;
}

/* ---------------- file line representation ---------------- */

interface FileRep { lines: string[]; br: string; final: boolean; }

function splitFile(text: string): FileRep {
  if (text === '') return { lines: [], br: '\n', final: false };
  let br = '\n';
  const nl = text.indexOf('\n');
  if (nl > 0 && text[nl - 1] === '\r') br = '\r\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  const lines = final ? parts.slice(0, -1) : parts;
  return { lines, br, final };
}

function joinFile(lines: string[], br: string, final: boolean): string {
  if (lines.length === 0) return '';
  let s = lines.join(br);
  if (final) s += br;
  return s;
}

/* ---------------- tree ---------------- */

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

/* ---------------- section 4: format detection ---------------- */

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/* ---------------- section 9: JSON edits ---------------- */

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/* ---------------- section 6: unified diffs ---------------- */

interface UOp { type: 'ctx' | 'old' | 'new'; text: string; }
interface UHunk { A: number; ops: UOp[]; backslashLast: boolean; }
interface USec {
  oldPath: string | null;
  newPath: string | null;
  createMode: boolean;
  delMode: boolean;
  hunks: UHunk[];
}

function parsePath(s: string): string {
  const tab = s.indexOf('\t');
  const p = tab >= 0 ? s.slice(0, tab) : s;
  return p.trim();
}
function stripAB(p: string): string {
  if (p.startsWith('a/')) return p.slice(2);
  if (p.startsWith('b/')) return p.slice(2);
  return p;
}

function readUHeader(lines: string[], i: number, n: number, sec: USec): { i: number; hunkStarted: boolean } {
  while (i < n) {
    const l = lines[i];
    if (l.startsWith('@@ ')) {
      return { i, hunkStarted: true };
    }
    if (l.startsWith('--- ')) {
      const nxt = lines[i + 1] ?? '';
      if (nxt.startsWith('+++ ')) {
        sec.oldPath = stripAB(parsePath(l.slice(4)));
        sec.newPath = stripAB(parsePath(nxt.slice(4)));
        i += 2;
        continue;
      }
      throw new Exit2(`error: parse ${i + 2}`);
    }
    if (l.startsWith('+++ ')) {
      i++;
      continue;
    }
    if (l.startsWith('rename from ')) {
      sec.oldPath = l.slice('rename from '.length).trim();
      i++;
      continue;
    }
    if (l.startsWith('rename to ')) {
      sec.newPath = l.slice('rename to '.length).trim();
      i++;
      continue;
    }
    if (l === 'new file mode') { sec.createMode = true; i++; continue; }
    if (l === 'deleted file mode') { sec.delMode = true; i++; continue; }
    i++; // index, modes, Index:, any other line ignored
  }
  return { i, hunkStarted: false };
}

function parseUHunk(lines: string[], i: number, n: number): { hunk: UHunk; newI: number } {
  const m = /^@@ -(\d+)(,(\d+))? \+(\d+)(,(\d+))? @@/.exec(lines[i]);
  if (!m) throw new Exit2(`error: parse ${i + 1}`);
  const A = parseInt(m[1]!, 10);
  const body: UOp[] = [];
  let j = i + 1;
  let lastWasContent = false;
  let backslashLast = false;
  while (j < n) {
    const l = lines[j];
    if (l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ '))) break;
    if (l.startsWith('\\')) {
      backslashLast = lastWasContent;
      j++;
      continue;
    }
    if (l.startsWith(' ')) { body.push({ type: 'ctx', text: l.slice(1) }); lastWasContent = true; j++; continue; }
    if (l.startsWith('-')) { body.push({ type: 'old', text: l.slice(1) }); lastWasContent = true; j++; continue; }
    if (l.startsWith('+')) { body.push({ type: 'new', text: l.slice(1) }); lastWasContent = true; j++; continue; }
    if (l === '') { body.push({ type: 'ctx', text: '' }); lastWasContent = true; j++; continue; }
    break;
  }
  // empty lines at the end of a body are not part of it
  while (body.length > 0 && body[body.length - 1]!.type === 'ctx' && body[body.length - 1]!.text === '') body.pop();
  return { hunk: { A, ops: body, backslashLast }, newI: j };
}

function unifiedEdits(text: string, lines: string[], strict: boolean, moves: { old: string; new: string }[]): Edit[] {
  const n = lines.length;
  const secs: USec[] = [];
  let i = 0;
  while (i < n) {
    const l = lines[i];
    if (l.startsWith('diff --git ')) {
      const rest = l.slice('diff --git '.length);
      const parts = rest.split(' ');
      if (parts.length < 2 || !parts[0]!.startsWith('a/') || !parts[1]!.startsWith('b/')) {
        throw new Exit2(`error: parse ${i + 1}`);
      }
      const sec: USec = { oldPath: stripAB(parts[0]!), newPath: stripAB(parts[1]!), createMode: false, delMode: false, hunks: [] };
      secs.push(sec);
      i++;
      const r = readUHeader(lines, i, n, sec);
      i = r.i;
      while (i < n && lines[i]!.startsWith('@@ ')) {
        const h = parseUHunk(lines, i, n);
        sec.hunks.push(h.hunk);
        i = h.newI;
      }
    } else if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const sec: USec = { oldPath: stripAB(parsePath(l.slice(4))), newPath: stripAB(parsePath(lines[i + 1]!.slice(4))), createMode: false, delMode: false, hunks: [] };
      secs.push(sec);
      i += 2;
      const r = readUHeader(lines, i, n, sec);
      i = r.i;
      while (i < n && lines[i]!.startsWith('@@ ')) {
        const h = parseUHunk(lines, i, n);
        sec.hunks.push(h.hunk);
        i = h.newI;
      }
    } else if (l.startsWith('@@ ') && secs.length === 0) {
      throw new Exit2(`error: parse ${i + 1}`);
    } else {
      i++;
    }
  }

  const edits: Edit[] = [];
  for (const sec of secs) {
    const oldNull = sec.oldPath === '/dev/null';
    const newNull = sec.newPath === '/dev/null';
    let kind: 'create' | 'delete' | 'move' | 'change';
    let target: string;
    let moveTarget: string | null = null;
    if (oldNull || sec.createMode) { kind = 'create'; target = sec.newPath!; }
    else if (newNull || sec.delMode) { kind = 'delete'; target = sec.oldPath!; }
    else if (sec.oldPath !== sec.newPath) { kind = 'move'; target = sec.oldPath!; moveTarget = sec.newPath!; }
    else { kind = 'change'; target = sec.oldPath!; }

    edits.push((tree) => {
      const paths = kind === 'move' ? [target!, moveTarget!] : [target!];
      for (const pp of paths) if (!safe(pp)) throw new Fail('unsafe', pp);
      if (kind === 'create') {
        if (tree.get(target!) !== null) throw new Fail('exists', target!);
        const plus: string[] = [];
        for (const h of sec.hunks) for (const op of h.ops) if (op.type === 'new') plus.push(op.text);
        const backslash = sec.hunks.length > 0 && sec.hunks[sec.hunks.length - 1]!.backslashLast;
        tree.now.set(target!, joinFile(plus, '\n', !backslash));
        return;
      }
      if (kind === 'delete') {
        const t = tree.get(target!);
        if (t === null) throw new Fail('missing', target!);
        tree.now.set(target!, null);
        return;
      }
      const before = tree.get(target!);
      if (before === null) throw new Fail('missing', target!);
      const rep = splitFile(before);
      let cur = [...rep.lines];
      let curFinal = rep.final;
      let d = 0;
      for (const h of sec.hunks) {
        const O = h.ops.filter((o) => o.type === 'ctx' || o.type === 'old').map((o) => o.text);
        const Nops = h.ops.filter((o) => o.type === 'ctx' || o.type === 'new');
        const added = Nops.filter((o) => o.type === 'new').map((o) => o.text);
        if (O.length === 0) {
          const insertAt = Math.min(h.A + d, cur.length);
          if (insertAt === cur.length) curFinal = h.backslashLast ? false : true;
          cur = [...cur.slice(0, insertAt), ...added, ...cur.slice(insertAt)];
          d += added.length;
        } else {
          const tier = findTier(cur, O, strict);
          if (tier === null) throw new Fail('no-match', target!);
          const occs = occurrences(cur, O, tier);
          const targetPos = h.A - 1 + d;
          let best = occs[0]!;
          let bestDist = Math.abs(best - targetPos);
          for (const o of occs) {
            const dist = Math.abs(o - targetPos);
            if (dist < bestDist) { best = o; bestDist = dist; }
          }
          const pos = best;
          const matchEnd = pos + O.length;
          if (matchEnd === cur.length) curFinal = h.backslashLast ? false : true;
          const F = leadWS(cur[pos]!);
          const P = leadWS(O[0]!);
          const result: string[] = [...cur.slice(0, pos)];
          let fileIdx = pos;
          for (const op of h.ops) {
            if (op.type === 'ctx') { result.push(cur[fileIdx]!); fileIdx++; }
            else if (op.type === 'old') { fileIdx++; }
            else { result.push(reindent(op.text, tier, F, P)); }
          }
          result.push(...cur.slice(fileIdx));
          cur = result;
          d += added.length - O.length;
        }
      }
      const writePath = moveTarget !== null ? moveTarget : target!;
      if (moveTarget !== null) {
        tree.now.set(target!, null);
        moves.push({ old: target!, new: moveTarget! });
      }
      tree.now.set(writePath, joinFile(cur, rep.br, curFinal));
    });
  }
  return edits;
}

/* ---------------- section 7: SEARCH/REPLACE blocks ---------------- */

function searchReplaceEdits(text: string, lines: string[], strict: boolean): Edit[] {
  const n = lines.length;
  const edits: Edit[] = [];
  let i = 0;
  let currentPath: string | null = null;
  let lastReplaceEnd = 0;
  while (i < n) {
    if (lines[i]!.trimEnd() === '<<<<<<< SEARCH') {
      let path: string | null = null;
      for (let k = i - 1; k >= lastReplaceEnd; k--) {
        const kl = lines[k];
        if (blank(kl)) continue;
        const trimmed = kl.trim();
        if (trimmed.startsWith('```')) continue;
        path = trimmed;
        break;
      }
      if (path === null) {
        path = currentPath;
        if (path === null) throw new Exit2(`error: parse ${i + 1}`);
      }
      let eq = -1;
      for (let j = i + 1; j < n; j++) { if (lines[j]!.trimEnd() === '=======') { eq = j; break; } }
      if (eq < 0) throw new Exit2(`error: parse ${i + 1}`);
      let rep = -1;
      for (let j = eq + 1; j < n; j++) { if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') { rep = j; break; } }
      if (rep < 0) throw new Exit2(`error: parse ${i + 1}`);
      const oldLines = lines.slice(i + 1, eq);
      const newLines = lines.slice(eq + 1, rep);
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (oldLines.length === 0) {
          if (tree.get(path) !== null) throw new Fail('exists', path);
          tree.now.set(path, joinFile(newLines, '\n', true));
          return;
        }
        const before = tree.get(path);
        if (before === null) throw new Fail('missing', path);
        const repF = splitFile(before);
        const tier = findTier(repF.lines, oldLines, strict);
        if (tier === null) throw new Fail('no-match', path);
        const occs = occurrences(repF.lines, oldLines, tier);
        if (occs.length !== 1) throw new Fail('ambiguous', path);
        const pos = occs[0]!;
        const F = leadWS(repF.lines[pos]!);
        const P = leadWS(oldLines[0]!);
        const newLines2 = newLines.map((l) => reindent(l, tier, F, P));
        const result = [...repF.lines.slice(0, pos), ...newLines2, ...repF.lines.slice(pos + oldLines.length)];
        tree.now.set(path, joinFile(result, repF.br, repF.final));
      });
      currentPath = path;
      lastReplaceEnd = rep;
      i = rep + 1;
    } else {
      i++;
    }
  }
  return edits;
}

/* ---------------- section 8: V4A patches ---------------- */

interface VOp { type: 'ctx' | 'old' | 'new'; text: string; }
interface VChunk { anchor: string | null; ops: VOp[]; eof: boolean; }

function collectV4aBody(lines: string[], i: number, n: number): { ops: VOp[]; newI: number; eof: boolean } {
  const ops: VOp[] = [];
  let eof = false;
  let j = i;
  while (j < n) {
    const cl = lines[j];
    if (cl === '*** End of File') { eof = true; j++; break; }
    if (cl.startsWith('@@ ')) break;
    if (cl === '*** End Patch') break;
    if (cl.startsWith('*** Add File: ') || cl.startsWith('*** Delete File: ') || cl.startsWith('*** Update File: ')) break;
    if (cl === '') { ops.push({ type: 'ctx', text: '' }); j++; continue; }
    if (cl.startsWith(' ')) { ops.push({ type: 'ctx', text: cl.slice(1) }); j++; continue; }
    if (cl.startsWith('-')) { ops.push({ type: 'old', text: cl.slice(1) }); j++; continue; }
    if (cl.startsWith('+')) { ops.push({ type: 'new', text: cl.slice(1) }); j++; continue; }
    throw new Exit2(`error: parse ${j + 1}`);
  }
  // empty lines at the end of a body are not part of it
  while (ops.length > 0 && ops[ops.length - 1]!.type === 'ctx' && ops[ops.length - 1]!.text === '') ops.pop();
  return { ops, newI: j, eof };
}

function v4aEdits(text: string, lines: string[], strict: boolean, moves: { old: string; new: string }[]): Edit[] {
  const n = lines.length;
  let i = 0;
  while (i < n && blank(lines[i]!)) i++;
  if (i >= n || lines[i]!.trim() !== '*** Begin Patch') {
    throw new Exit2(i >= n ? 'error: parse 1' : `error: parse ${i + 1}`);
  }
  i++;
  let last = n - 1;
  while (last >= 0 && blank(lines[last]!)) last--;
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') {
    throw new Exit2(`error: parse ${n + 1}`);
  }

  const edits: Edit[] = [];
  while (i < n) {
    const l = lines[i]!;
    if (blank(l)) { i++; continue; }
    if (l === '*** End Patch') { i++; break; }
    if (l.startsWith('*** Add File: ')) {
      const path = l.slice('*** Add File: '.length).trim();
      i++;
      const secLines: string[] = [];
      while (i < n) {
        const cl = lines[i]!;
        if (cl === '*** End Patch') break;
        if (cl.startsWith('*** Add File: ') || cl.startsWith('*** Delete File: ') || cl.startsWith('*** Update File: ')) break;
        if (cl === '') { secLines.push(''); i++; continue; }
        if (cl.startsWith('+')) { secLines.push(cl.slice(1)); i++; continue; }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) !== null) throw new Fail('exists', path);
        tree.now.set(path, joinFile(secLines, '\n', true));
      });
    } else if (l.startsWith('*** Delete File: ')) {
      const path = l.slice('*** Delete File: '.length).trim();
      i++;
      while (i < n) {
        const cl = lines[i]!;
        if (cl === '*** End Patch') break;
        if (cl.startsWith('*** Add File: ') || cl.startsWith('*** Delete File: ') || cl.startsWith('*** Update File: ')) break;
        if (blank(cl)) { i++; continue; }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        const t = tree.get(path);
        if (t === null) throw new Fail('missing', path);
        tree.now.set(path, null);
      });
    } else if (l.startsWith('*** Update File: ')) {
      const updateLine = i + 1;
      const path = l.slice('*** Update File: '.length).trim();
      i++;
      let movePath: string | null = null;
      if (i < n && lines[i]!.startsWith('*** Move to: ')) {
        movePath = lines[i]!.slice('*** Move to: '.length).trim();
        i++;
      }
      const chunks: VChunk[] = [];
      let eofSeen = false;
      while (i < n && !eofSeen) {
        const cl = lines[i]!;
        if (cl === '*** End Patch') break;
        if (cl.startsWith('*** Add File: ') || cl.startsWith('*** Delete File: ') || cl.startsWith('*** Update File: ')) break;
        if (cl.startsWith('@@ ')) {
          const anchor = cl.slice(3).trim();
          i++;
          const b = collectV4aBody(lines, i, n);
          i = b.newI;
          if (b.eof) eofSeen = true;
          chunks.push({ anchor, ops: b.ops, eof: b.eof });
        } else {
          const b = collectV4aBody(lines, i, n);
          i = b.newI;
          if (b.eof) eofSeen = true;
          chunks.push({ anchor: null, ops: b.ops, eof: b.eof });
        }
      }
      if (chunks.length === 0 && movePath === null) {
        throw new Exit2(`error: parse ${updateLine}`);
      }
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (movePath !== null && !safe(movePath)) throw new Fail('unsafe', movePath);
        const before = tree.get(path);
        if (before === null) throw new Fail('missing', path);
        const rep = splitFile(before);
        let cur = [...rep.lines];
        let cursor = 0;
        for (const ch of chunks) {
          if (ch.anchor !== null) {
            let found = -1;
            for (const tier of [0, 1, 2]) {
              for (let pos = cursor; pos < cur.length; pos++) {
                if (equalNorm(cur[pos]!, ch.anchor, tier)) { found = pos; break; }
              }
              if (found >= 0) break;
            }
            if (found < 0) throw new Fail('no-match', path);
            cursor = found + 1;
          }
          const O = ch.ops.filter((o) => o.type === 'ctx' || o.type === 'old').map((o) => o.text);
          const Nops = ch.ops.filter((o) => o.type === 'ctx' || o.type === 'new');
          if (O.length === 0) {
            const insertAt = ch.eof ? cur.length : cursor;
            const added = Nops.filter((o) => o.type === 'new').map((o) => o.text);
            cur = [...cur.slice(0, insertAt), ...added, ...cur.slice(insertAt)];
            cursor = insertAt + added.length;
          } else {
            let tier: number | null = null;
            let pos: number | null = null;
            for (const t of [0, 1, 2]) {
              const occs = occurrences(cur, O, t).filter((p) => p >= cursor);
              let cand = occs;
              if (ch.eof) cand = cand.filter((p) => p + O.length === cur.length);
              if (cand.length > 0) { tier = t; pos = cand[0]!; break; }
            }
            if (pos === null) throw new Fail('no-match', path);
            const F = leadWS(cur[pos]!);
            const P = leadWS(O[0]!);
            const result: string[] = [...cur.slice(0, pos)];
            let fileIdx = pos;
            for (const op of ch.ops) {
              if (op.type === 'ctx') { result.push(cur[fileIdx]!); fileIdx++; }
              else if (op.type === 'old') { fileIdx++; }
              else { result.push(reindent(op.text, tier!, F, P)); }
            }
            result.push(...cur.slice(fileIdx));
            cur = result;
            cursor = pos + Nops.length;
          }
        }
        const writePath = movePath !== null ? movePath : path;
        if (movePath !== null) {
          tree.now.set(path, null);
          moves.push({ old: path, new: movePath });
        }
        tree.now.set(writePath, joinFile(cur, rep.br, rep.final));
      });
    } else {
      throw new Exit2(`error: parse ${i + 1}`);
    }
  }
  return edits;
}

/* ---------------- command line, apply, output (sections 1, 2, 10) ---------------- */

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  const moves: { old: string; new: string }[] = [];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(text, lines, strict, moves);
    else if (kind === 'search-replace') edits = searchReplaceEdits(text, lines, strict);
    else edits = v4aEdits(text, lines, strict, moves);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const moveOld = new Set(moves.map((m) => m.old));
  const moveNew = new Set(moves.map((m) => m.new));
  const cmp = (a: string, b: string) => Buffer.compare(Buffer.from(a), Buffer.from(b));
  for (const p of [...tree.now.keys()].sort(cmp)) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (check) continue;
    if (now === null) rmSync(p, { force: true });
    else {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  const rows: { key: string; line: string }[] = [];
  for (const p of [...tree.now.keys()].sort(cmp)) {
    if (moveOld.has(p) || moveNew.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  for (const m of moves) rows.push({ key: m.new, line: `R ${m.old} -> ${m.new}` });
  rows.sort((a, b) => cmp(a.key, b.key));
  return { code: 0, out: [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
