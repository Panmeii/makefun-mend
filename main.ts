// mend — one patch tool for every AI edit format (make.fun hidden-spec-cli-01-run-20261122).
//
// Implements SPEC.md in full: unified diffs, SEARCH/REPLACE blocks, V4A patches and JSON
// edits; three-tier line matching (exact / trailing-whitespace / indentation-insensitive,
// tier 0 only under --strict); atomic all-or-nothing writes; --check dry runs.
// Node 22+, standard library only, run as `node main.ts [options] [PATCH]`.
//
// The last lines hand a trial over to runner.ts when MAKEFUN_ENV_URL is set, as the kit
// requires; without it this file is the plain CLI.

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

/** Move pairs (old -> new) registered by move edits that succeeded, for the `R` output line. */
const movePairs: [string, string][] = [];

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

/* ------------------------------------------------------------------ */
/* File lines (SPEC.md section 3)                                      */
/* ------------------------------------------------------------------ */

interface FileLines {
  lines: string[];
  br: string; // '\r\n' or '\n'
  final: boolean; // ends with a line break
}

function splitFile(text: string): FileLines {
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  if (text === '') return { lines: [], br, final: false };
  const lines = text.split(br);
  const final = text.endsWith(br);
  if (final) lines.pop();
  return { lines, br, final };
}

function joinFile(lines: string[], br: string, final: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (final ? br : '');
}

/** A created file: LF breaks, ending with a break unless the format says otherwise. */
function joinCreated(lines: string[], finalBreak: boolean): string {
  if (lines.length === 0) return '';
  return lines.join('\n') + (finalBreak ? '\n' : '');
}

/* ------------------------------------------------------------------ */
/* Three-tier matching (SPEC.md section 5)                             */
/* ------------------------------------------------------------------ */

interface BodyEntry {
  kind: ' ' | '-' | '+'; // context, old-only, new-only
  text: string;
  noEol: boolean; // a `\` line followed this entry
}

interface BuiltON {
  old: string[];
  entries: BodyEntry[]; // every body entry, in order
}

function buildON(entries: BodyEntry[]): BuiltON {
  return { old: entries.filter((e) => e.kind !== '+').map((e) => e.text), entries };
}

const trimTrail = (s: string): string => s.replace(/[ \t]+$/, '');
const trimBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWs = (s: string): string => /^[ \t]*/.exec(s)![0]!;

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimTrail(a) === trimTrail(b);
  return trimBoth(a) === trimBoth(b);
}

interface Found {
  tier: number;
  positions: number[];
}

/** Occurrences of O in fileLines at the first tier that has any, optionally restricted. */
function findOccurrences(
  fileLines: string[],
  old: string[],
  strict: boolean,
  filter?: (pos: number) => boolean,
): Found | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const positions: number[] = [];
    for (let i = 0; i + old.length <= fileLines.length; i += 1) {
      if (filter !== undefined && !filter(i)) continue;
      let ok = true;
      for (let k = 0; k < old.length; k += 1) {
        if (!lineEq(fileLines[i + k]!, old[k]!, tier)) {
          ok = false;
          break;
        }
      }
      if (ok) positions.push(i);
    }
    if (positions.length > 0) return { tier, positions };
  }
  return null;
}

/**
 * The lines that replace the matched block: context entries become the file's own matched
 * line; at tier 2 every other new line is re-indented from O's first line's prefix P to the
 * file's first matched line's prefix F.
 */
