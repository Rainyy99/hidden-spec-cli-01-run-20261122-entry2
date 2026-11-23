// mend — applies an edit an AI model wrote to a tree of text files.
// SPEC.md v1 (hidden-spec-cli-01-run-20261122). Node 22, standard library only.
// Written from SPEC.md alone, in this session. The kit's runner.ts (beside this
// file) is the harness runner; it is not authored here.

import * as fs from 'node:fs';

// ---------------------------------------------------------------- utilities

// Split text into patch lines (SPEC section 3): split at \n, remove one trailing
// \r from each line, drop the empty piece after a final \n.
function splitPatchLines(text: string): string[] {
  const parts = text.split('\n');
  const lines = parts.map((p) => (p.endsWith('\r') ? p.slice(0, -1) : p));
  if (text.endsWith('\n')) lines.pop();
  return lines;
}

function isBlank(s: string): boolean {
  return s.trim() === '';
}

// Remove trailing spaces/tabs (marker matching).
function rstrip(s: string): string {
  return s.replace(/[ \t]+$/, '');
}

function isSafePath(p: string): boolean {
  if (p === '') return false;
  if (p.startsWith('/')) return false;
  if (p.includes('\\')) return false;
  const segs = p.split('/');
  for (const s of segs) {
    if (s === '' || s === '.' || s === '..') return false;
  }
  return true;
}

