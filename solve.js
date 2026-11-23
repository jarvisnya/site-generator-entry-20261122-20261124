// Fast drop-in for makefun-site 1.0.0: same output, byte for byte, built faster.
// Optimisations: cached slugify/longDate, fast HTML escaping (plain-text fast
// path), front matter without splitting the whole body, Markdown rendered
// directly to HTML without token objects, and a template interpreter with
// prototype-chain scopes and one mutable frame per loop (rendering is
// synchronous, so reusing the frame is exact).

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);
const RESERVED = ['posts', 'tags', 'page'];

const ESC_RE = /[&<>"']/g;
function esc(s) {
  ESC_RE.lastIndex = 0;
  let out = '';
  let last = 0;
  let found = false;
  let m;
  while ((m = ESC_RE.exec(s)) !== null) {
    found = true;
    out += s.slice(last, m.index) + ESCAPES[m[0]];
    last = m.index + 1;
  }
  if (!found) return s;
  return out + s.slice(last);
}

const slugCache = new Map();
function slugify(text) {
  const hit = slugCache.get(text);
  if (hit !== undefined) return hit;
  let out;
  if (!/[^\x00-\x7f]/.test(text)) {
    out = '';
    let gap = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      let keep = null;
      if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
      else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
      if (keep === null) { gap = out.length > 0; continue; }
      if (gap) out += '-';
      gap = false;
      out += keep;
    }
  } else {
    const plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
    out = '';
    let gap = false;
    for (const ch of plain) {
      let keep = null;
      if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
      else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
      if (keep === null) { gap = out.length > 0; continue; }
      if (gap) out += '-';
      gap = false;
      out += keep;
    }
  }
  out = out.slice(0, 64).replace(/-+$/, '');
  if (out === '') out = 'untitled';
  if (slugCache.size < 50000) slugCache.set(text, out);
  return out;
}

function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

const dateCache = new Map();
function longDate(date) {
  let v = dateCache.get(date);
  if (v === undefined) {
    v = `${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`;
    dateCache.set(date, v);
  }
  return v;
}

function wordsOf(text) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    const ws = c === 32 || c === 9 || c === 10 || c === 13 || c === 12 || c === 11 || c === 160 || c === 5760 || (c >= 8192 && c <= 8202) || c === 8232 || c === 8233 || c === 8239 || c === 8287 || c === 12288 || c === 65279;
    if (!ws && !inWord) { n++; inWord = true; }
    else if (ws) inWord = false;
  }
  return n;
}

const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

// ---- front matter ----
const FM_KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];
const FM_LINE = /^([a-z_]+):(?: (.*))?$/;
const FM_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const FM_NAME = /^[a-z0-9-]+$/;
const FM_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FM_TAG = /^[^"[\]]+$/;

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}
function stringOf(raw) {
  if (raw.startsWith('"')) {
    if (raw.length < 2 || !raw.endsWith('"')) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.startsWith('[')) return { error: 'a bare string opens on [' };
  return { value: raw };
}
function fmValueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const m = FM_DATE.exec(raw);
      const y = m ? Number(m[1]) : 0;
      const mo = m ? Number(m[2]) : 0;
      const d = m ? Number(m[3]) : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (!raw.startsWith('[') || !raw.endsWith(']')) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      if (tags.some((t) => t === '' || !FM_TAG.test(t))) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return FM_NAME.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return FM_SLUG.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}