function renderNew(fileLines: string[], pos: number, built: BuiltON, tier: number): string[] {
  const out: string[] = [];
  let oIdx = 0;
  const F = tier === 2 && built.old.length > 0 ? leadWs(fileLines[pos] ?? '') : '';
  const P = tier === 2 && built.old.length > 0 ? leadWs(built.old[0]!) : '';
  for (const e of built.entries) {
    if (e.kind === ' ') {
      out.push(fileLines[pos + oIdx]!);
      oIdx += 1;
    } else if (e.kind === '-') {
      oIdx += 1;
    } else if (tier === 2 && e.text.trim() !== '' && e.text.startsWith(P)) {
      out.push(F + e.text.slice(P.length));
    } else {
      out.push(e.text);
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Format detection (SPEC.md section 4)                                */
/* ------------------------------------------------------------------ */

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

/* ------------------------------------------------------------------ */
/* Unified diffs (SPEC.md section 6)                                   */
/* ------------------------------------------------------------------ */

interface Hunk {
  a: number; // the A of @@ -A[,B] +C[,D] @@
  entries: BodyEntry[];
}

interface Section {
  diffOld: string | null;
  diffNew: string | null;
  pairOld: string | null | undefined; // undefined: no ---/+++ pair; null: /dev/null
  pairNew: string | null | undefined;
  renameFrom: string | null;
  renameTo: string | null;
  newFile: boolean;
  deletedFile: boolean;
  hunks: Hunk[];
}

function headerPath(raw: string): string | null {
  const t = raw.split('\t')[0]!.trim();
  if (t === '/dev/null') return null;
  return t.startsWith('a/') || t.startsWith('b/') ? t.slice(2) : t;
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  const newSection = (): Section => {
    const s: Section = {
      diffOld: null,
      diffNew: null,
      pairOld: undefined,
      pairNew: undefined,
      renameFrom: null,
      renameTo: null,
      newFile: false,
      deletedFile: false,
      hunks: [],
    };
    sections.push(s);
    return s;
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const ln = i + 1;
    if (line.startsWith('diff --git ')) {
      const rest = line.slice('diff --git '.length);
      const sep = rest.startsWith('a/') ? rest.indexOf(' b/', 2) : -1;
      if (sep < 0) throw new Exit2(`error: parse ${ln}`);
      cur = newSection();
      cur.diffOld = rest.slice(2, sep);
      cur.diffNew = rest.slice(sep + 3);
      i += 1;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${ln}`);
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@( .*)?$/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${ln}`);
      const entries: BodyEntry[] = [];
      let j = i + 1;
      while (j < lines.length) {
        const b = lines[j]!;
        if (b.startsWith('diff --git ')) break;
        if (b.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
        if (b === '') {
          entries.push({ kind: ' ', text: '', noEol: false });
          j += 1;
        } else if (b[0] === ' ' || b[0] === '-' || b[0] === '+') {
          entries.push({ kind: b[0] as BodyEntry['kind'], text: b.slice(1), noEol: false });
          j += 1;
        } else if (b[0] === '\\') {
          const prev = entries[entries.length - 1];
          if (prev !== undefined) prev.noEol = true;
          j += 1;
        } else break;
      }
      // Empty lines at the end of a body are not part of it.
      while (entries.length > 0) {
        const last = entries[entries.length - 1]!;
        if (last.kind === ' ' && last.text === '' && !last.noEol) entries.pop();
        else break;
      }
      cur.hunks.push({ a: Number(m[1]), entries });
      i = j;
      continue;
    }
    if (line.startsWith('--- ')) {
      const next = lines[i + 1] ?? '';
      if (next.startsWith('+++ ')) {
        if (cur !== null && cur.hunks.length === 0 && cur.pairOld === undefined) {
          cur.pairOld = headerPath(line.slice(4));
          cur.pairNew = headerPath(next.slice(4));
        } else {
          cur = newSection();
          cur.pairOld = headerPath(line.slice(4));
          cur.pairNew = headerPath(next.slice(4));
        }
        i += 2;
        continue;
      }
      if (cur !== null && cur.hunks.length === 0) throw new Exit2(`error: parse ${ln + 1}`);
      i += 1;
      continue;
    }
    if (cur !== null && cur.hunks.length === 0) {
      if (line.startsWith('rename from ')) cur.renameFrom = line.slice('rename from '.length).trim();
      else if (line.startsWith('rename to ')) cur.renameTo = line.slice('rename to '.length).trim();
      else if (line.startsWith('new file mode')) cur.newFile = true;
      else if (line.startsWith('deleted file mode')) cur.deletedFile = true;
      // index / mode / similarity / Index: / anything else: ignored.
    }
    i += 1;
  }

  return sections.map((s) => unifiedEdit(s, strict));
}

function unifiedEdit(s: Section, strict: boolean): Edit {
  // Resolve the section's paths: ---/+++ pair, then rename lines, then the diff --git line.
  let oldPath: string | null;
  let newPath: string | null;
  if (s.pairOld !== undefined) {
    oldPath = s.pairOld;
    newPath = s.pairNew!;
  } else if (s.renameFrom !== null || s.renameTo !== null) {
    oldPath = s.renameFrom;
    newPath = s.renameTo;
  } else {
    oldPath = s.diffOld;
    newPath = s.diffNew;
  }
  const isCreate = oldPath === null || s.newFile;
  const isDelete = !isCreate && (newPath === null || s.deletedFile);

  return (tree) => {
    if (isCreate) {
      const p = newPath ?? oldPath;
      if (p === null) throw new Fail('missing', '');
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const plus: BodyEntry[] = [];
      for (const h of s.hunks) for (const e of h.entries) if (e.kind === '+') plus.push(e);
      const lastPlus = plus[plus.length - 1];
      tree.now.set(p, joinCreated(plus.map((e) => e.text), lastPlus === undefined ? false : !lastPlus.noEol && plus.length > 0));
      return;
    }
    if (isDelete) {
      const p = oldPath!;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    const from = oldPath!;
    const to = newPath ?? from;
    if (!safe(from)) throw new Fail('unsafe', from);
    if (to !== from && !safe(to)) throw new Fail('unsafe', to);
    const before = tree.get(from);
    if (before === null) throw new Fail('missing', from);
    if (to !== from && tree.get(to) !== null) throw new Fail('exists', to);
    const f = splitFile(before);
    const lines = [...f.lines];
    let final = f.final;
    let d = 0;
    for (const h of s.hunks) {
      const built = buildON(h.entries);
      const O = built.old;
      const nEntries = h.entries.filter((e) => e.kind !== '-');
      if (O.length === 0) {
        const pos = Math.min(h.a + d, lines.length);
        const atEnd = pos === lines.length;
        const add = h.entries.filter((e) => e.kind === '+').map((e) => e.text);
        lines.splice(pos, 0, ...add);
        if (atEnd && add.length > 0) {
          const last = h.entries[h.entries.length - 1]!;
          final = !last.noEol;
        }
        d += add.length;
        continue;
      }
      const found = findOccurrences(lines, O, strict);
      if (found === null) throw new Fail('no-match', from);
      const target = h.a - 1 + d;
      let pos = found.positions[0]!;
      for (const p of found.positions) {
        if (Math.abs(p - target) < Math.abs(pos - target)) pos = p;
      }
      const replacement = renderNew(lines, pos, built, found.tier);
      const runsToEnd = pos + O.length === lines.length;
      lines.splice(pos, O.length, ...replacement);
      if (runsToEnd) {
        const lastN = nEntries[nEntries.length - 1];
        if (lastN !== undefined) final = !lastN.noEol;
      }
      d += replacement.length - O.length;
    }
    const text = joinFile(lines, f.br, final);
    if (to !== from) {
      tree.now.set(from, null);
      tree.now.set(to, text);
      movePairs.push([from, to]);
    } else {
      tree.now.set(to, text);
    }
  };
}

/* ------------------------------------------------------------------ */
/* SEARCH/REPLACE blocks (SPEC.md section 7)                           */
/* ------------------------------------------------------------------ */

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  interface Block {
    path: string;
    oldLines: string[];
    newLines: string[];
  }
  const blocks: Block[] = [];
  let prevEnd = -1; // index of the previous block's >>>>>>> REPLACE line
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchLn = i + 1;
    // The path: nearest line before SEARCH, after the previous block's end, that is not
    // blank and (trimmed) does not start with three backticks.
    let path: string | null = null;
    for (let k = i - 1; k > prevEnd; k -= 1) {
      const t = lines[k]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${searchLn}`);
    let eq = -1;
    for (let k = i + 1; k < lines.length; k += 1) {
      if (lines[k]!.trimEnd() === '=======') {
        eq = k;
        break;
      }
    }
    let rep = -1;
    if (eq >= 0) {
      for (let k = eq + 1; k < lines.length; k += 1) {
        if (lines[k]!.trimEnd() === '>>>>>>> REPLACE') {
          rep = k;
          break;
        }
      }
    }
    if (eq < 0 || rep < 0) throw new Exit2(`error: parse ${searchLn}`);
    blocks.push({ path, oldLines: lines.slice(i + 1, eq), newLines: lines.slice(eq + 1, rep) });
    prevPath = path;
    prevEnd = rep;
    i = rep + 1;
  }

  return blocks.map((b) => (tree: Tree) => {
    if (!safe(b.path)) throw new Fail('unsafe', b.path);
    if (b.oldLines.length === 0) {
      if (tree.get(b.path) !== null) throw new Fail('exists', b.path);
      tree.now.set(b.path, joinCreated(b.newLines, b.newLines.length > 0));
      return;
    }
    const before = tree.get(b.path);
    if (before === null) throw new Fail('missing', b.path);
    const f = splitFile(before);
    const found = findOccurrences(f.lines, b.oldLines, strict);
    if (found === null) throw new Fail('no-match', b.path);
    if (found.positions.length > 1) throw new Fail('ambiguous', b.path);
    const pos = found.positions[0]!;
    const built: BuiltON = { old: b.oldLines, entries: b.newLines.map((t) => ({ kind: '+' as const, text: t, noEol: false })) };
    const replacement = renderNew(f.lines, pos, built, found.tier);
    const lines = [...f.lines];
    lines.splice(pos, b.oldLines.length, ...replacement);
    tree.now.set(b.path, joinFile(lines, f.br, f.final));
  });
}

/* ------------------------------------------------------------------ */
/* V4A patches (SPEC.md section 8)                                     */
/* ------------------------------------------------------------------ */

function parseV4A(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k -= 1) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);

  type SecKind = 'add' | 'delete' | 'update';
  interface Chunk {
    anchor: string | null;
    eof: boolean;
    entries: BodyEntry[];
  }
  interface VSec {
    kind: SecKind;
    path: string;
    ln: number;
    addLines: string[];
    moveTo: string | null;
    chunks: Chunk[];
  }
  const isSectionStart = (l: string): SecKind | null => {
    if (l.startsWith('*** Add File: ') || l === '*** Add File:') return 'add';
    if (l.startsWith('*** Delete File: ') || l === '*** Delete File:') return 'delete';
    if (l.startsWith('*** Update File: ') || l === '*** Update File:') return 'update';
    return null;
  };
  const secPath = (l: string, kind: SecKind): string => {
    const prefix = kind === 'add' ? '*** Add File:' : kind === 'delete' ? '*** Delete File:' : '*** Update File:';
    return l.slice(prefix.length).trim();
  };

  const secs: VSec[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i += 1;
      continue;
    }
    const kind = isSectionStart(line);
    if (kind === null) throw new Exit2(`error: parse ${i + 1}`);
    const sec: VSec = { kind, path: secPath(line, kind), ln: i + 1, addLines: [], moveTo: null, chunks: [] };
    secs.push(sec);
    i += 1;
    if (kind === 'delete') continue; // a Delete File section has no lines
    // Collect this section's raw segment, up to the next section or *** End Patch.
    const segStart = i;
    let segEnd = i;
    while (segEnd < last && isSectionStart(lines[segEnd]!) === null) segEnd += 1;
    // Blank lines at the end of a section are not part of it.
    let segTrim = segEnd;
    while (segTrim > segStart && blank(lines[segTrim - 1]!)) segTrim -= 1;
    if (kind === 'add') {
      for (let k = segStart; k < segTrim; k += 1) {
        const l = lines[k]!;
        if (l.startsWith('+')) sec.addLines.push(l.slice(1));
        else if (l === '') sec.addLines.push('');
        else throw new Exit2(`error: parse ${k + 1}`);
      }
    } else {
      // update
      let k = segStart;
      if (k < segTrim && (lines[k]!.startsWith('*** Move to: ') || lines[k]! === '*** Move to:')) {
        sec.moveTo = lines[k]!.slice('*** Move to:'.length).trim();
        k += 1;
      }
      let chunk: Chunk | null = null;
      for (; k < segTrim; k += 1) {
        const l = lines[k]!;
        if (l.startsWith('@@')) {
          const anchor = l.slice(2).trim();
          chunk = { anchor: anchor === '' ? null : anchor, eof: false, entries: [] };
          sec.chunks.push(chunk);
        } else if (l.trim() === '*** End of File') {
          if (chunk === null) {
            chunk = { anchor: null, eof: true, entries: [] };
            sec.chunks.push(chunk);
          } else chunk.eof = true;
          chunk = null;
        } else if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+') {
          if (chunk === null) {
            chunk = { anchor: null, eof: false, entries: [] };
            sec.chunks.push(chunk);
          }
          if (l === '') chunk.entries.push({ kind: ' ', text: '', noEol: false });
          else chunk.entries.push({ kind: l[0] as BodyEntry['kind'], text: l.slice(1), noEol: false });
        } else {
          throw new Exit2(`error: parse ${k + 1}`);
        }
      }
      if (sec.chunks.length === 0 && sec.moveTo === null) throw new Exit2(`error: parse ${sec.ln}`);
    }
    i = segEnd;
  }

  return secs.map((sec) => (tree: Tree) => {
    if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
    if (sec.kind === 'add') {
      if (tree.get(sec.path) !== null) throw new Fail('exists', sec.path);
      tree.now.set(sec.path, joinCreated(sec.addLines, sec.addLines.length > 0));
      return;
    }
    if (sec.kind === 'delete') {
      if (tree.get(sec.path) === null) throw new Fail('missing', sec.path);
      tree.now.set(sec.path, null);
      return;
    }
    // update
    if (sec.moveTo !== null && !safe(sec.moveTo)) throw new Fail('unsafe', sec.moveTo);
    const before = tree.get(sec.path);
    if (before === null) throw new Fail('missing', sec.path);
    if (sec.moveTo !== null && tree.get(sec.moveTo) !== null) throw new Fail('exists', sec.moveTo);
    const f = splitFile(before);
    const fileLines = [...f.lines];
    let cursor = 0;
    for (const chunk of sec.chunks) {
      if (chunk.anchor !== null) {
        const tiers = strict ? [0] : [0, 1, 2];
        let at = -1;
        for (const tier of tiers) {
          for (let k = cursor; k < fileLines.length; k += 1) {
            if (lineEq(fileLines[k]!, chunk.anchor, tier)) {
              at = k;
              break;
            }
          }
          if (at >= 0) break;
        }
        if (at < 0) throw new Fail('no-match', sec.path);
        cursor = at + 1;
      }
      const built = buildON(chunk.entries);
      const O = built.old;
      if (O.length === 0) {
        const add = chunk.entries.filter((e) => e.kind === '+').map((e) => e.text);
        const pos = chunk.eof ? fileLines.length : Math.min(cursor, fileLines.length);
        fileLines.splice(pos, 0, ...add);
        cursor = pos + add.length;
        continue;
      }
      const found = findOccurrences(fileLines, O, strict, (p) => p >= cursor && (!chunk.eof || p + O.length === fileLines.length));
      if (found === null) throw new Fail('no-match', sec.path);
      const pos = found.positions[0]!;
      const replacement = renderNew(fileLines, pos, built, found.tier);
      fileLines.splice(pos, O.length, ...replacement);
      cursor = pos + replacement.length;
    }
    const text = joinFile(fileLines, f.br, f.final);
    if (sec.moveTo !== null) {
      tree.now.set(sec.path, null);
      tree.now.set(sec.moveTo, text);
      movePairs.push([sec.path, sec.moveTo]);
    } else {
      tree.now.set(sec.path, text);
    }
  });
}

/* ------------------------------------------------------------------ */
/* JSON edits (SPEC.md section 9)                                      */
/* ------------------------------------------------------------------ */

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
      const f = splitFile(before);
      if (line < 0 || line > f.lines.length) throw new Fail('no-match', p);
      const lines = [...f.lines];
      lines.splice(line, 0, ...add);
      tree.now.set(p, joinFile(lines, f.br, f.final));
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

/* ------------------------------------------------------------------ */
/* Invocation, output, atomicity (SPEC.md sections 1, 2 and 10)        */
/* ------------------------------------------------------------------ */

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
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines, strict);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
    else edits = parseV4A(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  movePairs.length = 0;
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const pairsBefore = movePairs.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      movePairs.length = pairsBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };

  interface Row {
    key: string;
    text: string;
  }
  const rows: Row[] = [];
  const consumed = new Set<string>();
  for (const [o, n] of movePairs) {
    if (tree.original(o) !== null && tree.now.get(o) === null && tree.original(n) === null && tree.now.get(n) !== null && tree.now.has(o) && tree.now.has(n)) {
      rows.push({ key: n, text: `R ${o} -> ${n}` });
      consumed.add(o);
      consumed.add(n);
    }
  }
  for (const p of tree.now.keys()) {
    if (consumed.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const p of tree.now.keys()) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p) === '' ? '.' : dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.text), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
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