// Compare two paths by their UTF-8 bytes.
function compareBytes(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

// ---------------------------------------------------------------- file model

interface FileState {
  exists: boolean;
  lines: string[];
  lineBreak: '\n' | '\r\n';
  endsWithBreak: boolean;
}

function parseFileText(text: string): { lines: string[]; lineBreak: '\n' | '\r\n'; endsWithBreak: boolean } {
  if (text === '') return { lines: [], lineBreak: '\n', endsWithBreak: false };
  const idx = text.indexOf('\n');
  let lineBreak: '\n' | '\r\n' = '\n';
  if (idx > 0 && text[idx - 1] === '\r') lineBreak = '\r\n';
  const parts = text.split(lineBreak);
  let endsWithBreak = false;
  if (text.endsWith(lineBreak)) {
    endsWithBreak = true;
    parts.pop();
  }
  return { lines: parts, lineBreak, endsWithBreak };
}

function serializeFile(f: FileState): string {
  if (!f.exists) return '';
  if (f.lines.length === 0) return '';
  return f.lines.join(f.lineBreak) + (f.endsWithBreak ? f.lineBreak : '');
}

function makeFileState(text: string): FileState {
  const p = parseFileText(text);
  return { exists: true, lines: p.lines, lineBreak: p.lineBreak, endsWithBreak: p.endsWithBreak };
}

function absentFile(): FileState {
  return { exists: false, lines: [], lineBreak: '\n', endsWithBreak: false };
}

// ---------------------------------------------------------------- matching (SPEC section 5)

function stripTrailing(s: string): string {
  return s.replace(/[ \t]+$/, '');
}

function stripBoth(s: string): string {
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

function leadingWs(s: string): string {
  const m = s.match(/^[ \t]*/);
  return m ? m[0] : '';
}

function lineMatchesAtTier(fileLine: string, oLine: string, tier: number): boolean {
  if (tier === 0) return fileLine === oLine;
  if (tier === 1) return stripTrailing(fileLine) === stripTrailing(oLine);
  return stripBoth(fileLine) === stripBoth(oLine);
}

// All start positions where O occurs in fileLines at the given tier.
function findOccurrences(fileLines: string[], oLines: string[], tier: number): number[] {
  const res: number[] = [];
  const n = oLines.length;
  if (n === 0) return res;
  for (let i = 0; i + n <= fileLines.length; i++) {
    let ok = true;
    for (let k = 0; k < n; k++) {
      if (!lineMatchesAtTier(fileLines[i + k], oLines[k], tier)) {
        ok = false;
        break;
      }
    }
    if (ok) res.push(i);
  }
  return res;
}

// First tier (0, then 1, then 2; only 0 when strict) at which O occurs at least
// once at a position >= fromPos, and those occurrences.
function findFirstTierOccurrences(
  fileLines: string[],
  oLines: string[],
  fromPos: number,
  strict: boolean,
): { tier: number; occ: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const occ = findOccurrences(fileLines, oLines, tier).filter((p) => p >= fromPos);
    if (occ.length > 0) return { tier, occ };
  }
  return null;
}

interface NEntry {
  text: string;
  isContext: boolean;
  oPos: number; // index into O of the corresponding context line, or -1
}

// Build the replacement lines for N. Context lines are written as the file's own
// matched lines; at tier 2 every other line is re-indented (SPEC section 5).
function buildReplacement(
  nEntries: NEntry[],
  fileLines: string[],
  matchPos: number,
  oLines: string[],
  tier: number,
): string[] {
  const out: string[] = [];
  const F = leadingWs(fileLines[matchPos]);
  const P = leadingWs(oLines[0]);
  for (const e of nEntries) {
    if (e.isContext) {
      out.push(fileLines[matchPos + e.oPos]);
    } else {
      let t = e.text;
      if (tier === 2) {
        if (t !== '' && t.trim() !== '' && t.startsWith(P)) {
          t = F + t.slice(P.length);
        }
      }
      out.push(t);
    }
  }
  return out;
}

// ---------------------------------------------------------------- tree

class Tree {
  private files = new Map<string, FileState>();
  private originals = new Map<string, Buffer | null>();
  moves: { old: string; npath: string }[] = [];

  load(p: string): FileState {
    const cached = this.files.get(p);
    if (cached) return cached;
    let buf: Buffer | null = null;
    try {
      buf = fs.readFileSync(p);
    } catch {
      buf = null;
    }
    let f: FileState;
    if (buf === null) {
      f = absentFile();
      this.originals.set(p, null);
    } else {
      f = makeFileState(buf.toString('utf8'));
      this.originals.set(p, buf);
    }
    this.files.set(p, f);
    return f;
  }

  set(p: string, f: FileState): void {
    this.files.set(p, f);
  }

  remove(p: string): void {
    this.files.set(p, absentFile());
  }

  original(p: string): Buffer | null {
    if (!this.originals.has(p)) this.load(p);
    const v = this.originals.get(p);
    return v === undefined ? null : v;
  }

  currentBytes(p: string): Buffer | null {
    const f = this.files.get(p);
    if (!f || !f.exists) return null;
    return Buffer.from(serializeFile(f), 'utf8');
  }

  touchedPaths(): string[] {
    return [...this.originals.keys()];
  }
}

type EditResult = { ok: true } | { ok: false; code: string; path: string };

interface Edit {
  // Real paths this edit names, in order (for the safety check, before anything else).
  paths: string[];
  apply(tree: Tree): EditResult;
}

function fail(code: string, path: string): EditResult {
  return { ok: false, code, path };
}

function checkPathsSafe(paths: string[]): EditResult | null {
  for (const p of paths) {
    if (!isSafePath(p)) return fail('unsafe', p);
  }
  return null;
}

// ---------------------------------------------------------------- unified (SPEC section 6)

class ParseError extends Error {
  line: number;
  constructor(line: number) {
    super('parse ' + line);
    this.line = line;
  }
}

interface HunkBodyEntry {
  kind: 'context' | 'old' | 'new' | 'backslash';
  text: string;
}

interface UnifiedHunk {
  a: number;
  body: HunkBodyEntry[];
}

interface UnifiedSection {
  oldPath: string;
  newPath: string;
  hasDashPair: boolean;
  isNewFile: boolean;
  isDeletedFile: boolean;
  hunks: UnifiedHunk[];
}

function parseDiffGit(line: string): { x: string; y: string } | null {
  const m = line.match(/^diff --git a\/(.+) b\/(.+)$/);
  if (!m) return null;
  return { x: m[1], y: m[2] };
}

function parseDashPath(line: string): string {
  let t = line.slice(4);
  const tab = t.indexOf('\t');
  if (tab >= 0) t = t.slice(0, tab);
  t = t.trim();
  if (t.startsWith('a/')) t = t.slice(2);
  else if (t.startsWith('b/')) t = t.slice(2);
  return t;
}

function parseHunkHeader(line: string): number | null {
  const m = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
  if (!m) return null;
  return parseInt(m[1], 10);
}

function parseUnified(lines: string[]): UnifiedSection[] {
  const sections: UnifiedSection[] = [];
  let section: UnifiedSection | null = null;
  let state: 'outside' | 'header' | 'between' | 'body' = 'outside';
  let currentHunk: UnifiedHunk | null = null;

  const startSection = (oldPath: string, newPath: string, hasDashPair: boolean) => {
    section = { oldPath, newPath, hasDashPair, isNewFile: false, isDeletedFile: false, hunks: [] };
    sections.push(section);
    state = 'header';
    currentHunk = null;
  };

  const finishBody = () => {
    if (currentHunk) {
      const b = currentHunk.body;
      while (b.length > 0) {
        const last = b[b.length - 1];
        if (last.kind === 'context' && last.text === '') b.pop();
        else break;
      }
    }
    currentHunk = null;
    state = 'between';
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const lineNo = i + 1;

    if (state === 'body') {
      // A --- line followed by +++ ends the body (new section header).
      if (line.startsWith('--- ') && i + 1 < lines.length && lines[i + 1].startsWith('+++ ')) {
        finishBody();
        continue;
      }
      if (line === '' || line.startsWith(' ') || line.startsWith('-') || line.startsWith('+') || line.startsWith('\\')) {
        const kind: HunkBodyEntry['kind'] =
          line === '' ? 'context' : line[0] === ' ' ? 'context' : line[0] === '-' ? 'old' : line[0] === '+' ? 'new' : 'backslash';
        const text = line === '' ? '' : line.slice(1);
        currentHunk!.body.push({ kind, text });
        i++;
        continue;
      }
      finishBody();
      continue;
    }

    if (line.startsWith('diff --git ')) {
      const dg = parseDiffGit(line);
      if (!dg) throw new ParseError(lineNo);
      startSection(dg.x, dg.y, false);
      i++;
      continue;
    }

    if (line.startsWith('--- ') && i + 1 < lines.length && lines[i + 1].startsWith('+++ ')) {
      if (state === 'header' && section) {
        section.oldPath = parseDashPath(line);
        section.newPath = parseDashPath(lines[i + 1]);
        section.hasDashPair = true;
        i += 2;
        continue;
      }
      const oldP = parseDashPath(line);
      const newP = parseDashPath(lines[i + 1]);
      startSection(oldP, newP, true);
      i += 2;
      continue;
    }

    if (line.startsWith('--- ')) {
      if (state === 'header') {
        throw new ParseError(lineNo + 1);
      }
      i++;
      continue;
    }

    if (line.startsWith('@@')) {
      if (state === 'outside' || !section) {
        throw new ParseError(lineNo);
      }
      const a = parseHunkHeader(line);
      if (a === null) throw new ParseError(lineNo);
      currentHunk = { a, body: [] };
      section.hunks.push(currentHunk);
      state = 'body';
      i++;
      continue;
    }

    if (state === 'header' && section) {
      if (line.startsWith('rename from ')) {
        if (!section.hasDashPair) section.oldPath = line.slice('rename from '.length).trim();
      } else if (line.startsWith('rename to ')) {
        if (!section.hasDashPair) section.newPath = line.slice('rename to '.length).trim();
      } else if (line.startsWith('new file mode')) {
        section.isNewFile = true;
      } else if (line.startsWith('deleted file mode')) {
        section.isDeletedFile = true;
      }
      i++;
      continue;
    }

    i++;
  }

  if (state === 'body') finishBody();
  return sections;
}

// Apply one section's hunks to a copy of a file's lines. Returns the new lines
// and final-break flag, or a failure code.
function applyUnifiedHunks(
  fileLines: string[],
  fileEndsWithBreak: boolean,
  hunks: UnifiedHunk[],
  strict: boolean,
): { ok: true; lines: string[]; endsWithBreak: boolean } | { ok: false; code: string } {
  let lines = [...fileLines];
  let endsWithBreak = fileEndsWithBreak;
  let d = 0;
  for (const hunk of hunks) {
    const oLines: string[] = [];
    const nEntries: NEntry[] = [];
    let oIdx = 0;
    for (const e of hunk.body) {
      if (e.kind === 'context') {
        oLines.push(e.text);
        nEntries.push({ text: e.text, isContext: true, oPos: oIdx });
        oIdx++;
      } else if (e.kind === 'old') {
        oLines.push(e.text);
        oIdx++;
      } else if (e.kind === 'new') {
        nEntries.push({ text: e.text, isContext: false, oPos: -1 });
      }
    }
    let lastCtxNewIdx = -1;
    for (let k = hunk.body.length - 1; k >= 0; k--) {
      if (hunk.body[k].kind === 'context' || hunk.body[k].kind === 'new') {
        lastCtxNewIdx = k;
        break;
      }
    }
    const hasBackslashAfterLast =
      lastCtxNewIdx >= 0 && lastCtxNewIdx + 1 < hunk.body.length && hunk.body[lastCtxNewIdx + 1].kind === 'backslash';

    if (oLines.length === 0) {
      const oldLen = lines.length;
      const insertPos = Math.min(hunk.a + d, oldLen);
      const insLines = nEntries.map((e) => e.text);
      lines = [...lines.slice(0, insertPos), ...insLines, ...lines.slice(insertPos)];
      if (insertPos === oldLen) {
        endsWithBreak = !hasBackslashAfterLast;
      }
      d += nEntries.length;
      continue;
    }

    const found = findFirstTierOccurrences(lines, oLines, 0, strict);
    if (!found) return { ok: false, code: 'no-match' };
    const target = hunk.a - 1 + d;
    let best = found.occ[0];
    let bestDist = Math.abs(best - target);
    for (const p of found.occ) {
      const dist = Math.abs(p - target);
      if (dist < bestDist || (dist === bestDist && p < best)) {
        best = p;
        bestDist = dist;
      }
    }
    const pos = best;
    const replacement = buildReplacement(nEntries, lines, pos, oLines, found.tier);
    const matchedToEnd = pos + oLines.length === lines.length;
    lines = [...lines.slice(0, pos), ...replacement, ...lines.slice(pos + oLines.length)];
    if (matchedToEnd) {
      endsWithBreak = !hasBackslashAfterLast;
    }
    d += nEntries.length - oLines.length;
  }
  return { ok: true, lines, endsWithBreak };
}

function unifiedSectionToEdit(section: UnifiedSection, strict: boolean): Edit {
  const oldP = section.oldPath;
  const newP = section.newPath;
  const oldIsNull = oldP === '/dev/null';
  const newIsNull = newP === '/dev/null';
  const isCreation = oldIsNull || section.isNewFile;
  const isDeletion = !isCreation && (newIsNull || section.isDeletedFile);
  const isMove = !isCreation && !isDeletion && oldP !== newP;

  if (isCreation) {
    return {
      paths: [newP],
      apply(tree: Tree): EditResult {
        const bad = checkPathsSafe([newP]);
        if (bad) return bad;
        const cur = tree.load(newP);
        if (cur.exists) return fail('exists', newP);
        const plusLines: string[] = [];
        let endsWithBreak = true;
        // Find the last + line across all hunks; a \ after it removes the final break.
        let lastPlusHunk: UnifiedHunk | null = null;
        let lastPlusIdx = -1;
        for (const h of section.hunks) {
          for (let k = 0; k < h.body.length; k++) {
            if (h.body[k].kind === 'new') {
              lastPlusHunk = h;
              lastPlusIdx = k;
            }
          }
        }
        if (lastPlusHunk && lastPlusIdx + 1 < lastPlusHunk.body.length && lastPlusHunk.body[lastPlusIdx + 1].kind === 'backslash') {
          endsWithBreak = false;
        }
        for (const h of section.hunks) {
          for (const e of h.body) {
            if (e.kind === 'new') plusLines.push(e.text);
          }
        }
        if (plusLines.length === 0) endsWithBreak = false;
        tree.set(newP, { exists: true, lines: plusLines, lineBreak: '\n', endsWithBreak });
        return { ok: true };
      },
    };
  }

  if (isDeletion) {
    return {
      paths: [oldP],
      apply(tree: Tree): EditResult {
        const bad = checkPathsSafe([oldP]);
        if (bad) return bad;
        const cur = tree.load(oldP);
        if (!cur.exists) return fail('missing', oldP);
        tree.remove(oldP);
        return { ok: true };
      },
    };
  }

  if (isMove) {
    return {
      paths: [oldP, newP],
      apply(tree: Tree): EditResult {
        const bad = checkPathsSafe([oldP, newP]);
        if (bad) return bad;
        const curOld = tree.load(oldP);
        if (!curOld.exists) return fail('missing', oldP);
        const curNew = tree.load(newP);
        if (curNew.exists) return fail('exists', newP);
        const res = applyUnifiedHunks(curOld.lines, curOld.endsWithBreak, section.hunks, strict);
        if (!res.ok) return fail(res.code, oldP);
        tree.set(newP, { exists: true, lines: res.lines, lineBreak: curOld.lineBreak, endsWithBreak: res.endsWithBreak });
        tree.remove(oldP);
        tree.moves.push({ old: oldP, npath: newP });
        return { ok: true };
      },
    };
  }

  // Change of the one path.
  return {
    paths: [oldP],
    apply(tree: Tree): EditResult {
      const bad = checkPathsSafe([oldP]);
      if (bad) return bad;
      const cur = tree.load(oldP);
      if (!cur.exists) return fail('missing', oldP);
      const res = applyUnifiedHunks(cur.lines, cur.endsWithBreak, section.hunks, strict);
      if (!res.ok) return fail(res.code, oldP);
      tree.set(oldP, { exists: true, lines: res.lines, lineBreak: cur.lineBreak, endsWithBreak: res.endsWithBreak });
      return { ok: true };
    },
  };
}

// ---------------------------------------------------------------- search-replace (SPEC section 7)

interface SRBlock {
  path: string;
  oldLines: string[];
  newLines: string[];
}

function parseSearchReplace(lines: string[]): SRBlock[] {
  const blocks: SRBlock[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;

  let i = 0;
  while (i < lines.length) {
    if (rstrip(lines[i]) !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchIdx = i;
    const searchLineNo = i + 1;
    let foundPath: string | null = null;
    for (let k = searchIdx - 1; k > prevEnd; k--) {
      const l = lines[k];
      if (isBlank(l)) continue;
      const t = l.trim();
      if (t.startsWith('```')) continue;
      foundPath = t;
      break;
    }
    let blockPath: string;
    if (foundPath !== null) {
      blockPath = foundPath;
    } else if (prevPath !== null) {
      blockPath = prevPath;
    } else {
      throw new ParseError(searchLineNo);
    }
    let eqIdx = -1;
    let repIdx = -1;
    for (let k = searchIdx + 1; k < lines.length; k++) {
      if (rstrip(lines[k]) === '<<<<<<< SEARCH') break;
      if (eqIdx === -1) {
        if (rstrip(lines[k]) === '=======') eqIdx = k;
      } else {
        if (rstrip(lines[k]) === '>>>>>>> REPLACE') {
          repIdx = k;
          break;
        }
      }
    }
    if (eqIdx === -1 || repIdx === -1) {
      throw new ParseError(searchLineNo);
    }
    const oldLines = lines.slice(searchIdx + 1, eqIdx);
    const newLines = lines.slice(eqIdx + 1, repIdx);
    blocks.push({ path: blockPath, oldLines, newLines });
    prevPath = blockPath;
    prevEnd = repIdx;
    i = repIdx + 1;
  }
  return blocks;
}

function srBlockToEdit(block: SRBlock, strict: boolean): Edit {
  return {
    paths: [block.path],
    apply(tree: Tree): EditResult {
      const bad = checkPathsSafe([block.path]);
      if (bad) return bad;
      if (block.oldLines.length === 0) {
        const cur = tree.load(block.path);
        if (cur.exists) return fail('exists', block.path);
        tree.set(block.path, {
          exists: true,
          lines: [...block.newLines],
          lineBreak: '\n',
          endsWithBreak: block.newLines.length > 0,
        });
        return { ok: true };
      }
      const cur = tree.load(block.path);
      if (!cur.exists) return fail('missing', block.path);
      const found = findFirstTierOccurrences(cur.lines, block.oldLines, 0, strict);
      if (!found) return fail('no-match', block.path);
      if (found.occ.length > 1) return fail('ambiguous', block.path);
      const pos = found.occ[0];
      const nEntries: NEntry[] = block.newLines.map((t) => ({ text: t, isContext: false, oPos: -1 }));
      const replacement = buildReplacement(nEntries, cur.lines, pos, block.oldLines, found.tier);
      const newLines = [
        ...cur.lines.slice(0, pos),
        ...replacement,
        ...cur.lines.slice(pos + block.oldLines.length),
      ];
      tree.set(block.path, { exists: true, lines: newLines, lineBreak: cur.lineBreak, endsWithBreak: cur.endsWithBreak });
      return { ok: true };
    },
  };
}

// ---------------------------------------------------------------- V4A (SPEC section 8)

interface V4AChunk {
  anchor: string | null;
  endOfFile: boolean;
  body: { kind: 'context' | 'old' | 'new'; text: string }[];
}

interface V4ASection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  lines: string[];
  moveTo: string | null;
  chunks: V4AChunk[];
  updateLine: number;
}

function isV4ASectionStart(line: string): boolean {
  return line.startsWith('*** Add File:') || line.startsWith('*** Delete File:') || line.startsWith('*** Update File:');
}

function parseV4A(lines: string[]): V4ASection[] {
  let firstNonBlank = -1;
  for (let i = 0; i < lines.length; i++) {
    if (!isBlank(lines[i])) {
      firstNonBlank = i;
      break;
    }
  }
  if (firstNonBlank === -1) throw new ParseError(1);
  if (lines[firstNonBlank].trim() !== '*** Begin Patch') {
    throw new ParseError(firstNonBlank + 1);
  }
  let lastNonBlank = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!isBlank(lines[i])) {
      lastNonBlank = i;
      break;
    }
  }
  if (lines[lastNonBlank].trim() !== '*** End Patch') {
    throw new ParseError(lines.length + 1);
  }

  const sections: V4ASection[] = [];
  let i = firstNonBlank + 1;
  const end = lastNonBlank;

  while (i < end) {
    const line = lines[i];
    if (isBlank(line)) {
      i++;
      continue;
    }
    let kind: 'add' | 'delete' | 'update' | null = null;
    let path = '';
    if (line.startsWith('*** Add File:')) {
      kind = 'add';
      path = line.slice('*** Add File:'.length).trim();
    } else if (line.startsWith('*** Delete File:')) {
      kind = 'delete';
      path = line.slice('*** Delete File:'.length).trim();
    } else if (line.startsWith('*** Update File:')) {
      kind = 'update';
      path = line.slice('*** Update File:'.length).trim();
    } else {
      throw new ParseError(i + 1);
    }
    const sectionLine = i + 1;
    i++;

    if (kind === 'add') {
      const fileLines: string[] = [];
      while (i < end) {
        const l = lines[i];
        if (isV4ASectionStart(l) || l.trim() === '*** End Patch') break;
        if (isBlank(l)) {
          fileLines.push('');
          i++;
          continue;
        }
        if (l.startsWith('+')) {
          fileLines.push(l.slice(1));
          i++;
          continue;
        }
        throw new ParseError(i + 1);
      }
      while (fileLines.length > 0 && fileLines[fileLines.length - 1] === '') fileLines.pop();
      sections.push({ kind: 'add', path, lines: fileLines, moveTo: null, chunks: [], updateLine: sectionLine });
      continue;
    }

    if (kind === 'delete') {
      while (i < end) {
        const l = lines[i];
        if (isBlank(l)) {
          i++;
          continue;
        }
        if (isV4ASectionStart(l) || l.trim() === '*** End Patch') break;
        throw new ParseError(i + 1);
      }
      sections.push({ kind: 'delete', path, lines: [], moveTo: null, chunks: [], updateLine: sectionLine });
      continue;
    }

    // update
    // Find the section's extent: up to the next section start or End Patch.
    let sectionEnd = i;
    while (sectionEnd < end) {
      const l = lines[sectionEnd];
      if (isV4ASectionStart(l) || l.trim() === '*** End Patch') break;
      sectionEnd++;
    }
    // Strip trailing blank lines (blank lines at the end of a section).
    let contentEnd = sectionEnd;
    while (contentEnd > i && isBlank(lines[contentEnd - 1])) contentEnd--;
    // Parse the content [i, contentEnd).
    let moveTo: string | null = null;
    // First non-blank line: Move to?
    let f = i;
    while (f < contentEnd && isBlank(lines[f])) f++;
    let chunkStart = i;
    if (f < contentEnd && lines[f].startsWith('*** Move to:')) {
      moveTo = lines[f].slice('*** Move to:'.length).trim();
      chunkStart = f + 1;
    } else if (f < contentEnd && lines[f].startsWith('@@')) {
      chunkStart = f;
    } else {
      chunkStart = i;
    }
    const chunks: V4AChunk[] = [];
    let curChunk: V4AChunk | null = null;
    const startChunk = (anchor: string | null) => {
      curChunk = { anchor, endOfFile: false, body: [] };
      chunks.push(curChunk);
    };
    for (let k = chunkStart; k < contentEnd; k++) {
      const l = lines[k];
      if (l.startsWith('@@')) {
        startChunk(l.slice(2).trim() === '' ? null : l.slice(2).trim());
        continue;
      }
      if (l.trim() === '*** End of File') {
        if (!curChunk) throw new ParseError(k + 1);
        curChunk.endOfFile = true;
        curChunk = null;
        continue;
      }
      const isBody = l === '' || isBlank(l) || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+');
      if (isBody) {
        if (!curChunk) {
          if (chunks.length > 0) {
            // A body line after a chunk closed (End of File) cannot start a chunk.
            if (isBlank(l)) continue;
            throw new ParseError(k + 1);
          }
          startChunk(null);
        }
        const kind2: 'context' | 'old' | 'new' = l === '' || isBlank(l) ? 'context' : l[0] === ' ' ? 'context' : l[0] === '-' ? 'old' : 'new';
        const text = l === '' || isBlank(l) ? '' : l.slice(1);
        curChunk.body.push({ kind: kind2, text });
        continue;
      }
      throw new ParseError(k + 1);
    }
    if (chunks.length === 0 && moveTo === null) {
      throw new ParseError(sectionLine);
    }
    sections.push({ kind: 'update', path, lines: [], moveTo, chunks, updateLine: sectionLine });
    i = sectionEnd;
  }
  return sections;
}