function isBlankLine(line) {
  if (line.length === 0) return true;
  const c = line[0];
  if (c !== ' ' && c !== '\t') return false;
  for (let i = 1; i < line.length; i++) if (line[i] !== ' ' && line[i] !== '\t') return false;
  return true;
}
function parseFrontMatter(text) {
  const firstNL = text.indexOf('\n');
  const first = firstNL === -1 ? text : text.slice(0, firstNL);
  if (first !== '---') return { error: 'no front matter' };
  // find the closing --- line, tracking line numbers (1-based, opening --- is 1)
  let pos = firstNL === -1 ? text.length : firstNL + 1;
  let lineNo = 2;
  let closeLineNo = -1;
  let closeEnd = -1;
  while (pos < text.length) {
    const nl = text.indexOf('\n', pos);
    const line = nl === -1 ? text.slice(pos) : text.slice(pos, nl);
    if (line === '---') { closeLineNo = lineNo; closeEnd = nl === -1 ? text.length : nl + 1; break; }
    if (nl === -1) break;
    pos = nl + 1;
    lineNo++;
  }
  if (closeLineNo === -1) return { error: 'the front matter is not closed' };
  const data = {};
  // walk the lines between opening and closing ---
  let p = firstNL + 1;
  for (let n = 2; n < closeLineNo; n++) {
    const nl = text.indexOf('\n', p);
    const line = nl === -1 ? text.slice(p) : text.slice(p, nl);
    p = nl === -1 ? text.length : nl + 1;
    if (isBlankLine(line) || line.startsWith('#')) continue;
    const m = FM_LINE.exec(line);
    if (!m) return { error: `line ${n} is not "key: value"` };
    const key = m[1];
    const raw = (m[2] ?? '').replace(/[ \t]+$/, '');
    if (!FM_KEYS.includes(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = fmValueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: text.slice(closeEnd) };
}

// ---- Markdown ----
function trimLine(line) {
  if (line.length === 0) return line;
  const first = line[0];
  const last = line[line.length - 1];
  if (first !== ' ' && first !== '\t' && last !== ' ' && last !== '\t') return line;
  let a = 0;
  let b = line.length;
  while (a < b && (line[a] === ' ' || line[a] === '\t')) a++;
  while (b > a && (line[b - 1] === ' ' || line[b - 1] === '\t')) b--;
  return line.slice(a, b);
}
function isLangChar(c) {
  return (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c === '_' || c === '+' || c === '-';
}
function fenceOpen(line) {
  if (line[0] !== '`' || line[1] !== '`' || line[2] !== '`') return null;
  let j = 3;
  while (j < line.length && isLangChar(line[j])) j++;
  const lang = line.slice(3, j);
  while (j < line.length && (line[j] === ' ' || line[j] === '\t')) j++;
  return j === line.length ? lang : null;
}
function fenceClose(line) {
  if (line[0] !== '`' || line[1] !== '`' || line[2] !== '`') return false;
  for (let j = 3; j < line.length; j++) if (line[j] !== ' ' && line[j] !== '\t') return false;
  return true;
}
function headingOf(line) {
  let k = 0;
  while (k < line.length && line[k] === '#') k++;
  if (k === 0 || k > 6) return null;
  if (k < line.length && line[k] === '#') return null; // 7+ '#': first 6 then '#' is not a space
  if (k >= line.length || (line[k] !== ' ' && line[k] !== '\t')) return null;
  let a = k + 1;
  let b = line.length;
  while (b > a && (line[b - 1] === ' ' || line[b - 1] === '\t')) b--;
  if (b === a) return null;
  return { depth: k, text: line.slice(a, b) };
}
function isHr(line) {
  if (line[0] !== '-' && line[0] !== '*') return false;
  const c = line[0];
  if (line[1] !== c || line[2] !== c) return false;
  for (let j = 3; j < line.length; j++) if (line[j] !== ' ' && line[j] !== '\t') return false;
  return true;
}
function endsParagraph(line) {
  return isBlankLine(line) || fenceOpen(line) !== null || headingOf(line) !== null || isHr(line);
}
function bulletOf(line) {
  if ((line[0] === '-' || line[0] === '*') && line[1] === ' ') return line.slice(2);
  return null;
}
function orderedOf(line) {
  let k = 0;
  while (k < line.length && line[k] >= '0' && line[k] <= '9') k++;
  if (k === 0 || k > 9) return null;
  if (line[k] !== '.' || line[k + 1] !== ' ') return null;
  return { start: Number(line.slice(0, k)), rest: line.slice(k + 2) };
}
function isContinued(line) {
  if (line[0] !== ' ' || line[1] !== ' ') return false;
  let j = 0;
  while (j < line.length && line[j] === ' ') j++;
  if (j < 2 || j >= line.length) return false;
  const c = line.charCodeAt(j);
  return !(c === 32 || c === 9 || c === 10 || c === 13 || c === 12 || c === 11 || c === 160 || c === 5760 || (c >= 8192 && c <= 8202) || c === 8232 || c === 8233 || c === 8239 || c === 8287 || c === 12288 || c === 65279);
}
function findUnescaped(s, what, from) {
  for (let j = from; j <= s.length - what.length; j++) {
    if (s[j] === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) { j++; continue; }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}
function findSingleStar(s, from) {
  for (let j = from; j < s.length; j++) {
    const c = s[j];
    if (c === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) { j++; continue; }
    if (c !== '*') continue;
    if (s[j + 1] === '*') { j++; continue; }
    return j;
  }
  return -1;
}
const MD_SPECIAL = /[\\`*[]/;
function inline(s, env) {
  if (!MD_SPECIAL.test(s)) return esc(s);
  let out = '';
  let i = 0;
  let plain = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '\\' && i + 1 < s.length && ESCAPABLE.has(s[i + 1])) {
      if (i > plain) out += esc(s.slice(plain, i)); out += esc(s[i + 1]); i += 2; plain = i; continue;
    }
    if (c === '`') {
      const j = s.indexOf('`', i + 1);
      if (j > i + 1) { if (i > plain) out += esc(s.slice(plain, i)); out += `<code>${esc(s.slice(i + 1, j))}</code>`; i = j + 1; plain = i; }
      else i++;
      continue;
    }
    if (c === '*') {
      if (s[i + 1] === '*') {
        const j = findUnescaped(s, '**', i + 2);
        if (j > i + 2) { if (i > plain) out += esc(s.slice(plain, i)); out += `<strong>${inline(s.slice(i + 2, j), env)}</strong>`; i = j + 2; plain = i; }
        else i += 2;
        continue;
      }
      const j = findSingleStar(s, i + 1);
      if (j > i + 1) { if (i > plain) out += esc(s.slice(plain, i)); out += `<em>${inline(s.slice(i + 1, j), env)}</em>`; i = j + 1; plain = i; }
      else i++;
      continue;
    }
    if (c === '[') {
      const k = findUnescaped(s, ']', i + 1);
      const m = k !== -1 && s[k + 1] === '(' ? s.indexOf(')', k + 2) : -1;
      const target = m === -1 ? '' : s.slice(k + 2, m);
      if (target !== '' && !/\s/.test(target)) {
        if (i > plain) out += esc(s.slice(plain, i)); out += `<a href="${esc(env.link(target))}">${inline(s.slice(i + 1, k), env)}</a>`; i = m + 1; plain = i; continue;
      }
      i++;
      continue;
    }
    i++;
  }
  if (s.length > plain) out += esc(s.slice(plain));
  return out;
}
function renderMarkdown(src, env) {
  const lines = src.split('\n');
  const n = lines.length;
  // Classify every line once: 0 blank, 1 fence, 2 heading, 3 hr, 4 quote,
  // 5 bullet, 6 ordered, 7 other. Block ends check the type, not the regexes.
  const types = new Uint8Array(n);
  const fenceLangArr = new Array(n);
  const headDepth = new Array(n);
  const headText = new Array(n);
  const bulletRest = new Array(n);
  const ordStart = new Array(n);
  const ordRest = new Array(n);
  for (let j = 0; j < n; j++) {
    const l = lines[j];
    if (isBlankLine(l)) { types[j] = 0; continue; }
    const fl = fenceOpen(l);
    if (fl !== null) { types[j] = 1; fenceLangArr[j] = fl; continue; }
    const hd = headingOf(l);
    if (hd !== null) { types[j] = 2; headDepth[j] = hd.depth; headText[j] = hd.text; continue; }
    if (isHr(l)) { types[j] = 3; continue; }
    if (l[0] === '>') { types[j] = 4; continue; }
    const b = bulletOf(l);
    if (b !== null) { types[j] = 5; bulletRest[j] = b; continue; }
    const o = orderedOf(l);
    if (o !== null) { types[j] = 6; ordStart[j] = o.start; ordRest[j] = o.rest; continue; }
    types[j] = 7;
  }
  const ids = new Set();
  const blocks = [];
  const toc = [];
  let excerpt = null;
  let i = 0;
  while (i < n) {
    const t = types[i];
    if (t === 0) { i++; continue; }
    if (t === 1) {
      const fenceLang = fenceLangArr[i];
      const body = [];
      i++;
      while (i < n && !fenceClose(lines[i])) body.push(lines[i++]);
      i++;
      const cls = fenceLang === '' ? '' : ` class="language-${esc(fenceLang)}"`;
      const codeParts = [];
      for (const l of body) codeParts.push(esc(l), '\n');
      blocks.push(`<pre><code${cls}>${codeParts.join('')}</code></pre>\n`);
      continue;
    }
    if (t === 2) {
      const depth = headDepth[i];
      const text = headText[i];
      const id = uniqueSlug(slugify(text), ids);
      const html = inline(text, env);
      blocks.push(`<h${depth} id="${id}">${html}</h${depth}>\n`);
      if (depth === 2 || depth === 3) toc.push({ level: depth, id, html });
      i++;
      continue;
    }
    if (t === 3) { blocks.push('<hr>\n'); i++; continue; }
    if (t === 4) {
      const body = [];
      while (i < n && types[i] === 4) {
        const l = lines[i++];
        body.push(l[1] === ' ' ? l.slice(2) : l.slice(1));
      }
      const trimmed = [];
      for (const l of body) { const tt = trimLine(l); if (tt !== '') trimmed.push(tt); }
      blocks.push(trimmed.length === 0 ? '<blockquote>\n</blockquote>\n' : `<blockquote>\n<p>${inline(trimmed.join('\n'), env)}</p>\n</blockquote>\n`);
      continue;
    }
    if (t === 5 || t === 6) {
      const isOrdered = t === 6;
      const start = isOrdered ? ordStart[i] : 1;
      const items = [];
      while (i < n) {
        if (isOrdered && types[i] === 6) { items.push([trimLine(ordRest[i])]); i++; continue; }
        if (!isOrdered && types[i] === 5) { items.push([trimLine(bulletRest[i])]); i++; continue; }
        if (isContinued(lines[i])) { items[items.length - 1].push(trimLine(lines[i])); i++; continue; }
        break;
      }
      const tag = isOrdered ? 'ol' : 'ul';
      const open = isOrdered && start !== 1 ? `<ol start="${start}">` : `<${tag}>`;
      const listParts = [`${open}\n`];
      for (const item of items) listParts.push(`<li>${inline(item.join('\n'), env)}</li>\n`);
      listParts.push(`</${tag}>\n`);
      blocks.push(listParts.join(''));
      continue;
    }
    const body = [trimLine(lines[i])];
    i++;
    while (i < n) {
      const tt = types[i];
      if (tt === 0 || tt === 1 || tt === 2 || tt === 3) break;
      body.push(trimLine(lines[i++]));
    }
    const html = inline(body.join('\n'), env);
    if (excerpt === null) excerpt = html;
    blocks.push(`<p>${html}</p>\n`);
  }
  return { html: blocks.join(''), toc, excerpt: excerpt ?? '' };
}

// ---- Templates ----
class TemplateError extends Error {}
const T_PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const T_FOR = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const T_IF = /^if (not )?(\S+)$/;
const T_INCLUDE = /^include "([a-z0-9-]+)"$/;
function pathOf(name, text) {
  if (!T_PATH.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) { text += src.slice(i); break; }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') { text += src.slice(i, open + 1); i = open + 1; continue; }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = T_FOR.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node); stack.push(node); body = node.body;
      } else if ((m = T_IF.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node); stack.push(node); body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = []; body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = T_INCLUDE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}
function lookup(scope, path) {
  let v = scope[path[0]];
  if (v === undefined) return undefined;
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}
function renderNodes(nodes, scope, ctx, depth) {
  let out = '';
  for (const n of nodes) {
    switch (n.kind) {
      case 'text': out += n.text; break;
      case 'var': out += esc(textOf(lookup(scope, n.path))); break;
      case 'raw': out += textOf(lookup(scope, n.path)); break;
      case 'if': {
        const v = truthy(lookup(scope, n.path));
        const branch = v !== n.not ? n.then : n.else;
        if (branch !== null) out += renderNodes(branch, scope, ctx, depth);
        break;
      }
      case 'for': {
        const xs = lookup(scope, n.path);
        if (!Array.isArray(xs)) break;
        const frame = Object.create(scope);
        const loop = { index: 1, first: true, last: false, length: xs.length };
        for (let k = 0; k < xs.length; k++) {
          frame[n.name] = xs[k];
          frame.loop = loop;
          loop.index = k + 1; loop.first = k === 0; loop.last = k === xs.length - 1;
          out += renderNodes(n.body, frame, ctx, depth);
        }
        break;
      }
      case 'include': {
        const t = ctx.templates.get(n.name);
        if (t !== undefined && depth < 8) out += renderNodes(t, scope, ctx, depth + 1);
        break;
      }
    }
  }
  return out;
}

// ---- Template compilation ----
// Compile a parsed template to a function (sc, T, D, esc, textOf, get, truthy).
// Dynamic scope (prototype chain) is kept, so includes see the caller's
// loop variables exactly like the interpreter; only the node dispatch is
// compiled away. Any failure falls back to the interpreter.
function compileTemplate(nodes) {
  let uid = 0;
  function gen(list, sc) {
    let code = '';
    for (const n of list) {
      if (n.kind === 'text') code += `out+=${JSON.stringify(n.text)};`;
      else if (n.kind === 'var') code += `out+=esc(textOf(get(${sc},${JSON.stringify(n.path)})));`;
      else if (n.kind === 'raw') code += `out+=textOf(get(${sc},${JSON.stringify(n.path)}));`;
      else if (n.kind === 'if') {
        const cond = `truthy(get(${sc},${JSON.stringify(n.path)}))!==${n.not}`;
        if (n.else !== null) code += `if(${cond}){${gen(n.then, sc)}}else{${gen(n.else, sc)}}`;
        else code += `if(${cond}){${gen(n.then, sc)}}`;
      } else if (n.kind === 'for') {
        const u = uid++;
        const fr = `_fr${u}`;
        const lp = `_lp${u}`;
        const xs = `_xs${u}`;
        const k = `_k${u}`;
        code += `{const ${xs}=get(${sc},${JSON.stringify(n.path)});if(Array.isArray(${xs})){const ${fr}=Object.create(${sc});const ${lp}={index:1,first:true,last:false,length:${xs}.length};for(let ${k}=0;${k}<${xs}.length;${k}++){${fr}[${JSON.stringify(n.name)}]=${xs}[${k}];${fr}.loop=${lp};${lp}.index=${k}+1;${lp}.first=${k}===0;${lp}.last=${k}===${xs}.length-1;${gen(n.body, fr)}}}}`;
      } else if (n.kind === 'include') {
        const u = uid++;
        code += `{const _t${u}=T.get(${JSON.stringify(n.name)});if(_t${u}!==undefined&&D<8)out+=_t${u}(${sc},T,D+1,esc,textOf,get,truthy);}`;
      }
    }
    return code;
  }
  const body = `let out='';${gen(nodes, 'sc')}return out;`;
  return new Function('sc', 'T', 'D', 'esc', 'textOf', 'get', 'truthy', body);
}

// ---- Build ----
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  return resolveParts(parts, rel);
}
function resolveParts(parts, rel) {
  parts = parts.slice();
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

export function run(input) {
  const templates = new Map();
  const report = [];
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try { templates.set(name, parseTemplate(name, input.templates[name])); }
    catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const base = input.site.base_url.replace(/\/+$/, '');
  const output = {};
  const broken = new Set();

  // 1. sources, sorted by path (input is not reused after a run)
  const files = input.files.sort((x, y) => byCodeUnits(x.path, y.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) {
      const content = f.content;
      sources.push({ path: f.path, text: content.indexOf('\r') === -1 ? content : content.replace(/\r\n?/g, '\n') });
    } else statics.push({ path: f.path, content: f.content });
  }

  // 2. front matter
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) { report.push(`refused ${s.path}: ${fm.error}`); continue; }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    let own;
    for (const d of RESERVED) if (d !== 'posts' && s.path.startsWith(`${d}/`)) { own = d; break; }
    if (own !== undefined) { report.push(`refused ${s.path}: ${own}/ is the generator's own`); continue; }
    if (s.post && !Object.hasOwn(s.data, 'date')) { report.push(`refused ${s.path}: a post needs a date`); continue; }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) { report.push(`refused ${s.path}: layout "${layout}" is no template that parses`); continue; }
    s.layout = layout;
    if (s.data.draft === true) { report.push(`draft ${s.path}`); continue; }
    kept.push(s);
  }

  // 3. permalinks
  const taken = new Map();
  const bySource = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) { set = new Set(dir === '' ? RESERVED : []); taken.set(dir, set); }
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), set);
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // 4. markdown
  const staticPaths = new Set(statics.map((f) => f.path));
  for (const s of kept) {
    const dir = dirOf(s.path);
    const dirParts = dir === '' ? [] : dir.split('/');
    const env = {
      link: (target) => {
        const c0 = target.charCodeAt(0);
        if (c0 === 47 || c0 === 35) return target;
        if ((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122)) {
          let j = 1;
          while (j < target.length) {
            const c = target.charCodeAt(j);
            if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 43 || c === 45 || c === 46) j++;
            else break;
          }
          if (j < target.length && target.charCodeAt(j) === 58) return target;
        }
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        const path = rel === '' ? null : resolveParts(dirParts, rel);
        if (path !== null && bySource.has(path)) return `${bySource.get(path).url}${frag}`;
        if (path !== null && staticPaths.has(path)) return `${base}/${path}${frag}`;
        broken.add(`broken-link ${s.path} -> ${target}`);
        return target;
      },
    };
    const md = renderMarkdown(s.body, env);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
    s.reading = Math.max(1, Math.ceil(wordsOf(s.body) / 200));
  }

  // 5. collections
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // 6. tags
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of (s.data.tags ?? [])) {
      const slug = slugify(name);
      if (!seen.has(slug)) { seen.add(slug); out.push(name); }
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name);
      let tag = bySlug.get(slug);
      if (tag === undefined) { tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] }; bySlug.set(slug, tag); }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) if (!s.post) s.tagRefs = ownTags(s).map((name) => bySlug.get(slugify(name)) ?? { name, slug: slugify(name), url: '', posts: [] });
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // 7. layouts
  const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) });
  const cardOf = (s) => ({
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: s.reading,
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  });
  const cards = new Map(posts.map((p) => [p, cardOf(p)]));
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const ctx = { templates, escape: esc };
  // Templates whose output depends only on site/tags/recent (same for every
  // render in a case) and on include depth: render once per (name, depth).
  const constantSet = new Set(templates.keys());
  const isConst = (list, bound, set) => {
    for (const n of list) {
      if (n.kind === 'var' || n.kind === 'raw') {
        if (!bound.has(n.path[0]) && n.path[0] !== 'site' && n.path[0] !== 'tags' && n.path[0] !== 'recent') return false;
      } else if (n.kind === 'if') {
        if (!bound.has(n.path[0]) && n.path[0] !== 'site' && n.path[0] !== 'tags' && n.path[0] !== 'recent') return false;
        if (!isConst(n.then, bound, set)) return false;
        if (n.else !== null && !isConst(n.else, bound, set)) return false;
      } else if (n.kind === 'for') {
        if (!bound.has(n.path[0]) && n.path[0] !== 'site' && n.path[0] !== 'tags' && n.path[0] !== 'recent') return false;
        const b2 = new Set(bound); b2.add(n.name); b2.add('loop');
        if (!isConst(n.body, b2, set)) return false;
      } else if (n.kind === 'include') {
        if (!set.has(n.name)) return false;
      }
    }
    return true;
  };
  let changed = true;
  while (changed) {
    changed = false;
    for (const [name, nodes] of templates) {
      if (constantSet.has(name) && !isConst(nodes, new Set(), constantSet)) { constantSet.delete(name); changed = true; }
    }
  }
  const constCache = new Map();
  const compiled = new Map();
  for (const [name, nodes] of templates) {
    try {
      let fn = compileTemplate(nodes);
      if (constantSet.has(name)) {
        const orig = fn;
        fn = (sc, T, D, e2, t2, g2, tr2) => {
          const key = `${name}\0${D}`;
          const hit = constCache.get(key);
          if (hit !== undefined) return hit;
          const s = orig(sc, T, D, e2, t2, g2, tr2);
          constCache.set(key, s);
          return s;
        };
      }
      compiled.set(name, fn);
    } catch { /* interpreter fallback */ }
  }
  const render = (name, vars) => {
    const nodes = templates.get(name);
    if (nodes === undefined) return null;
    const scope = Object.create(null);
    scope.site = site; scope.tags = allTags; scope.recent = recent;
    for (const k of Object.keys(vars)) scope[k] = vars[k];
    const fn = compiled.get(name);
    if (fn !== undefined) return fn(scope, compiled, 0, esc, textOf, lookup, truthy);
    return renderNodes(nodes, scope, ctx, 0);
  };
  for (const s of kept) {
    const card = s.post ? cards.get(s) : cardOf(s);
    const page = {
      ...card,
      slug: s.slug,
      content: s.html,
      toc: s.toc,
      newer: linkOf(s.newer ?? null),
      older: linkOf(s.older ?? null),
      is_post: s.post,
    };
    output[`${s.outDir}/index.html`] = render(s.layout, { page });
  }
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', { tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) } });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // 8. report
  const lines = [...report, ...broken].sort(byCodeUnits);
  const pageCount = kept.filter((s) => !s.post).length;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = `${lines.join('\n')}\n`;
  return output;
}