function v4aSectionToEdit(section: V4ASection, strict: boolean): Edit {
  if (section.kind === 'add') {
    return {
      paths: [section.path],
      apply(tree: Tree): EditResult {
        const bad = checkPathsSafe([section.path]);
        if (bad) return bad;
        const cur = tree.load(section.path);
        if (cur.exists) return fail('exists', section.path);
        tree.set(section.path, {
          exists: true,
          lines: [...section.lines],
          lineBreak: '\n',
          endsWithBreak: true,
        });
        return { ok: true };
      },
    };
  }

  if (section.kind === 'delete') {
    return {
      paths: [section.path],
      apply(tree: Tree): EditResult {
        const bad = checkPathsSafe([section.path]);
        if (bad) return bad;
        const cur = tree.load(section.path);
        if (!cur.exists) return fail('missing', section.path);
        tree.remove(section.path);
        return { ok: true };
      },
    };
  }

  // update
  const newPath = section.moveTo;
  const paths = newPath === null ? [section.path] : [section.path, newPath];
  return {
    paths,
    apply(tree: Tree): EditResult {
      const bad = checkPathsSafe(paths);
      if (bad) return bad;
      const cur = tree.load(section.path);
      if (!cur.exists) return fail('missing', section.path);
      if (newPath !== null) {
        const curNew = tree.load(newPath);
        if (curNew.exists) return fail('exists', newPath);
      }
      let lines = [...cur.lines];
      let cursor = 0;
      for (const chunk of section.chunks) {
        // Anchor: first line at or after the cursor equal to the anchor at the
        // first tier where one is (both sides a single line).
        if (chunk.anchor !== null) {
          const anchorLines = [chunk.anchor];
          const foundAnchor = findFirstTierOccurrences(lines, anchorLines, cursor, strict);
          if (!foundAnchor) return fail('no-match', section.path);
          cursor = foundAnchor.occ[0] + 1;
        }
        const oLines: string[] = [];
        const nEntries: NEntry[] = [];
        let oIdx = 0;
        for (const e of chunk.body) {
          if (e.kind === 'context') {
            oLines.push(e.text);
            nEntries.push({ text: e.text, isContext: true, oPos: oIdx });
            oIdx++;
          } else if (e.kind === 'old') {
            oLines.push(e.text);
            oIdx++;
          } else {
            nEntries.push({ text: e.text, isContext: false, oPos: -1 });
          }
        }
        if (oLines.length === 0) {
          const insertPos = chunk.endOfFile ? lines.length : cursor;
          const insLines = nEntries.map((e) => e.text);
          lines = [...lines.slice(0, insertPos), ...insLines, ...lines.slice(insertPos)];
          cursor = insertPos + insLines.length;
          continue;
        }
        const found = findFirstTierOccurrences(lines, oLines, cursor, strict);
        if (!found) return fail('no-match', section.path);
        let pos: number | null = null;
        for (const p of found.occ) {
          if (chunk.endOfFile) {
            if (p + oLines.length === lines.length) {
              pos = p;
              break;
            }
          } else {
            pos = p;
            break;
          }
        }
        if (pos === null) return fail('no-match', section.path);
        const replacement = buildReplacement(nEntries, lines, pos, oLines, found.tier);
        lines = [...lines.slice(0, pos), ...replacement, ...lines.slice(pos + oLines.length)];
        cursor = pos + replacement.length;
      }
      if (newPath !== null) {
        tree.set(newPath, { exists: true, lines, lineBreak: cur.lineBreak, endsWithBreak: cur.endsWithBreak });
        tree.remove(section.path);
        tree.moves.push({ old: section.path, npath: newPath });
      } else {
        tree.set(section.path, { exists: true, lines, lineBreak: cur.lineBreak, endsWithBreak: cur.endsWithBreak });
      }
      return { ok: true };
    },
  };
}

// ---------------------------------------------------------------- JSON (SPEC section 9)

interface JsonEdit {
  path: string;
  command: 'create' | 'str_replace' | 'insert';
  file_text?: string;
  old_str?: string;
  new_str?: string;
  insert_line?: number;
}

function parseJsonEditObject(obj: unknown): JsonEdit | null {
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) return null;
  const o = obj as Record<string, unknown>;
  if (typeof o.path !== 'string') return null;
  if (typeof o.command !== 'string') return null;
  if (o.command === 'create') {
    if (typeof o.file_text !== 'string') return null;
    return { path: o.path, command: 'create', file_text: o.file_text };
  }
  if (o.command === 'str_replace') {
    if (typeof o.old_str !== 'string' || o.old_str === '') return null;
    if (o.new_str !== undefined && typeof o.new_str !== 'string') return null;
    return { path: o.path, command: 'str_replace', old_str: o.old_str, new_str: o.new_str === undefined ? '' : o.new_str };
  }
  if (o.command === 'insert') {
    if (typeof o.insert_line !== 'number' || !Number.isInteger(o.insert_line)) return null;
    if (typeof o.new_str !== 'string') return null;
    return { path: o.path, command: 'insert', insert_line: o.insert_line, new_str: o.new_str };
  }
  return null;
}

function parseJson(lines: string[], patchText: string): JsonEdit[] {
  let firstNonBlank = -1;
  for (let i = 0; i < lines.length; i++) {
    if (!isBlank(lines[i])) {
      firstNonBlank = i;
      break;
    }
  }
  if (firstNonBlank === -1) throw new ParseError(1);
  const firstChar = lines[firstNonBlank].trimStart()[0];
  if (firstChar === '[') {
    const arrayStartLine = firstNonBlank + 1;
    let arr: unknown;
    try {
      arr = JSON.parse(patchText);
    } catch {
      throw new ParseError(arrayStartLine);
    }
    if (!Array.isArray(arr)) throw new ParseError(arrayStartLine);
    const edits: JsonEdit[] = [];
    for (const el of arr) {
      const e = parseJsonEditObject(el);
      if (!e) throw new ParseError(arrayStartLine);
      edits.push(e);
    }
    return edits;
  }
  const edits: JsonEdit[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (isBlank(l)) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(l);
    } catch {
      throw new ParseError(i + 1);
    }
    const e = parseJsonEditObject(obj);
    if (!e) throw new ParseError(i + 1);
    edits.push(e);
  }
  return edits;
}

function jsonEditToEdit(edit: JsonEdit): Edit {
  return {
    paths: [edit.path],
    apply(tree: Tree): EditResult {
      const bad = checkPathsSafe([edit.path]);
      if (bad) return bad;
      if (edit.command === 'create') {
        const cur = tree.load(edit.path);
        if (cur.exists) return fail('exists', edit.path);
        tree.set(edit.path, makeFileState(edit.file_text!));
        return { ok: true };
      }
      if (edit.command === 'str_replace') {
        const cur = tree.load(edit.path);
        if (!cur.exists) return fail('missing', edit.path);
        const isCRLF = cur.lineBreak === '\r\n';
        let text = serializeFile(cur);
        let oldStr = edit.old_str!;
        let newStr = edit.new_str!;
        if (isCRLF) {
          text = text.replace(/\r\n/g, '\n');
          oldStr = oldStr.replace(/\r\n/g, '\n');
          newStr = newStr.replace(/\r\n/g, '\n');
        }
        const occ: number[] = [];
        let idx = text.indexOf(oldStr);
        while (idx !== -1) {
          occ.push(idx);
          idx = text.indexOf(oldStr, idx + 1);
        }
        if (occ.length === 0) return fail('no-match', edit.path);
        if (occ.length > 1) return fail('ambiguous', edit.path);
        const pos = occ[0];
        let result = text.slice(0, pos) + newStr + text.slice(pos + oldStr.length);
        if (isCRLF) {
          result = result.replace(/\n/g, '\r\n');
        }
        tree.set(edit.path, makeFileState(result));
        return { ok: true };
      }
      const cur = tree.load(edit.path);
      if (!cur.exists) return fail('missing', edit.path);
      const n = cur.lines.length;
      const insLine = edit.insert_line!;
      if (insLine < 0 || insLine > n) return fail('no-match', edit.path);
      const newLines = edit.new_str === '' ? [] : splitPatchLines(edit.new_str!);
      const lines = [...cur.lines.slice(0, insLine), ...newLines, ...cur.lines.slice(insLine)];
      tree.set(edit.path, { exists: true, lines, lineBreak: cur.lineBreak, endsWithBreak: cur.endsWithBreak });
      return { ok: true };
    },
  };
}

// ---------------------------------------------------------------- invocation (SPEC sections 1, 2, 4, 10)

const FORMAT_NAMES = ['unified', 'search-replace', 'v4a', 'json', 'auto'];

function detectFormat(lines: string[]): string | null {
  let firstNonBlank = -1;
  for (let i = 0; i < lines.length; i++) {
    if (!isBlank(lines[i])) {
      firstNonBlank = i;
      break;
    }
  }
  if (firstNonBlank === -1) return null;
  const first = lines[firstNonBlank];
  if (first.trim() === '*** Begin Patch') return 'v4a';
  const firstChar = first.trimStart()[0];
  if (firstChar === '[' || firstChar === '{') return 'json';
  for (const l of lines) {
    if (rstrip(l) === '<<<<<<< SEARCH') return 'search-replace';
  }
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('diff --git ')) return 'unified';
    if (lines[i].startsWith('--- ') && i + 1 < lines.length && lines[i + 1].startsWith('+++ ')) return 'unified';
  }
  return null;
}

function exitWith(code: number, lines: string[]): never {
  if (lines.length > 0) {
    fs.writeSync(1, lines.join('\n') + '\n');
  }
  process.exit(code);
}

function main(): void {
  const argv = process.argv.slice(2);
  let format = 'auto';
  let check = false;
  let strict = false;
  let seenFormat = false;
  let seenCheck = false;
  let seenStrict = false;
  const positional: string[] = [];
  let endOfOptions = false;
  let usage = false;

  for (const arg of argv) {
    if (!endOfOptions && arg === '--') {
      endOfOptions = true;
      continue;
    }
    if (!endOfOptions && arg.startsWith('-') && arg !== '-') {
      if (arg === '--check') {
        if (seenCheck) usage = true;
        seenCheck = true;
        check = true;
      } else if (arg === '--strict') {
        if (seenStrict) usage = true;
        seenStrict = true;
        strict = true;
      } else if (arg.startsWith('--format=')) {
        if (seenFormat) usage = true;
        seenFormat = true;
        const v = arg.slice('--format='.length);
        if (!FORMAT_NAMES.includes(v)) usage = true;
        else format = v;
      } else {
        usage = true;
      }
    } else {
      positional.push(arg);
    }
  }
  if (positional.length > 1) usage = true;
  if (usage) {
    exitWith(2, ['error: usage']);
  }

  const patchArg = positional.length === 1 ? positional[0] : null;
  let patchText: string;
  if (patchArg === null || patchArg === '-') {
    patchText = fs.readFileSync(0, 'utf8');
  } else {
    try {
      patchText = fs.readFileSync(patchArg, 'utf8');
    } catch {
      exitWith(2, ['error: no-patch']);
    }
  }

  const patchLines = splitPatchLines(patchText);
  let fmt = format;
  if (fmt === 'auto') {
    const detected = detectFormat(patchLines);
    if (!detected) {
      exitWith(2, ['error: format']);
    }
    fmt = detected;
  }

  let edits: Edit[];
  try {
    if (fmt === 'unified') {
      const sections = parseUnified(patchLines);
      edits = sections.map((s) => unifiedSectionToEdit(s, strict));
    } else if (fmt === 'search-replace') {
      const blocks = parseSearchReplace(patchLines);
      edits = blocks.map((b) => srBlockToEdit(b, strict));
    } else if (fmt === 'v4a') {
      const sections = parseV4A(patchLines);
      edits = sections.map((s) => v4aSectionToEdit(s, strict));
    } else {
      const jedits = parseJson(patchLines, patchText);
      edits = jedits.map((e) => jsonEditToEdit(e));
    }
  } catch (e) {
    if (e instanceof ParseError) {
      exitWith(2, ['error: parse ' + e.line]);
    }
    throw e;
  }

  if (edits.length === 0) {
    exitWith(2, ['error: parse 1']);
  }

  const tree = new Tree();
  const failures: { code: string; path: string }[] = [];
  for (const edit of edits) {
    const res = edit.apply(tree);
    if (!res.ok) {
      failures.push({ code: res.code, path: res.path });
    }
  }

  if (failures.length > 0) {
    const out: string[] = failures.map((f) => 'error: ' + f.code + ' ' + f.path);
    out.push('failed: ' + failures.length + ' of ' + edits.length + ' edits');
    exitWith(1, out);
  }

  const changeEntries: { sortKey: string; line: string }[] = [];
  const entryByPath = new Map<string, { sortKey: string; line: string }>();
  for (const p of tree.touchedPaths()) {
    const before = tree.original(p);
    const after = tree.currentBytes(p);
    if (before === null && after !== null) {
      const e = { sortKey: p, line: 'A ' + p };
      changeEntries.push(e);
      entryByPath.set(p, e);
    } else if (before !== null && after === null) {
      const e = { sortKey: p, line: 'D ' + p };
      changeEntries.push(e);
      entryByPath.set(p, e);
    } else if (before !== null && after !== null && !before.equals(after)) {
      const e = { sortKey: p, line: 'M ' + p };
      changeEntries.push(e);
      entryByPath.set(p, e);
    }
  }
  const finalEntries: { sortKey: string; line: string }[] = [...changeEntries];
  for (const m of tree.moves) {
    const dEntry = entryByPath.get(m.old);
    const aEntry = entryByPath.get(m.npath);
    if (dEntry && dEntry.line.startsWith('D ') && aEntry && aEntry.line.startsWith('A ')) {
      const di = finalEntries.indexOf(dEntry);
      if (di >= 0) finalEntries.splice(di, 1);
      const ai = finalEntries.indexOf(aEntry);
      if (ai >= 0) finalEntries.splice(ai, 1);
      entryByPath.delete(m.old);
      entryByPath.delete(m.npath);
      finalEntries.push({ sortKey: m.npath, line: 'R ' + m.old + ' -> ' + m.npath });
    }
  }
  finalEntries.sort((a, b) => compareBytes(a.sortKey, b.sortKey));

  if (!check) {
    for (const p of tree.touchedPaths()) {
      const before = tree.original(p);
      const after = tree.currentBytes(p);
      if (before === null && after === null) continue;
      if (before !== null && after !== null && before.equals(after)) continue;
      if (after === null) {
        try {
          fs.unlinkSync(p);
        } catch {
          /* already gone */
        }
      } else {
        const dir = p.split('/').slice(0, -1).join('/');
        if (dir !== '') {
          fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(p, after);
      }
    }
  }

  const out: string[] = finalEntries.map((e) => e.line);
  const n = finalEntries.length;
  out.push(n === 1 ? 'ok: 1 file' : 'ok: ' + n + ' files');
  exitWith(0, out);
}

// ---------------------------------------------------------------- entry

async function run(): Promise<void> {
  // Harness handoff: when the grader runs main.ts with the trial env URL set,
  // hand the trial over to the kit's runner. The runner exports runTrial(url):
  // it fetches the trial's checks (GET $MAKEFUN_ENV_URL/checks), runs
  // node main.ts on each one in a fresh dir, and posts results
  // (POST $MAKEFUN_ENV_URL/results). Importing the module alone does nothing;
  // runTrial must be called with the env URL.
  if (process.env.MAKEFUN_ENV_URL) {
    const { runTrial } = await import('./runner.ts');
    await runTrial(process.env.MAKEFUN_ENV_URL);
    return;
  }
  main();
}

run();
