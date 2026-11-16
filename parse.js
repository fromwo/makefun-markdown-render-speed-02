// A fast, dependency-free CommonMark 0.31.2 + GFM markdown renderer.
//
// Written from scratch for the make.fun markdown-render-speed-02 competition.
// It returns, for any input string, the same HTML that marked 18.1.3 renders
// with its defaults (gfm on, breaks off, pedantic off). The behaviour was
// pinned down by reading the CommonMark and GFM specs and by probing the
// reference implementation on the kit's practice cases; the code, its
// structure and its wording are my own.
//
// No state is kept between calls: every parse() call is independent.

const PUNCT_RE = /[\p{P}\p{S}]/u;
const PUNCT_SPACE_RE = /[\s\p{P}\p{S}]/u;
const NOT_PUNCT_SPACE_RE = /[^\s\p{P}\p{S}]/u;
const ALNUM_RE = /[\p{L}\p{N}]/u;
const ENTITY_VALID_RE = /^(?:#\d{1,7}|#[Xx][0-9A-Fa-f]{1,6}|\w+);/;
const NUMERIC_REF_RE = /&#(?:(\d{1,7})|[Xx]([0-9A-Fa-f]{1,6}));/g;
const BLOCK_TAGS =
  'address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul';
const BLOCK_TAG_RE = new RegExp(`^(?:${BLOCK_TAGS})$`, 'i');

// ---------------------------------------------------------------------------
// Small character helpers
// ---------------------------------------------------------------------------

function isSpace(ch) {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f' || ch === '\v';
}
function isPunct(ch) {
  return ch !== undefined && ch !== '' && PUNCT_RE.test(ch);
}
// ASCII punctuation only (marked's inline escape token Ye) — defined above
// as isAsciiPunct; the inline escape scanner uses it, not the Unicode
// isPunct (a backslash before a non-ASCII punctuation mark like « stays).
function isPunctSpace(ch) {
  return ch !== undefined && ch !== '' && PUNCT_SPACE_RE.test(ch);
}
function isNotPunctSpace(ch) {
  return ch !== undefined && ch !== '' && NOT_PUNCT_SPACE_RE.test(ch);
}
function isAlnum(ch) {
  return ch !== undefined && ch !== '' && ALNUM_RE.test(ch);
}
function isAsciiPunct(ch) {
  if (!ch) return false;
  const c = ch.charCodeAt(0);
  return (
    (c >= 33 && c <= 47) || (c >= 58 && c <= 64) || (c >= 91 && c <= 96) || (c >= 123 && c <= 126)
  );
}

// ---------------------------------------------------------------------------
// Escaping and entity handling (mirrors marked's escape / unescape rules)
// ---------------------------------------------------------------------------

const ESCAPE_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

function escapeEncode(s) {
  // Escape every & < > " '.
  let out = '';
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const e = ESCAPE_MAP[s[i]];
    if (e !== undefined) {
      out += s.slice(start, i) + e;
      start = i + 1;
    }
  }
  return start === 0 ? s : out + s.slice(start);
}

function escapeNoEncode(s) {
  // Escape < > " ' always, and & only when it does not start a valid
  // character reference (&#123; / &#xAB; / &name;).
  let out = '';
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '&') {
      if (ENTITY_VALID_RE.test(s.slice(i + 1))) continue;
      out += s.slice(start, i) + '&amp;';
      start = i + 1;
    } else {
      const e = ESCAPE_MAP[ch];
      if (e !== undefined && ch !== '&') {
        out += s.slice(start, i) + e;
        start = i + 1;
      }
    }
  }
  return start === 0 ? s : out + s.slice(start);
}

function decodeNumeric(s) {
  // Decode numeric character references only (named entities pass through
  // untouched, exactly as marked does). 0, surrogates and values above the
  // Unicode maximum become U+FFFD; 38 becomes &amp; directly so a following
  // word cannot accidentally form an entity.
  if (s.indexOf('&#') === -1) return s;
  NUMERIC_REF_RE.lastIndex = 0;
  return s.replace(NUMERIC_REF_RE, (_m, dec, hex) => {
    const n = dec !== undefined ? parseInt(dec, 10) : parseInt(hex, 16);
    if (n === 0 || n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff)) return '\uFFFD';
    if (n === 38) return '&amp;';
    return String.fromCodePoint(n);
  });
}

function unescapePunct(s) {
  // Turn \X (X an ASCII or Unicode punctuation/symbol character) into X.
  if (s.indexOf('\\') === -1) return s;
  let out = '';
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && i + 1 < s.length && isPunct(s[i + 1])) {
      out += s.slice(start, i) + s[i + 1];
      i++;
      start = i + 1;
    }
  }
  return start === 0 ? s : out + s.slice(start);
}

function cleanHref(raw) {
  // encodeURI, keeping %25 sequences intact (marked's encodeURI + %25 fix).
  // Returns null when encodeURI throws (e.g. a lone surrogate).
  try {
    return encodeURI(raw).replace(/%25/g, '%');
  } catch {
    return null;
  }
}

function labelKey(label) {
  // Link-label normalisation: trim, collapse whitespace, case-fold.
  return label.trim().replace(/\s+/g, ' ').toLowerCase().toUpperCase().toLowerCase();
}

// ---------------------------------------------------------------------------
// Lines with tab-aware columns (the CommonMark "partially consumed tab" model)
// ---------------------------------------------------------------------------
//
// A line keeps the raw string plus a cursor (index, virtual column, and the
// number of spaces left over from a tab that was only partly consumed).
// Tabs are never expanded in the text itself: a tab after the consumed
// prefix stays a literal tab, which is what indented code blocks need.

function makeLine(s) {
  return { s, i: 0, col: 0, pend: 0 };
}
function cloneLine(l) {
  return { s: l.s, i: l.i, col: l.col, pend: l.pend };
}
function lineRest(l) {
  return l.pend > 0 ? ' '.repeat(l.pend) + l.s.slice(l.i + 1) : l.s.slice(l.i);
}
function linePeek(l) {
  return l.pend > 0 ? ' ' : l.i < l.s.length ? l.s[l.i] : '';
}
function lineAdvance(l, n) {
  while (n > 0) {
    if (l.pend > 0) {
      const take = Math.min(l.pend, n);
      l.pend -= take;
      l.col += take;
      n -= take;
      if (n === 0) return;
    }
    if (l.i >= l.s.length) return;
    const ch = l.s[l.i];
    if (ch === '\t') {
      const w = 4 - (l.col % 4);
      if (n < w) {
        l.pend = w - n;
        l.col += n;
        return;
      }
      l.col += w;
      l.i++;
      n -= w;
    } else {
      l.col++;
      l.i++;
      n--;
    }
  }
}
function lineIndent(l) {
  // Columns of leading spaces/tabs from the cursor, without consuming.
  let col = l.col;
  let pend = l.pend;
  let i = l.i;
  if (pend > 0) {
    col += pend;
    i++;
  }
  while (i < l.s.length) {
    const ch = l.s[i];
    if (ch === ' ') col++;
    else if (ch === '\t') col += 4 - (col % 4);
    else break;
    i++;
  }
  return col - l.col;
}
function lineBlank(l) {
  let i = l.i;
  if (l.pend > 0) i++;
  while (i < l.s.length) {
    const ch = l.s[i];
    if (ch !== ' ' && ch !== '\t') return false;
    i++;
  }
  return true;
}
function geText(text) {
  // marked's trailing-blank-line trim for html / indented-code tokens: drop
  // trailing blank lines when there are two or more of them, otherwise keep
  // the text (including a single trailing newline) as-is.
  const parts = text.split('\n');
  let t = parts.length - 1;
  while (t >= 0 && /^[ \t]*$/.test(parts[t])) t--;
  if (parts.length - t <= 2) return text;
  return parts.slice(0, t + 1).join('\n');
}

// ---------------------------------------------------------------------------
// Inline parsing
// ---------------------------------------------------------------------------
//
// The scanner walks the text once and builds a node list. Emphasis and
// strong emphasis are resolved afterwards from a delimiter stack (the
// CommonMark algorithm); links are formed while scanning, using a bracket
// stack; strikethrough is matched immediately, with a counter for nested
// runs, the way marked does it.
//
// Node kinds:
//   t  text            {s, raw?}          raw: inside <pre>/<code>/<kbd>/<script>
//   c  code span       {s}
//   e  emphasis        {c}
//   s  strong          {c}
//   d  strikethrough   {c}
//   l  link            {href, title, c, auto}
//   i  image           {href, title, c}
//   h  raw html        {s}
//   b  hard break
//   n  soft break
//   dm delimiter * _  {ch, len, canOpen, canClose}
//   bk bracket [       {img, active, rawSave}

// Marked's link / reflink / nolink label regex (its `re`): a link's text
// must be partitionable into nested [...] groups, escapes, code spans
// (`+(?!`)[^`]*?`+(?!`) or a trailing ``+(?=]) ), or single chars
// other than [ ] \ `. A code span containing a backtick (`` `` a ` b `` ``)
// cannot be partitioned, so such a link is not formed at all.
const LABEL_RE =
  /^(?:\[(?:\[(?:\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^\[\]\\`])*\]$/;

// Whether the raw link text between '[' and ']' can be a link label.
function labelOk(s, bkPos, closeIdx) {
  return LABEL_RE.test(s.slice(bkPos + 1, closeIdx) + ']');
}

// Marked's emStrong lookahead masking (its Lexer #n): before scanning
// for emphasis, marked rewrites the inline source with same-length
// placeholders -- code spans keep their backticks but lose inner
// backticks, links / code spans / HTML tags become "[aaa...]". A `*` or
// `_` run that falls inside a masked region is invisible to the
// emphasis scan, so it can neither open nor close emphasis -- even
// when our own scanner does not see a code span or link there. The
// classic case is a fake code span `` ``url` `` whose opening `` `` ``
// pairs with a later `` `` `` (Ot), letting blockSkip mask a whole
// "[docs each ``url`](...) ... _issue table_ `` a ` b ``" stretch and
// hide the `_` pair that CommonMark would emphasise. The mask is
// length-preserving, so positions in the masked text are positions in
// the source.
const MASK_PUNCT_RE = /[\p{P}\p{S}]/u;
const MASK_CODE_RE = new RegExp(
  "(`+)(?:[^`]|[^`][\\s\\S]*?[^`])\\1(?!`)|`+|\\\\(punct)".replace(
    /punct/g,
    MASK_PUNCT_RE.source,
  ),
  "gu",
);
const MASK_SKIP_RE = new RegExp(
  "\\[(?:[^\\[\\]`]|(?<a>`+)[^`]+\\k<a>(?!`))*?\\]\\((?:\\\\[\\s\\S]|[^\\\\\\(\\\\)]|\\((?:\\\\[\\s\\S]|[^\\\\\\(\\)])*\\))*\\)|(?<!`)(?<b>`+)[^`]+\\k<b>(?!`)|<(?! )[^<>]*?>",
  "g",
);
function emStrongMask(s) {
  let t = s;
  t = t.replace(MASK_CODE_RE, (n, run, esc) =>
    esc
      ? "+".repeat(n.length)
      : run
        ? run + n.slice(run.length, -run.length).replace(/`/g, "+") + run
        : n,
  );
  t = t.replace(MASK_SKIP_RE, (n, _a, b) => {
    const o = b ? b.length : 0;
    return n.slice(0, o) + "[" + "a".repeat(n.length - o - 2) + "]";
  });
  return t;
}

// Disable every delimiter run in `delims` whose first character is
// masked out in `masked` (same-length mask of the source the delimiters
// were scanned from). `base` is the source offset of the masked text.
function hideMaskedDelims(delims, masked, base) {
  for (const d of delims) {
    if (d.k === "dm" && masked[d.pos - base] !== d.ch) {
      d.canOpen = false;
      d.canClose = false;
    }
  }
}

const EMAIL_RE = /^[A-Za-z0-9._+\-]+@[A-Za-z0-9\-_]+(?:\.[A-Za-z0-9\-_]*[A-Za-z0-9])+(?![\w\-])/;
const EMAIL_RE_NO_LOOK = /^[A-Za-z0-9._+\-]+@[A-Za-z0-9\-_]+(?:\.[A-Za-z0-9\-_]*[A-Za-z0-9])+/;
const EMAIL_LOCAL = /[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]/;
const SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.\-]{1,31}:\/\//;
const WWW_PREFIX = 'www.';
const AUTOLINK_RE = /^<([A-Za-z][A-Za-z0-9+.\-]{1,31}:[^\s\x00-\x1f<>]*)>/;
const AUTOLINK_EMAIL_RE =
  /^<([A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+)>/;
const TAG_ATTR_RE =
  /\s+[A-Za-z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?/y;

function parseTagAt(s, i) {
  // Parse an inline HTML construct starting at s[i] === '<'.
  // Returns the matched raw text, or null when it is not a valid tag.
  if (s[i + 1] === '!') {
    if (s.startsWith('<!--', i)) {
      // Abruptly closed comments: <!--> and <!---> end at the '>'.
      if (s[i + 4] === '>') return s.slice(i, i + 5);
      if (s[i + 4] === '-' && s[i + 5] === '>') return s.slice(i, i + 6);
      const end = s.indexOf('-->', i + 4);
      if (end === -1) return null;
      return s.slice(i, end + 3);
    }
    if (s.startsWith('<![CDATA[', i)) {
      const end = s.indexOf(']]>', i + 9);
      if (end === -1) return null;
      return s.slice(i, end + 3);
    }
    // Declaration: <! + letter, up to the next '>'.
    if (i + 2 < s.length && /[A-Za-z]/.test(s[i + 2])) {
      const end = s.indexOf('>', i + 2);
      if (end === -1) return null;
      return s.slice(i, end + 1);
    }
    return null;
  }
  if (s[i + 1] === '?') {
    const end = s.indexOf('?>', i + 2);
    if (end === -1) return null;
    return s.slice(i, end + 2);
  }
  if (s[i + 1] === '/') {
    const m = /^<\/[A-Za-z][A-Za-z0-9-]*\s*>/.exec(s.slice(i));
    return m ? m[0] : null;
  }
  if (/[A-Za-z]/.test(s[i + 1] || '')) {
    let j = i + 1;
    while (j < s.length && /[A-Za-z0-9-]/.test(s[j])) j++;
    // Attributes, each well-formed, then an optional '/' and '>'.
    while (true) {
      TAG_ATTR_RE.lastIndex = j;
      const m = TAG_ATTR_RE.exec(s);
      if (!m) break;
      j = TAG_ATTR_RE.lastIndex;
    }
    let k = j;
    while (s[k] === ' ' || s[k] === '\t' || s[k] === '\n') k++;
    // A self-closing '/' must be immediately before the '>'.
    if (s[k] === '/') {
      if (s[k + 1] === '>') return s.slice(i, k + 2);
      return null;
    }
    if (s[k] === '>') return s.slice(i, k + 1);
    return null;
  }
  return null;
}

function flanking(s, i, n) {
  const before = i > 0 ? s[i - 1] : '';
  const after = i + n < s.length ? s[i + n] : '';
  const beforeSpace = before === '' || isSpace(before) || /\s/.test(before);
  const afterSpace = after === '' || isSpace(after) || /\s/.test(after);
  const beforePunct = isPunct(before);
  const afterPunct = isPunct(after);
  const left = !afterSpace && (!afterPunct || beforeSpace || beforePunct);
  const right = !beforeSpace && (!beforePunct || afterSpace || afterPunct);
  return { left, right, before, after, beforePunct, afterPunct };
}

function countBackslashes(s, i) {
  let n = 0;
  for (let j = i - 1; j >= 0 && s[j] === '\\'; j--) n++;
  return n;
}

// Try to match a strikethrough starting at s[i] (a run of 1-2 tildes).
// Returns {end, content} where content is the raw text between the runs,
// or null. The closer search counts nested runs, as marked does.
function matchDel(s, i, prevChar) {
  let run = 0;
  while (s[i + run] === '~') run++;
  if (run >= 3) return null;
  const o = run;
  const afterCh = s[i + o];
  if (afterCh === undefined || afterCh === '~' || isSpace(afterCh)) return null;
  const afterIsPunct = isPunct(afterCh);
  if (afterIsPunct && prevChar !== '' && !isPunct(prevChar)) return null;
  // Scan for a closer run of exactly `o` tildes.
  let p = o;
  let j = i + o;
  while (j < s.length) {
    if (s[j] !== '~') {
      j++;
      continue;
    }
    // An escaped tilde is literal text, not part of a run: skip it so
    // the remaining run is measured on its own (e.g. `\~~~` holds a
    // two-tilde closer after the escaped one).
    if (countBackslashes(s, j) % 2 === 1) {
      j++;
      continue;
    }
    let len = 0;
    while (s[j + len] === '~') len++;
    if (len !== o) {
      j += len;
      continue;
    }
    const pb = j > 0 ? s[j - 1] : '';
    const pa = j + len < s.length ? s[j + len] : '';
    const pbPunctSpace = pb !== '' && isPunctSpace(pb);
    const pbNot = isNotPunctSpace(pb);
    const paPunctSpace = pa === '' || isPunctSpace(pa);
    const paNot = isNotPunctSpace(pa);
    const openerLike =
      (pbPunctSpace && paNot) || ((pb === ' ' || pb === '\t' || pb === '\n') && isPunct(pa));
    const closerLike =
      (isPunct(pb) && (pa === '' || isSpace(pa))) ||
      (pbNot && paPunctSpace) ||
      (isPunct(pb) && isPunct(pa)) ||
      (pbNot && paNot);
    if (openerLike && !closerLike) {
      p += len;
      j += len;
      continue;
    }
    if (!closerLike) {
      j += len;
      continue;
    }
    p -= len;
    if (p > 0) {
      j += len;
      continue;
    }
    // The char before the closer must not be a space or an (unescaped)
    // tilde, and the closer must not be escaped. A preceding escaped
    // tilde is literal text, so it does not extend the run.
    if (pb === '' || isSpace(pb) || (pb === '~' && countBackslashes(s, j - 1) % 2 === 0)) {
      j += len;
      continue;
    }
    if (countBackslashes(s, j) % 2 === 1) {
      j += len;
      continue;
    }
    return { end: j + len, content: s.slice(i + o, j) };
  }
  return null;
}

// Find the end of a code span: a run of exactly n backticks.
function findCodeEnd(s, start, n) {
  let j = start;
  while (j < s.length) {
    if (s[j] !== '`') {
      j++;
      continue;
    }
    let len = 0;
    while (s[j + len] === '`') len++;
    if (len === n) return j;
    j += len;
  }
  return -1;
}

// Parse a link destination + optional title starting at s[i] (the position
// right after the opening '('). Returns {href, title, end, angle} with end
// just past the closing ')', or null. href is raw (escapes intact); the
// caller unescapes and encodes it.
function parseLinkTarget(s, i) {
  let p = i;
  while (p < s.length && (s[p] === ' ' || s[p] === '\t' || s[p] === '\n')) p++;
  if (s[p] === '<') {
    // Angle destination: <...> with escapes, no newline, '<' or '>' inside.
    let q = p + 1;
    let ok = false;
    while (q < s.length) {
      const ch = s[q];
      if (ch === '\\' && q + 1 < s.length) {
        q += 2;
        continue;
      }
      if (ch === '>') {
        ok = true;
        break;
      }
      if (ch === '\n' || ch === '<') break;
      q++;
    }
    if (!ok) return null;
    // The closing '>' must not be escaped (odd run of backslashes).
    if (countBackslashes(s, q) % 2 === 1) return null;
    const href = s.slice(p + 1, q);
    const t = parseTitleAndClose(s, q + 1);
    if (!t) return null;
    return { href, title: t.title, end: t.end, angle: true };
  }
  // Bare destination: maximal run of non-space, non-control characters.
  // The regex engine takes the longest href that leaves a ')' (or a title
  // and then a ')'), so try href lengths from longest to shortest.
  let q = p;
  while (q < s.length) {
    const c = s.charCodeAt(q);
    if (c === 32 || c === 9 || c === 10 || c < 32) break;
    q++;
  }
  const run = s.slice(p, q);
  for (let k = run.length; k >= 0; k--) {
    const t = parseTitleAndClose(s, p + k);
    if (!t) continue;
    let cand = run.slice(0, k);
    const bal = parenBalance(cand);
    if (bal === -2) return null;
    if (bal >= 0) {
      // Unmatched ')': truncate at it; that ')' becomes the closer, the
      // title is dropped and the link ends right after it.
      return { href: cand.slice(0, bal), title: null, end: p + bal + 1, angle: false };
    }
    return { href: cand, title: t.title, end: t.end, angle: false };
  }
  return null;
}

function parenBalance(href) {
  // -1 balanced (or no parens), -2 more '(' than ')', otherwise the index
  // of the first ')' that closes below zero.
  let depth = 0;
  let has = false;
  for (let i = 0; i < href.length; i++) {
    const ch = href[i];
    if (ch === '\\') {
      i++;
      continue;
    }
    if (ch === '(') {
      depth++;
      has = true;
    } else if (ch === ')') {
      has = true;
      depth--;
      if (depth < 0) return i;
    }
  }
  if (!has) return -1;
  return depth > 0 ? -2 : -1;
}

// Parse [whitespace] [title] [whitespace] ')' starting at s[p].
// Returns {title, end} or null. A title is "..." or '...' or (...).
function parseTitleAndClose(s, p) {
  let q = p;
  let sawSpace = false;
  // Whitespace before an optional title: spaces/tabs, optionally one
  // newline, or a newline.
  let r = q;
  while (r < s.length && (s[r] === ' ' || s[r] === '\t')) r++;
  if (r < s.length && s[r] === '\n') {
    r++;
    while (r < s.length && (s[r] === ' ' || s[r] === '\t')) r++;
    sawSpace = true;
  } else if (r > q) {
    sawSpace = true;
  }
  if (sawSpace && r < s.length && (s[r] === '"' || s[r] === "'" || s[r] === '(')) {
    const open = s[r];
    const close = open === '(' ? ')' : open;
    let t = r + 1;
    let ok = false;
    while (t < s.length) {
      const ch = s[t];
      if (ch === '\\' && t + 1 < s.length) {
        t += 2;
        continue;
      }
      if (ch === close) {
        ok = true;
        break;
      }
      t++;
    }
    if (ok) {
      // After the title: spaces/newlines, then ')'.
      let u = t + 1;
      while (u < s.length && (s[u] === ' ' || s[u] === '\t' || s[u] === '\n')) u++;
      if (s[u] === ')') {
        return { title: s.slice(r + 1, t), end: u + 1 };
      }
    }
    // A malformed title is not a title: fall through to the no-title case.
  }
  // No title: spaces/newlines then ')'.
  let u = q;
  while (u < s.length && (s[u] === ' ' || s[u] === '\t' || s[u] === '\n')) u++;
  if (s[u] === ')') return { title: null, end: u + 1 };
  return null;
}

// Parse a reference label starting at s[i] === '[' and return the label
// text (raw, between the brackets) and the index just past ']', or null.
// Brackets must balance; code spans and escapes do not count.
function parseBracketLabel(s, i) {
  let depth = 0;
  let j = i;
  while (j < s.length) {
    const ch = s[j];
    if (ch === '\\' && j + 1 < s.length) {
      j += 2;
      continue;
    }
    if (ch === '`') {
      let n = 0;
      while (s[j + n] === '`') n++;
      const end = findCodeEnd(s, j + n, n);
      if (end === -1) {
        j += n;
        continue;
      }
      j = end + n;
      continue;
    }
    if (ch === '[') {
      depth++;
      j++;
      continue;
    }
    if (ch === ']') {
      depth--;
      if (depth === 0) return { label: s.slice(i + 1, j), end: j + 1 };
      j++;
      continue;
    }
    j++;
  }
  return null;
}

// Parse a reference label (the [ref] after a link text): escapes, newlines
// that are not blank lines, no unescaped [ or ].
function parseRefLabel(s, i) {
  // s[i] === '['
  let j = i + 1;
  let start = j;
  while (j < s.length) {
    const ch = s[j];
    if (ch === '\\' && j + 1 < s.length) {
      j += 2;
      continue;
    }
    if (ch === '\n') {
      // A newline is allowed unless a blank line follows.
      let k = j + 1;
      while (k < s.length && (s[k] === ' ' || s[k] === '\t')) k++;
      if (s[k] === '\n' || k >= s.length) break;
      j++;
      continue;
    }
    if (ch === '[' || ch === ']') break;
    j++;
  }
  if (s[j] !== ']') return null;
  const label = s.slice(start, j);
  if (label.trim() === '') return null;
  return { label, end: j + 1 };
}

// `m` contribution of one delimiter run in marked's emStrong scan,
// for an outer opener of run length `y`. Opener-like runs (canOpen
// only, RDelim groups 3/4) add their length; closer-like runs (canClose
// only, groups 1/2) subtract it; both-flanking runs (groups 5/6)
// subtract it unless skipped by the rule of 3. Skipped closers go to
// marked's separate `f` counter and do not inflate `m`.
function runContribution(len, canOpen, canClose, y) {
  if (canOpen && !canClose) return len;
  if (!canOpen && canClose) return -len;
  if (canOpen && canClose) {
    return y % 3 !== 0 && (y + len) % 3 === 0 ? 0 : -len;
  }
  return 0;
}

// Whether any delimiter run of char `ch` in `nodes` is both-flanking
// (can open and can close), recursing into resolved emphasis pairs the
// way marked's RDelim scan sees them (runs of this char inside an
// opposite-char strong pair are skipped by that scan, so they do not
// count here either).
function hasBothFlankingRun(nodes, ch) {
  for (const nd of nodes) {
    if (nd.k === 'dm') {
      if (nd.ch === ch && nd.canOpen && nd.canClose) return true;
    } else if (nd.k === 'e' || nd.k === 's') {
      if (nd.ch === ch) {
        if (nd.oOpen && nd.oClose) return true;
        if (nd.cOpen && nd.cClose) return true;
      }
      if (!(nd.k === 's' && nd.ch !== ch) && hasBothFlankingRun(nd.c, ch)) return true;
    }
  }
  return false;
}

// Effective length of a delimiter run: the leftover length plus the
// part an already-resolved pair took from the same raw run (that
// pair's oLeft/cLeft). The pairs that took from the run can be nested
// inside one another (an em inside a strong sharing the same closer
// run), so recurse into pair children.
function effRunLen(node, between, side) {
  let n = node.len;
  const walk = (nodes) => {
    for (const nd of nodes) {
      if (nd.k === 'e' || nd.k === 's') {
        if (side === 'o' && nd.oLeft === node) n += nd.oLen;
        if (side === 'c' && nd.cLeft === node) n += nd.cLen;
        walk(nd.c);
      }
    }
  };
  walk(between);
  return n;
}

// Total `m` contribution of the delimiter runs of char `ch` in `nodes`
// for an outer opener of run length `y` (recursing into resolved
// emphasis pairs, whose own opener and closer runs are also seen by the
// scan). Runs of another char are invisible to this opener's emStrong
// (its RDelim regex only matches its own char).
// Returns {contrib, f}: `contrib` is the net `m` change, `f` the total
// length of both-flanking runs skipped by the rule of 3 (they do not
// change `m` but inflate marked's `b_used`). A resolved pair
// contributes its opener and closer runs as raw runs, except the run
// the outer opener/closer itself is the leftover of: that run's length
// is already in the opener/closer effective length, so it must not be
// counted again (the run is split across the pair and its leftover,
// and the rule of 3 must see the whole run at once).
function markedScan(nodes, y, ch, opener, closer) {
  let contrib = 0;
  let f = 0;
  for (const nd of nodes) {
    if (nd.k === 'dm') {
      if (nd.ch === ch) {
        contrib += runContribution(nd.len, nd.canOpen, nd.canClose, y);
        if (nd.canOpen && nd.canClose && y % 3 !== 0 && (y + nd.len) % 3 === 0) {
          f += nd.len;
        }
      }
    } else if (nd.k === 'e' || nd.k === 's') {
      if (nd.ch === ch) {
        if (nd.oLeft !== opener) {
          contrib += runContribution(nd.oLen, nd.oOpen, nd.oClose, y);
          if (nd.oOpen && nd.oClose && y % 3 !== 0 && (y + nd.oLen) % 3 === 0) {
            f += nd.oLen;
          }
        }
        if (nd.cLeft !== closer) {
          contrib += runContribution(nd.cLen, nd.cOpen, nd.cClose, y);
          if (nd.cOpen && nd.cClose && y % 3 !== 0 && (y + nd.cLen) % 3 === 0) {
            f += nd.cLen;
          }
        }
      }
      // Marked's RDelim skips runs of this char inside an opposite-char
      // strong pair (`*` inside `__...__`, `_` inside `**...**`), so
      // do not recurse into those children.
      if (!(nd.k === 's' && nd.ch !== ch)) {
        const sub = markedScan(nd.c, y, ch, opener, closer);
        contrib += sub.contrib;
        f += sub.f;
      }
    }
  }
  return { contrib, f };
}

// Shared per-candidate setup for the two passes in resolveEmphasis:
// the nodes between opener and closer, the runs' effective lengths,
// and the rule-of-3 block. Returns null when this opener cannot pair
// with this closer at all.
function gateSetup(nodes, opener, closer) {
  const oiNode = nodes.indexOf(opener);
  const ciNode = nodes.indexOf(closer);
  if (oiNode < 0 || ciNode <= oiNode) return null;
  const between = nodes.slice(oiNode + 1, ciNode);
  const effO = effRunLen(opener, between, 'o');
  const effC = effRunLen(closer, between, 'c');
  const bothWays =
    (opener.canOpen && opener.canClose) || (closer.canOpen && closer.canClose);
  if (
    bothWays &&
    (effO + effC) % 3 === 0 &&
    !(effO % 3 === 0 && effC % 3 === 0)
  ) {
    return null;
  }
  return { between, effO, effC };
}

// Whether an earlier opener (before index `k` in `delims`) passes the
// normal gate for this closer and would consume the closer run
// entirely, leaving nothing for the opener at `k`. Marked tries
// openers left to right, so such an earlier opener takes the closer;
// a nearer opener must not steal it (e.g. `**a *b **c**d* e**`: the
// `**` opener takes the final `**` as a strong, the inner `*` stays
// literal). When the earlier opener only takes part of the run, the
// nearer opener still pairs first (inner-first), e.g. `*a *b **c****`.
function earlierTakesCloser(nodes, delims, closer, k) {
  for (let j = 0; j < k; j++) {
    const e = delims[j];
    if (e.ch !== closer.ch || !e.canOpen || e.len === 0) continue;
    const s = gateSetup(nodes, e, closer);
    if (!s) continue;
    const sc = markedScan(s.between, s.effO, e.ch, e, closer);
    if (s.effO + sc.contrib > s.effC) continue;
    const bUsed = Math.min(s.effC, s.effO + sc.contrib + sc.f);
    if (Math.min(s.effO, bUsed) <= 0) continue;
    const cons = e.len >= 2 && closer.len >= 2 ? 2 : 1;
    if (cons >= closer.len) return true;
  }
  return false;
}

function resolveEmphasis(nodes, delims) {
  // The CommonMark delimiter-stack algorithm over one node list.
  let ci = 0;
  while (ci < delims.length) {
    const closer = delims[ci];
    if (!closer.canClose || closer.len === 0) {
      ci++;
      continue;
    }
    let oi = -1;
    let gate = null;
    // Nearest opener first (the stack's inner-first order): an outer
    // pair must not lock inner delimiters inside it before they pair
    // (e.g. `*a *b **c****` forms the inner strong and em first).
    // But when an earlier opener passes the normal gate and would
    // consume the closer run entirely, it takes the closer (marked
    // tries openers left to right), so a nearer opener must not steal
    // it (e.g. `**a *b **c**d* e**` forms the outer strong, not the
    // inner em); see earlierTakesCloser.
    for (let k = ci - 1; k >= 0; k--) {
      const opener = delims[k];
      if (opener.ch !== closer.ch || !opener.canOpen || opener.len === 0) continue;
      const s = gateSetup(nodes, opener, closer);
      if (!s) continue;
      // Marked's emStrong scan from the opener: `m` starts at the
      // opener run length, opener-like runs add to it, closer-like
      // runs subtract, both-flanking runs skipped by the rule of 3 go
      // to `f`. The scan stops at the first run where `m` drops to
      // zero or below; `b_used` is how much of the closer run the scan
      // consumed, `u` how many delimiters the pair takes. Delimiter
      // runs already resolved (or left literal) between this opener
      // and closer therefore change the `m` the closer must satisfy.
      const sc = markedScan(s.between, s.effO, opener.ch, opener, closer);
      const mBefore = s.effO + sc.contrib;
      if (mBefore <= s.effC) {
        const bUsed = Math.min(s.effC, mBefore + sc.f);
        const u = Math.min(s.effO, bUsed);
        if (u > 0 && !earlierTakesCloser(nodes, delims, closer, k)) {
          // The pair kind follows what the runs can still give: two
          // delimiters each when both leftovers have them (strong),
          // one otherwise (em). This is the stack's inner-first
          // order: `***a***` forms the strong first and the em from
          // the leftovers, matching marked's em-over-strong nesting,
          // even though marked's `u` (3, odd) names the outer em.
          const consumption = opener.len >= 2 && closer.len >= 2 ? 2 : 1;
          gate = {
            effO: s.effO,
            effC: s.effC,
            bUsed,
            u,
            consumption,
            viaRetry: false,
            cInner: s.effC - closer.len,
          };
          oi = k;
          break;
        }
      }
      // The opener at full length cannot close here: retry at the
      // reduced length the closer can actually take, mirroring marked
      // trying emStrong at each position of a run (a `**` opener
      // matching a `*` closer with one delimiter, as in `_a __b__c_`).
      // But if a later closer could take the whole run, wait for that
      // one instead (e.g. `**public as *so*other* option html**`
      // skips the lone `*` after `other` and closes on the final `**`).
      const use = s.effO >= 2 && s.effC >= 2 ? 2 : 1;
        // Only wait for the later closer when spending `use` here
        // would leave the opener too short to take it (a `____`
        // opener can serve both an early `__` closer and a later
        // one, but a `**` opener spent on a lone `*` cannot).
        let laterFull = false;
        if (opener.len >= 2 && opener.len - use < 2) {
          for (let q = ci + 1; q < delims.length; q++) {
            const later = delims[q];
            if (later.ch === opener.ch && later.len >= 2 && later.canClose) {
              laterFull = true;
              break;
            }
          }
        }
        if (laterFull) continue;
        // This retry is marked retrying emStrong at the next
        // position of the run after the first attempt failed, so
        // its scan breaks on any both-flanking run it meets (its
        // `o` flag is set: the previous token ended with this
        // delimiter). But when the opener passes the full gate for
        // some later closer, the retry is only a stepping stone
        // toward that later pair (marked's top-level scan pairs
        // the opener with the later closer, e.g. `***a*b***`),
        // not a positional retry, so the break does not apply.
        let laterFullGate = false;
        for (let q = ci + 1; q < delims.length; q++) {
          const later = delims[q];
          if (later.ch !== opener.ch || !later.canClose || later.len === 0) continue;
          const lOi = nodes.indexOf(opener);
          const lCi = nodes.indexOf(later);
          if (lOi < 0 || lCi <= lOi) continue;
          const lBetween = nodes.slice(lOi + 1, lCi);
          const lEffO = effRunLen(opener, lBetween, 'o');
          const lEffC = effRunLen(later, lBetween, 'c');
          const lboth =
            (opener.canOpen && opener.canClose) || (later.canOpen && later.canClose);
          if (
            lboth &&
            (lEffO + lEffC) % 3 === 0 &&
            !(lEffO % 3 === 0 && lEffC % 3 === 0)
          ) {
            continue;
          }
          const lSc = markedScan(lBetween, lEffO, opener.ch, opener, later);
          if (lEffO + lSc.contrib <= lEffC) {
            laterFullGate = true;
            break;
          }
        }
        if (
          !laterFullGate &&
          ((closer.canOpen && closer.canClose) ||
            hasBothFlankingRun(s.between, opener.ch))
        ) {
          continue;
        }
        const scUse = markedScan(s.between, use, opener.ch, opener, closer);
        const mUse = use + scUse.contrib;
        if (mUse > s.effC) continue;
        const bUsedR = Math.min(s.effC, mUse + scUse.f);
        const uR = Math.min(use, bUsedR);
        if (uR <= 0) continue;
        if (earlierTakesCloser(nodes, delims, closer, k)) continue;
        gate = {
          effO: s.effO,
          effC: s.effC,
          bUsed: bUsedR,
          u: uR,
          consumption: Math.min(use, opener.len, closer.len),
          viaRetry: true,
          cInner: s.effC - closer.len,
        };
        oi = k;
        break;
    }
    if (oi < 0) {
      ci++;
      continue;
    }
    const opener = delims[oi];
    const use = gate.consumption;
    const oiNode = nodes.indexOf(opener);
    const ciNode = nodes.indexOf(closer);
    if (oiNode < 0 || ciNode < 0 || ciNode <= oiNode) {
      ci++;
      continue;
    }
    const inner = nodes.slice(oiNode + 1, ciNode);
    // oLen/cLen are the delimiters actually consumed by this pair
    // (`use`), not the runs' full remaining lengths: a `__` opener
    // that spends one `_` on an inner em leaves the other `_` for an
    // outer match, and marked's scan sees two one-delimiter runs.
    // oLeft/cLeft are the leftover delimiter nodes of the opener and
    // closer runs (null when the run was fully consumed). bUsed is how
    // much of the closer run marked's scan consumed, cTotal the closer
    // run's full length, cInner the part of it an inner pair already
    // took; the post-pass below uses them to place an unmatched
    // closer leftover inside or outside this pair.
    const em = {
      k: use === 2 ? 's' : 'e',
      c: inner,
      ch: opener.ch,
      oLen: use,
      oOpen: opener.canOpen,
      oClose: opener.canClose,
      cLen: use,
      cOpen: closer.canOpen,
      cClose: closer.canClose,
      oLeft: opener.len - use > 0 ? opener : null,
      cLeft: closer.len - use > 0 ? closer : null,
      bUsed: gate.bUsed,
      cTotal: gate.effC,
      cInner: gate.cInner,
      viaRetry: gate.viaRetry,
    };
    // Delimiters strictly between opener and closer leave this list:
    // they are now inside the emphasis node and cannot match outside it.
    for (let k = delims.length - 1; k >= 0; k--) {
      const d = delims[k];
      if (d === opener || d === closer) continue;
      const idx = nodes.indexOf(d);
      if (idx > oiNode && idx < ciNode) delims.splice(k, 1);
    }
    opener.len -= use;
    closer.len -= use;
    const replacement = [];
    if (opener.len > 0) replacement.push(opener);
    replacement.push(em);
    if (closer.len > 0) replacement.push(closer);
    nodes.splice(oiNode, ciNode - oiNode + 1, ...replacement);
    const emPos = oiNode + replacement.indexOf(em);
    if (opener.len === 0) delims.splice(delims.indexOf(opener), 1);
    if (closer.len === 0) {
      delims.splice(delims.indexOf(closer), 1);
      ci = delims.findIndex((d) => nodes.indexOf(d) > emPos);
      if (ci < 0) break;
    } else {
      ci = delims.indexOf(closer);
    }
  }
  // Post-pass: a leftover delimiter run that never matched again.
  // Marked's pair raw text spans the whole closer run, so the part of
  // the closer run the scan consumed but the pair itself did not
  // (bUsed minus the pair's own consumption, less what an inner pair
  // already took) belongs inside this pair's inner text; only the part
  // past bUsed stays outside. An opener leftover of a normal-gate pair
  // belongs inside too (its run starts the pair's raw text); a
  // retry-formed pair's raw text starts at the retry position, so its
  // opener leftover stays outside.
  const pairs = nodes.filter((nd) => nd.k === 'e' || nd.k === 's');
  const moved = new Set();
  for (let pi = pairs.length - 1; pi >= 0; pi--) {
    const nd = pairs[pi];
    if (nd.cLeft && !moved.has(nd.cLeft) && delims.includes(nd.cLeft) && nd.cLeft.len > 0) {
      const cl = nd.cLeft;
      const expected = nd.cTotal - nd.cLen - nd.cInner;
      if (cl.len === expected) {
        const inside = Math.max(0, Math.min(cl.len, nd.bUsed - nd.cLen - nd.cInner));
        const outside = cl.len - inside;
        if (inside > 0) nd.c.push({ ...cl, len: inside });
        if (outside > 0) {
          cl.len = outside;
        } else {
          const cIdx = nodes.indexOf(cl);
          if (cIdx >= 0) nodes.splice(cIdx, 1);
        }
        moved.add(cl);
      }
    }
    if (
      nd.oLeft &&
      !moved.has(nd.oLeft) &&
      !nd.viaRetry &&
      delims.includes(nd.oLeft) &&
      nd.oLeft.len > 0
    ) {
      const ol = nd.oLeft;
      const oIdx = nodes.indexOf(ol);
      const pIdx = nodes.indexOf(nd);
      if (oIdx >= 0 && pIdx >= 0 && oIdx < pIdx) {
        nodes.splice(oIdx, 1);
        nd.c.unshift({ ...ol });
        moved.add(ol);
      }
    }
  }
}

function renderNodes(nodes) {
  let out = '';
  for (const node of nodes) out += renderNode(node);
  return out;
}

function renderNode(node) {
  switch (node.k) {
    case 't':
      return node.raw ? node.s : escapeNoEncode(decodeNumeric(node.s));
    case 'c':
      return '<code>' + escapeEncode(node.s) + '</code>';
    case 'e':
      return '<em>' + renderNodes(node.c) + '</em>';
    case 's':
      return '<strong>' + renderNodes(node.c) + '</strong>';
    case 'd':
      return '<del>' + renderNodes(node.c) + '</del>';
    case 'h':
      return node.s;
    case 'b':
      return '<br>';
    case 'n':
      return '\n';
    case 'dm':
      return node.ch.repeat(node.len);
    case 'bk':
      return node.img ? '![' : '[';
    case 'l': {
      const inner = node.auto ? escapeEncode(node.text) : renderNodes(node.c);
      if (node.href === null) return inner;
      const href = node.auto ? escapeEncode(node.href) : escapeNoEncode(node.href);
      let out = '<a href="' + href + '"';
      if (node.title !== null && node.title !== undefined) {
        out += ' title="' + escapeNoEncode(unescapePunct(node.title)) + '"';
      }
      return out + '>' + inner + '</a>';
    }
    case 'i': {
      if (node.href === null) return escapeNoEncode(altText(node.c));
      let out = '<img src="' + escapeNoEncode(node.href) + '" alt="' + escapeNoEncode(altText(node.c)) + '"';
      if (node.title !== null && node.title !== undefined) {
        out += ' title="' + escapeNoEncode(unescapePunct(node.title)) + '"';
      }
      return out + '>';
    }
    default:
      return '';
  }
}

function altText(nodes) {
  let out = '';
  for (const node of nodes) {
    switch (node.k) {
      case 't':
        out += node.raw ? node.s : decodeNumeric(node.s);
        break;
      case 'c':
        out += node.s;
        break;
      case 'e':
      case 's':
      case 'd':
        out += altText(node.c);
        break;
      case 'l':
        out += node.auto ? node.text : altText(node.c);
        break;
      case 'i':
        out += altText(node.c);
        break;
      case 'dm':
        out += node.ch.repeat(node.len);
        break;
      case 'bk':
        out += node.img ? '![' : '[';
        break;
      default:
        break;
    }
  }
  return out;
}

// Trim trailing backslashes count helper for the link closer check.
function trailingBackslashes(s, i) {
  let n = 0;
  for (let j = i - 1; j >= 0 && s[j] === '\\'; j--) n++;
  return n;
}

// Trim an extended-autolink match the way marked's _backpedal does:
// apply its regex until the string stops changing. The regex keeps
// runs of non-punctuation, complete (...) groups, an & that does not
// start an entity, and punctuation runs not at the end -- so an
// unmatched '(' (or a trailing entity) stops the match there.
const BACKPEDAL_RE =
  /^(?:[^?!.,:;*_'\"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'\"~)]+(?!$))+/;
function backpedal(u) {
  let prev;
  let cur = u;
  do {
    prev = cur;
    const m = BACKPEDAL_RE.exec(cur);
    cur = m ? m[0] : '';
  } while (cur !== prev);
  return cur;
}

// Whether the delimiter run of `ch` at s[pos] can close an open
// delimiter of the same char. Marked's emStrong tokenizer consumes a
// closing __ / ** before the url tokenizer runs, so an email directly
// before a closable closing delimiter is a full email (its lookahead
// would otherwise see the _ / * and truncate it).
function canCloseDelim(s, pos, ch, delims) {
  let n = 0;
  while (s[pos + n] === ch) n++;
  if (n === 0) return false;
  const f = flanking(s, pos, n);
  const canClose = ch === '*' ? f.right : f.right && (!f.left || f.afterPunct);
  if (!canClose) return false;
  for (const d of delims) {
    if (d.k === 'dm' && d.ch === ch && d.canOpen) return true;
  }
  return false;
}

// Match a plain email at s[i], allowing the full email when the
// lookahead fails only because a closable emphasis delimiter follows
// (see canCloseDelim). Returns the backpedaled raw email, or null.
function matchEmail(s, i, delims) {
  const rest = s.slice(i);
  const m = EMAIL_RE.exec(rest);
  const m2 = EMAIL_RE_NO_LOOK.exec(rest);
  let raw = null;
  if (m2 && (!m || m2[0].length > m[0].length)) {
    const full = backpedal(m2[0]);
    const afterPos = i + full.length;
    const afterCh = s[afterPos];
    if ((afterCh === '_' || afterCh === '*') && canCloseDelim(s, afterPos, afterCh, delims)) {
      raw = full;
    }
  }
  if (raw === null && m) raw = backpedal(m[0]);
  return raw;
}

// Try to match an extended autolink (www. / scheme:// / mailto: / xmpp: /
// email) at s[i]. Returns {raw, href, end} or null. inLink is ignored here;
// the caller only calls this when extended autolinks are allowed.
// insideBracket: when the scanner is inside an active '[' delimiter, a
// ']' ends the link text, so the URL must not swallow it (marked parses
// link text with inLink=true, so its url regex never sees the ']').
function matchExtendedUrl(s, i, insideBracket, delims) {
  const prev = i > 0 ? s[i - 1] : '';
  // mailto: / xmpp: (lowercase) followed by an email, with an optional
  // /path for xmpp.
  if (s.startsWith('mailto:', i) || s.startsWith('xmpp:', i)) {
    const proto = s.startsWith('mailto:', i) ? 'mailto:' : 'xmpp:';
    const em = matchEmail(s, i + proto.length, delims);
    if (em) {
      let raw = proto + em;
      if (proto === 'xmpp:') {
        const after = s.slice(i + raw.length);
        const pm = /^\/[A-Za-z0-9@.]+/.exec(after);
        if (pm) raw += pm[0];
      }
      raw = backpedal(raw);
      return { raw, href: raw, end: i + raw.length };
    }
  }
  const urlTail = insideBracket ? /^(?:[A-Za-z0-9-]+\.?)+[^\s<\]]*/ : /^(?:[A-Za-z0-9-]+\.?)+[^\s<]*/;
  // www. -- preceded by the start or whitespace / * / _ / ~ / ( .
  if (s.startsWith(WWW_PREFIX, i)) {
    if (prev === '' || prev === ' ' || prev === '\t' || prev === '\n' || prev === '*' || prev === '_' || prev === '~' || prev === '(') {
      const m = urlTail.exec(s.slice(i + 4));
      if (m && m[0].length > 0) {
        let raw = 'www.' + backpedal(m[0]);
        // The domain part must contain at least one label character.
        if (raw.length > 4) return { raw, href: 'http://' + raw, end: i + raw.length };
      }
    }
  }
  // Scheme:// -- http, https, ftp (case-insensitive), any preceding char.
  const sm = SCHEME_RE.exec(s.slice(i));
  if (sm) {
    const after = s.slice(i + sm[0].length);
    const m = urlTail.exec(after);
    if (m && m[0].length > 0) {
      const raw = sm[0] + backpedal(m[0]);
      return { raw, href: raw, end: i + raw.length };
    }
  }
  // Plain email address.
  if (/[A-Za-z0-9._+\-]/.test(s[i] || '')) {
    const em = matchEmail(s, i, delims);
    if (em) {
      return { raw: em, href: 'mailto:' + em, end: i + em.length };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// The inline scanner
// ---------------------------------------------------------------------------

function parseInlineNodes(s, refs, inLink) {
  const ctx = { nodes: [], delims: [], inRaw: false, hasLink: false };
  scanInline(s, refs, inLink, ctx);
  // Delimiter runs hidden by marked's emStrong mask cannot open or
  // close emphasis (see emStrongMask). Only worth computing when the
  // text holds a backtick, a bracket or a '<' -- otherwise the mask is
  // the identity on every delimiter run.
  if (
    ctx.delims.some((d) => d.k === 'dm') &&
    (s.includes('`') || s.includes('[') || s.includes('<'))
  ) {
    hideMaskedDelims(ctx.delims, emStrongMask(s), 0);
  }
  resolveEmphasis(ctx.nodes, ctx.delims);
  return ctx.nodes;
}

function inlineParse(s, refs, inLink) {
  return renderNodes(parseInlineNodes(s, refs, inLink));
}

function scanInline(s, refs, inLink, ctx) {
  const nodes = ctx.nodes;
  const delims = ctx.delims;
  let i = 0;
  let textStart = 0;

  const flushText = (end) => {
    if (end > textStart) {
      nodes.push({ k: 't', s: s.slice(textStart, end), raw: ctx.inRaw });
    }
  };
  const pushNode = (node) => {
    flushText(i);
    nodes.push(node);
  };

  while (i < s.length) {
    const ch = s[i];
    if (ch === '\\') {
      const nx = s[i + 1];
      if (nx === '\n') {
        // A hard break only when something non-blank follows the newline.
        // Marked's br token also swallows the next line's leading blanks.
        if (!/^\s*$/.test(s.slice(i + 2))) {
          pushNode({ k: 'b' });
          i += 2;
          while (s[i] === ' ' || s[i] === '\t') i++;
          textStart = i;
          continue;
        }
        i++;
        continue;
      }
      if (nx !== undefined && isAsciiPunct(nx)) {
        flushText(i);
        nodes.push({ k: 't', s: nx, esc: true });
        i += 2;
        textStart = i;
        continue;
      }
      i++;
      continue;
    }
    if (ch === '`') {
      let n = 0;
      while (s[i + n] === '`') n++;
      let end = findCodeEnd(s, i + n, n);
      // A code span must not swallow the ']' that closes an active '['
      // link: marked parses the link's label text on its own, so a code
      // span inside a label cannot run past the label's ']'. But when
      // the label cannot match (e.g. cm-342 `[not a `link](/foo`)`), no
      // link forms and the code span may run past the ']'. So only stop
      // at a ']' (followed by '(' or '[') whose label matches.
      if (end !== -1) {
        let bk = null;
        for (let d = delims.length - 1; d >= 0; d--) {
          if (delims[d].k === 'bk' && delims[d].active) { bk = delims[d]; break; }
        }
        if (bk) {
          for (let p = i + n; p < end; p++) {
            if (s[p] === ']' && (s[p + 1] === '(' || s[p + 1] === '[') && labelOk(s, bk.pos, p)) {
              end = -1;
              break;
            }
          }
        }
      }
      if (end === -1) {
        i += n;
        continue;
      }
      let content = s.slice(i + n, end).replace(/\n/g, ' ');
      if (
        content.length > 0 &&
        content[0] === ' ' &&
        content[content.length - 1] === ' ' &&
        /[^ ]/.test(content)
      ) {
        content = content.slice(1, -1);
      }
      pushNode({ k: 'c', s: content });
      i = end + n;
      textStart = i;
      continue;
    }
    if (ch === '*' || ch === '_') {
      let n = 0;
      while (s[i + n] === ch) n++;
      const f = flanking(s, i, n);
      let canOpen, canClose;
      if (ch === '*') {
        canOpen = f.left;
        canClose = f.right;
      } else {
        canOpen = f.left && (!f.right || f.beforePunct);
        canClose = f.right && (!f.left || f.afterPunct);
      }
      pushNode({ k: 'dm', ch, len: n, canOpen, canClose, pos: i });
      delims.push(nodes[nodes.length - 1]);
      i += n;
      textStart = i;
      continue;
    }
    if (ch === '~') {
      const prevChar = i > 0 ? s[i - 1] : '';
      const d = matchDel(s, i, prevChar);
      if (d) {
        pushNode({ k: 'd', c: parseInlineNodes(d.content, refs, inLink) });
        i = d.end;
        textStart = i;
        continue;
      }
      let n = 0;
      while (s[i + n] === '~') n++;
      i += n;
      continue;
    }
    if (ch === '!' && s[i + 1] === '[') {
      flushText(i);
      const bk = { k: 'bk', img: true, active: true, rawSave: ctx.inRaw, pos: i + 1 };
      nodes.push(bk);
      delims.push(bk);
      i += 2;
      textStart = i;
      continue;
    }
    if (ch === '[') {
      flushText(i);
      const bk = { k: 'bk', img: false, active: true, rawSave: ctx.inRaw, pos: i };
      nodes.push(bk);
      delims.push(bk);
      i++;
      textStart = i;
      continue;
    }
    if (ch === ']') {
      // Try to form a link from the most recent active '[' delimiter.
      // Flush the pending text first so the link's text nodes are in the
      // node list for buildLink to splice out.
      flushText(i);
      let bi = -1;
      for (let k = delims.length - 1; k >= 0; k--) {
        if (delims[k].k === 'bk' && delims[k].active) {
          bi = k;
          break;
        }
      }
      if (bi >= 0) {
        const bk = delims[bi];
        const bkIdx = nodes.indexOf(bk);
        const made = tryMakeLink(s, i, bk, bkIdx, nodes, delims, refs, inLink, ctx);
        if (made) {
          i = made.end;
          textStart = i;
          continue;
        }
        // Not a link: deactivate this '[' and treat ']' as text.
        bk.active = false;
        ctx.inRaw = bk.rawSave;
        textStart = i;
        i++;
        continue;
      }
      textStart = i;
      i++;
      continue;
    }
    if (ch === '<') {
      const am = AUTOLINK_RE.exec(s.slice(i));
      if (am) {
        const raw = am[1];
        const href = cleanHref(raw);
        pushNode({ k: 'l', href, title: null, c: null, auto: true, text: raw });
        i += am[0].length;
        textStart = i;
        continue;
      }
      const em = AUTOLINK_EMAIL_RE.exec(s.slice(i));
      if (em) {
        const raw = em[1];
        const href = cleanHref('mailto:' + raw);
        pushNode({ k: 'l', href, title: null, c: null, auto: true, text: raw });
        i += em[0].length;
        textStart = i;
        continue;
      }
      const tag = parseTagAt(s, i);
      if (tag !== null) {
        pushNode({ k: 'h', s: tag });
        // Track <pre>/<code>/<kbd>/<script> raw blocks.
        const low = tag.toLowerCase();
        if (/^<(pre|code|kbd|script)[\s>]/.test(low)) ctx.inRaw = true;
        else if (/^<\/(pre|code|kbd|script)[\s>]/.test(low)) ctx.inRaw = false;
        // Track the document-wide inLink state: an open <a ...> tag
        // suppresses extended autolinks until its </a>. Marked's
        // inline lexer only resets inRawBlock between paragraphs, so
        // inLink leaks across the whole document.
        if (/^<a /i.test(tag)) refs.inLink = true;
        else if (/^<\/a>/i.test(tag)) refs.inLink = false;
        i += tag.length;
        textStart = i;
        continue;
      }
      i++;
      continue;
    }
    if (ch === '\n') {
      // Hard break: two or more trailing spaces before the newline, and
      // something non-blank after it.
      flushText(i);
      const restAfter = s.slice(i + 1);
      const last = nodes[nodes.length - 1];
      if (last && last.k === 't' && !last.esc && !/^\s*$/.test(restAfter)) {
        const m = / {2,}$/.exec(last.s);
        if (m) {
          last.s = last.s.slice(0, last.s.length - m[0].length);
          if (last.s === '') nodes.pop();
          nodes.push({ k: 'b' });
          i++;
          while (s[i] === ' ' || s[i] === '\t') i++;
          textStart = i;
          continue;
        }
      }
      nodes.push({ k: 'n' });
      i++;
      textStart = i;
      continue;
    }
    if (!inLink && !refs.inLink) {
      const cc = ch.charCodeAt(0);
      const isAlnumCh =
        (cc >= 48 && cc <= 57) || (cc >= 65 && cc <= 90) || (cc >= 97 && cc <= 122);
      if (isAlnumCh || ch === '.' || ch === '_' || ch === '+' || ch === '-') {
        // Only try at a possible word start for emails: the previous
        // character must not be part of an email local part.
        const prev = i > 0 ? s[i - 1] : '';
        const prevLocal = /[A-Za-z0-9._+\-]/.test(prev);
        if (!prevLocal || ch === 'w' || ch === 'h' || ch === 'H' || ch === 'f' || ch === 'F' || ch === 'm' || ch === 'x') {
          // Inside an active '[' the URL must not swallow the ']' that
          // closes the link text -- but only when that bracket can still
          // become a link. If its text already contains a real link, the
          // bracket cannot become one (marked's linkEmitted), so the
          // ']' is ordinary text and the URL may include it.
          let insideBracket = false;
          for (let d = delims.length - 1; d >= 0; d--) {
            if (delims[d].k === 'bk' && delims[d].active) {
              const bkIdx = nodes.indexOf(delims[d]);
              let hasLink = false;
              for (let k = bkIdx + 1; k < nodes.length; k++) {
                if (containsLink([nodes[k]])) { hasLink = true; break; }
              }
              insideBracket = !hasLink;
              break;
            }
          }
          const u = matchExtendedUrl(s, i, insideBracket, delims);
          if (u) {
            const href = cleanHref(u.href);
            pushNode({ k: 'l', href, title: null, c: null, auto: true, ext: true, text: u.raw });
            i = u.end;
            textStart = i;
            continue;
          }
        }
      }
    }
    i++;
  }
  flushText(s.length);
}

// Try to form a link/image from the bracket delimiter `bk` (at nodes[bkIdx])
// closed by the ']' at s[closeIdx]. Returns {end} on success, null otherwise.
function tryMakeLink(s, closeIdx, bk, bkIdx, nodes, delims, refs, inLink, ctx) {
  // The link text must be a valid label (marked's `re`); a code span
  // containing a backtick makes it unmatchable, so no link is formed.
  if (!labelOk(s, bk.pos, closeIdx)) return null;
  const after = closeIdx + 1;
  const labelSrc = s.slice(bk.pos + 1, closeIdx);
  if (s[after] === '(') {
    const t = parseLinkTarget(s, after + 1);
    if (t) {
      // The closing ')' must not be escaped.
      if (trailingBackslashes(s, t.end - 1) % 2 === 0) {
        return buildLink(bk, bkIdx, nodes, delims, refs, ctx, t.href, t.title, t.end, bk.img, labelSrc);
      }
    }
    // Inline link failed: fall back to a reference link, as marked does.
    return tryReference(s, closeIdx, bk, bkIdx, nodes, delims, refs, ctx, labelSrc);
  }
  if (s[after] === '[') {
    const rl = parseRefLabel(s, after);
    if (rl) {
      const def = refs.get(labelKey(rl.label));
      if (def) {
        return buildLink(bk, bkIdx, nodes, delims, refs, ctx, def.href, def.title, rl.end, bk.img, labelSrc);
      }
      // A full reference with an unknown label is literal, not a
      // shortcut reference (marked).
      return null;
    }
    // No parseable label (e.g. the collapsed []): fall through to the
    // collapsed / shortcut reference handling.
  }
  return tryReference(s, closeIdx, bk, bkIdx, nodes, delims, refs, ctx, labelSrc);
}

function tryReference(s, closeIdx, bk, bkIdx, nodes, delims, refs, ctx, labelSrc) {
  // Collapsed reference [text][] or shortcut [text].
  const after = closeIdx + 1;
  let key;
  let end;
  if (s[after] === '[' && s[after + 1] === ']') {
    key = labelKey(linkTextRaw(nodes, bkIdx));
    end = after + 2;
  } else {
    key = labelKey(linkTextRaw(nodes, bkIdx));
    end = closeIdx + 1;
  }
  const def = refs.get(key);
  if (!def) return null;
  return buildLink(bk, bkIdx, nodes, delims, refs, ctx, def.href, def.title, end, bk.img, labelSrc);
}

function containsLink(nodes) {
  // Only a real (non-autolink) link counts: an angle autolink inside
  // link text does not stop the outer link (marked's linkEmitted is
  // only set by the link/reflink tokenizers, not by autolink).
  for (const n of nodes) {
    if (n.k === 'l' && !n.auto) return true;
    if (n.k === 'e' || n.k === 's' || n.k === 'd') {
      if (containsLink(n.c)) return true;
    }
  }
  return false;
}

// Replace the extended-autolink nodes inside `nodes` with plain text
// nodes, recursing into emphasis / strikethrough / link / image
// children. Marked parses link text with inLink=true, so no extended
// autolink is created there; ours were created during the scan, before
// the outer link was known, so they are undone here.
function unlinkExtNodes(nodes) {
  for (let k = 0; k < nodes.length; k++) {
    const n = nodes[k];
    if (n.k === 'l' && n.ext) {
      nodes[k] = { k: 't', s: n.text };
    } else if (n.k === 'e' || n.k === 's' || n.k === 'd' || n.k === 'l' || n.k === 'i') {
      if (n.c) unlinkExtNodes(n.c);
    }
  }
}

function linkTextRaw(nodes, bkIdx) {
  // The raw text of the link label: text nodes joined, with \[ and \] kept
  // as they appear in the source (escapes are preserved for lookup).
  let out = '';
  for (let k = bkIdx + 1; k < nodes.length; k++) {
    const n = nodes[k];
    if (n.k === 't') out += n.esc ? '\\' + n.s : n.s;
    else if (n.k === 'c') out += '`' + n.s + '`';
    else if (n.k === 'dm') out += n.ch.repeat(n.len);
    else if (n.k === 'bk') out += n.img ? '![' : '[';
    else if (n.k === 'h') out += n.s;
    else if (n.k === 'b') out += '  \n';
    else if (n.k === 'n') out += '\n';
    else if (n.k === 'e' || n.k === 's' || n.k === 'd') out += linkTextRaw(n.c, -1);
    else if (n.k === 'l') out += n.auto ? n.text : linkTextRaw(n.c || [], -1);
    else if (n.k === 'i') out += linkTextRaw(n.c || [], -1);
  }
  return out;
}

function buildLink(bk, bkIdx, nodes, delims, refs, ctx, hrefRaw, titleRaw, end, isImage, labelSrc) {
  // A link whose text contains a link is not a link (images are exempt).
  // Check before touching the node list.
  if (!isImage) {
    for (let k = bkIdx + 1; k < nodes.length; k++) {
      if (containsLink([nodes[k]])) return null;
    }
  }
  // The child nodes are the nodes after '[' up to the current end.
  const childNodes = nodes.splice(bkIdx + 1);
  // Extended autolinks are not created inside link text (marked parses
  // it with inLink=true); undo the ones the scan created here.
  if (!isImage) unlinkExtNodes(childNodes);
  // Move this list's delimiters that live inside the child range.
  const childDelims = [];
  for (let k = delims.length - 1; k >= 0; k--) {
    const d = delims[k];
    if (d === bk) {
      delims.splice(k, 1);
      continue;
    }
    if (childNodes.indexOf(d) >= 0) {
      childDelims.push(d);
      delims.splice(k, 1);
    }
  }
  childDelims.reverse();
  // Marked tokenizes link text on its own, with its own emStrong mask
  // over the label (after unescaping \[ and \], which shifts positions
  // by one per escape). Delimiters hidden by that mask cannot open or
  // close emphasis inside the link.
  if (labelSrc !== undefined && childDelims.length > 0) {
    const labelText = labelSrc.replace(/\\([\[\]])/g, "$1");
    if (labelText.includes("`") || labelText.includes("[") || labelText.includes("<")) {
      const masked = emStrongMask(labelText);
      const base = bk.pos + 1;
      for (const d of childDelims) {
        if (d.k !== "dm") continue;
        let rel = d.pos - base;
        for (let p = 0; p < rel && p < labelSrc.length - 1; p++) {
          if (labelSrc[p] === "\\" && (labelSrc[p + 1] === "[" || labelSrc[p + 1] === "]")) {
            rel--;
            p++;
          }
        }
        if (masked[rel] !== d.ch) {
          d.canOpen = false;
          d.canClose = false;
        }
      }
    }
  }
  resolveEmphasis(childNodes, childDelims);
  // Resolve the href: unescape backslash escapes once, then encodeURI.
  // (Angle destinations keep their interior spaces; no trimming here.)
  let href = null;
  if (hrefRaw !== null && hrefRaw !== undefined) {
    href = cleanHref(unescapePunct(hrefRaw));
  }
  const linkNode = isImage
    ? { k: 'i', href, title: titleRaw === null ? null : unescapePunct(titleRaw), c: childNodes }
    : { k: 'l', href, title: titleRaw === null ? null : unescapePunct(titleRaw), c: childNodes, auto: false };
  nodes.splice(bkIdx, 1, linkNode);
  if (!isImage) ctx.hasLink = true;
  return { end };
}

// ============================================================
// Block parser
//
// Lines are objects {s, i, col, pend} from the line cursors above.
// A container (list item / blockquote) always builds fresh line objects
// from strings with col 0, mirroring marked's habit of lexing the
// stripped inner text as its own source. Top-level lines come from the
// source split on '\n'.
// ============================================================

const BLOCK_TAG_SET = new Set('address article aside base basefont blockquote body caption center col colgroup dd details dialog dir div dl dt fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 head header hr html iframe legend li link main menu menuitem meta nav noframes ol optgroup option p param search section summary table tbody td tfoot th thead title tr track ul'.split(' '));

// Expand the remaining leading whitespace of a line object (tabs become
// spaces, counted from the column where the rest starts). Mutates l.
function expandLeading(l) {
  const rest = lineRest(l);
  let k = 0;
  let col = l.col;
  while (k < rest.length && (rest[k] === ' ' || rest[k] === '\t')) {
    if (rest[k] === ' ') col++;
    else col += 4 - (col % 4);
    k++;
  }
  if (k === 0) return;
  const spaces = ' '.repeat(col - l.col);
  l.s = spaces + rest.slice(k);
  l.i = 0;
  l.pend = 0;
}

// Advance n columns from a line and expand what leading whitespace is
// left; returns the resulting string (a fresh line object is built from
// it by the caller).
function stripToString(l, n) {
  const c = cloneLine(l);
  lineAdvance(c, n);
  expandLeading(c);
  return lineRest(c);
}

// Expand the leading whitespace of a plain string starting at column 0
// (marked's J(s) with the default start column).
function expandLeadingStr(s) {
  let k = 0;
  let col = 0;
  while (k < s.length && (s[k] === ' ' || s[k] === '\t')) {
    if (s[k] === ' ') col++;
    else col += 4 - (col % 4);
    k++;
  }
  if (k === 0) return s;
  return ' '.repeat(col) + s.slice(k);
}

// Remove up to 4 columns of indent from a code line (marked's
// codeRemoveIndent: 1-4 spaces, or 0-3 spaces plus a tab).
function stripCodeIndentStr(s) {
  let col = 0;
  let i = 0;
  while (i < s.length && col < 4) {
    const ch = s[i];
    if (ch === ' ') { col++; i++; }
    else if (ch === '\t') { col += 4 - (col % 4); i++; }
    else break;
  }
  return s.slice(i);
}

// Fenced-code indent compensation (marked's Dt): remove up to n
// characters of the leading whitespace run.
function fenceCompensate(s, n) {
  let i = 0;
  while (i < s.length && i < n && (s[i] === ' ' || s[i] === '\t')) i++;
  return s.slice(i);
}

// Is the line a code line (indented code, not blank)? A line counts when
// stripping 4 columns leaves something behind.
function isCodeLine(l) {
  if (lineIndent(l) < 4) return false;
  const c = cloneLine(l);
  lineAdvance(c, 4);
  return lineRest(c).length > 0;
}

function matchAtx(rest) {
  let i = 0;
  while (i < rest.length && rest[i] === '#') i++;
  if (i === 0 || i > 6) return null;
  if (i < rest.length && rest[i] !== ' ' && rest[i] !== '\t') return null;
  let text = rest.slice(i).trim();
  if (text.endsWith('#')) {
    const stripped = text.replace(/#+$/, '');
    if (stripped === '' || stripped.endsWith(' ') || stripped.endsWith('\t')) text = stripped.trim();
  }
  return { depth: i, text };
}

function matchHr(rest) {
  if (rest.length < 3) return false;
  const c = rest[0];
  if (c !== '-' && c !== '_' && c !== '*') return false;
  let count = 0;
  for (let i = 0; i < rest.length; i++) {
    const ch = rest[i];
    if (ch === c) count++;
    else if (ch !== ' ' && ch !== '\t') return false;
  }
  return count >= 3;
}

function matchFence(rest) {
  const c = rest[0];
  if (c !== '`' && c !== '~') return null;
  let i = 0;
  while (i < rest.length && rest[i] === c) i++;
  if (i < 3) return null;
  const info = rest.slice(i);
  if (c === '`' && info.indexOf('`') !== -1) return null;
  return { char: c, len: i, info };
}

// First word of the (trimmed, escape-unescaped) fence info string.
function fenceLang(info) {
  const t = info.trim().replace(/\\([\p{P}\p{S}])/gu, '$1');
  const m = /^\S*/.exec(t);
  return m ? m[0] : '';
}

function matchListMarker(rest) {
  const c = rest[0];
  if (c === '*' || c === '+' || c === '-') {
    return { ordered: false, markerLen: 1, start: 0, delim: '' };
  }
  if (c >= '0' && c <= '9') {
    let i = 0;
    while (i < rest.length && rest[i] >= '0' && rest[i] <= '9') i++;
    if (i > 9 || i === 0) return null;
    if (i < rest.length && (rest[i] === '.' || rest[i] === ')')) {
      return { ordered: true, markerLen: i + 1, start: parseInt(rest.slice(0, i), 10), delim: rest[i] };
    }
  }
  return null;
}

// Setext underline (0-3 indent already stripped): 1 for '=', 2 for '-'.
function isSetextUnderline(rest) {
  if (rest.length === 0) return 0;
  const c = rest[0];
  if (c !== '=' && c !== '-') return 0;
  let i = 0;
  while (i < rest.length && rest[i] === c) i++;
  for (; i < rest.length; i++) if (rest[i] !== ' ' && rest[i] !== '\t') return 0;
  return c === '=' ? 1 : 2;
}

// Table delimiter row (spaces only around cells; must contain ':' or '|').
function isTableDelimiter(rest) {
  if (rest.indexOf(':') === -1 && rest.indexOf('|') === -1) return false;
  let i = 0;
  const n = rest.length;
  const skip = () => { while (i < n && rest[i] === ' ') i++; };
  skip();
  if (rest[i] === '|') { i++; skip(); }
  let cells = 0;
  while (true) {
    if (rest[i] === ':') i++;
    let dashes = 0;
    while (i < n && rest[i] === '-') { i++; dashes++; }
    if (dashes === 0) return false;
    if (rest[i] === ':') i++;
    cells++;
    skip();
    if (i >= n) break;
    if (rest[i] === '|') { i++; skip(); if (i >= n) break; continue; }
    return false;
  }
  return cells > 0;
}

function parseTableAlign(delim) {
  const s = delim.replace(/^\|/, '').replace(/\| *$/, '');
  return s.split('|').map((c) => {
    if (/^ *-+: *$/.test(c)) return 'right';
    if (/^ *:-+: *$/.test(c)) return 'center';
    if (/^ *:-+ *$/.test(c)) return 'left';
    return null;
  });
}

// Marked's de(): split a table row into cells.
function splitCells(row, count) {
  let t = '';
  for (let i = 0; i < row.length; i++) {
    const ch = row[i];
    if (ch === '|') {
      let escaped = false;
      for (let p = i - 1; p >= 0 && row[p] === '\\'; p--) escaped = !escaped;
      t += escaped ? '|' : ' |';
    } else t += ch;
  }
  const cells = t.split(' |');
  if (cells.length > 0 && cells[0].trim() === '') cells.shift();
  if (cells.length > 0 && cells[cells.length - 1].trim() === '') cells.pop();
  if (count !== undefined) {
    if (cells.length > count) cells.length = count;
    else while (cells.length < count) cells.push('');
  }
  for (let i = 0; i < cells.length; i++) cells[i] = cells[i].trim().replace(/\\\|/g, '|');
  return cells;
}

// HTML that can interrupt a paragraph (marked's htmlBeginRegex): an open
// or close tag of a block tag, an open script/pre/style/textarea tag, a
// comment, a processing instruction, a declaration, or CDATA.
function isInterruptHtml(rest) {
  if (rest[0] !== '<') return false;
  if (rest[1] === '!') {
    if (rest.startsWith('<!--')) return true;
    if (rest.startsWith('<![CDATA[')) return true;
    return rest.length > 2 && rest[2] >= 'A' && rest[2] <= 'Z' || rest.length > 2 && rest[2] >= 'a' && rest[2] <= 'z';
  }
  if (rest[1] === '?') return true;
  let j = 1;
  const closing = rest[j] === '/';
  if (closing) j++;
  let k = j;
  while (k < rest.length && /[A-Za-z0-9-]/.test(rest[k])) k++;
  if (k === j) return false;
  const name = rest.slice(j, k).toLowerCase();
  const after = rest[k];
  if (name === 'script' || name === 'pre' || name === 'style' || name === 'textarea') {
    // Only an OPEN script/pre/style/textarea tag interrupts a paragraph;
    // a closing tag does not (marked's htmlBeginRegex has no '/' there).
    if (closing) return false;
    return after === undefined || after === ' ' || after === '\t' || after === '\n' || after === '\r' || after === '\f' || after === '>';
  }
  if (!BLOCK_TAG_SET.has(name)) return false;
  if (after === undefined) return true;
  if (after === ' ') return true;
  if (after === '>') return true;
  if (after === '/' && rest[k + 1] === '>') return true;
  return false;
}

// Does this line start a block that interrupts a paragraph? rest is the
// line after stripping up to 3 indent columns. Inside a list item
// (top=false) any ordered marker interrupts a paragraph (marked's
// non-top-level paragraph regex); at the top level only a list
// starting at 1 does.
function isInterrupt(rest, top) {
  if (matchAtx(rest) !== null) return true;
  if (matchFence(rest) !== null) return true;
  if (matchHr(rest)) return true;
  if (rest[0] === '>') return true;
  if (isInterruptHtml(rest)) return true;
  // A list interrupts a paragraph only when the item is not empty:
  // a bullet, or an ordered list starting at 1 (top level) / any start
  // (inside a list item), followed by whitespace and a non-space char.
  const m = matchListMarker(rest);
  if (m) {
    const after = rest[m.markerLen];
    if ((after === ' ' || after === '\t') && !m.ordered) {
      let j = m.markerLen;
      while (j < rest.length && (rest[j] === ' ' || rest[j] === '\t')) j++;
      if (j < rest.length) return true;
    } else if ((after === ' ' || after === '\t') && m.ordered && (!top || m.start === 1)) {
      let j = m.markerLen;
      while (j < rest.length && (rest[j] === ' ' || rest[j] === '\t')) j++;
      if (j < rest.length) return true;
    }
  }
  return false;
}

// Try to parse a table whose header is `headerLine` and whose delimiter
// is the line at index `di`. Returns null when the cell counts disagree.
function tryParseTable(lines, di, headerLine, delimRest, refs) {
  const headerCells = splitCells(headerLine);
  const aligns = parseTableAlign(delimRest);
  if (headerCells.length !== aligns.length) return null;
  // Body rows: until a blank line or a block-start line. Marked's table
  // regex only rejects a row on ` *\n` (a line of spaces only) and on
  // indented code ((?: {4}| {0,3}\t)[^\n]): a tab-only line IS a row
  // (all cells empty), while `\tfoo` is indented code, not a row.
  const rows = [];
  let j = di + 1;
  while (j < lines.length) {
    const ln = lines[j];
    const rowRest = lineRest(ln);
    let sp = 0;
    while (sp < rowRest.length && rowRest[sp] === ' ') sp++;
    if (sp === rowRest.length) break; // spaces-only or empty
    if (sp >= 4) break; // 4+ spaces then a non-newline char
    if (rowRest[sp] === '\t' && sp + 1 < rowRest.length) break; // tab + char
    const ind = lineIndent(ln);
    const probe = cloneLine(ln);
    lineAdvance(probe, ind);
    const rest = lineRest(probe);
    if (matchHr(rest) || matchAtx(rest) !== null || matchFence(rest) !== null) break;
    if (rest[0] === '>') break;
    if (isInterruptHtml(rest)) break;
    const lm = matchListMarker(rest);
    if (lm) {
      const after = rest[lm.markerLen];
      if ((after === ' ' || after === '\t') && (!lm.ordered || lm.start === 1)) break;
    }
    rows.push(lineRest(ln));
    j++;
  }
  let out = '<table>\n<thead>\n<tr>\n';
  for (let c = 0; c < headerCells.length; c++) {
    const a = aligns[c];
    out += (a ? '<th align="' + a + '">' : '<th>') + inlineParse(headerCells[c], refs) + '</th>\n';
  }
  out += '</tr>\n</thead>\n';
  let body = '';
  for (const row of rows) {
    const cells = splitCells(row, headerCells.length);
    body += '<tr>\n';
    for (let c = 0; c < cells.length; c++) {
      const a = aligns[c];
      body += (a ? '<td align="' + a + '">' : '<td>') + inlineParse(cells[c], refs) + '</td>\n';
    }
    body += '</tr>\n';
  }
  if (body) out += '<tbody>' + body + '</tbody>';
  out += '</table>\n';
  return { html: out, end: j, block: { type: 'table' } };
}

// A paragraph (top=true) or a loose text run inside a list item
// (top=false, rendered without <p> wrappers). Handles setext headings
// and tables on the second line.
function parseParagraph(lines, i, refs, top) {
  const paraLines = [];
  let k = i;
  while (k < lines.length) {
    const ln = lines[k];
    if (lineBlank(ln)) {
      // A whitespace-only line at the very end of the source (no newline
      // after it) is a paragraph continuation, not a blank line (marked's
      // paragraph regex needs [ \t]+\n for a blank line). This only
      // applies at the top level / inside a blockquote: a list item's
      // text is trimEnd'ed by marked, so a trailing space line there
      // is dropped, not continued.
      if (top && paraLines.length > 0 && k === lines.length - 1 && lineRest(ln) !== '') {
        paraLines.push(lineRest(ln));
        k++;
      }
      break;
    }
    // A lazy blockquote line stripped to paragraph text stays text even
    // when it now looks like a block start.
    if (ln.lazyPara && paraLines.length > 0) {
      paraLines.push(lineRest(ln));
      k++;
      continue;
    }
    const ind = lineIndent(ln);
    if (ind >= 4) {
      // Indented code cannot interrupt a paragraph. Inside a list item
      // (top=false) the line is lexed as a code token and merged with
      // the indent stripped; at the top level it is kept verbatim.
      paraLines.push(top ? lineRest(ln) : stripCodeIndentStr(lineRest(ln)));
      k++;
      continue;
    }
    if (paraLines.length > 0) {
      const probe = cloneLine(ln);
      lineAdvance(probe, ind);
      const rest = lineRest(probe);
      const setext = isSetextUnderline(rest);
      if (setext) {
        const text = paraLines.join('\n').trim();
        return {
          html: '<h' + setext + '>' + inlineParse(text, refs) + '</h' + setext + '>\n',
          end: k + 1,
          block: { type: 'heading' },
        };
      }
      if (paraLines.length === 1 && isTableDelimiter(rest)) {
        const table = tryParseTable(lines, k, paraLines[0], rest, refs);
        if (table) return table;
      }
      if (isInterrupt(rest, top)) break;
    }
    paraLines.push(lineRest(ln));
    k++;
  }
  if (paraLines.length === 0) return null;
  const inner = inlineParse(paraLines.join('\n'), refs);
  const type = top ? 'paragraph' : 'text';
  return {
    html: top ? '<p>' + inner + '</p>\n' : inner,
    end: k,
    block: { type, inner, text: paraLines.join('\n') },
  };
}

// Indented code block: lines with indent >= 4 (or blank lines between
// them). The raw text is trimmed by ge() and each line loses 4 columns.
function parseIndentedCode(lines, i) {
  let j = i;
  while (j < lines.length) {
    const ln = lines[j];
    if (lineBlank(ln)) { j++; continue; }
    if (lineIndent(ln) >= 4) { j++; continue; }
    break;
  }
  const rawLines = lines.slice(i, j).map((l) => lineRest(l));
  let raw = rawLines.join('\n');
  if (j < lines.length) raw += '\n';
  const trimmed = geText(raw);
  const text = trimmed.split('\n').map(stripCodeIndentStr).join('\n');
  // The renderer strips one trailing newline and adds one back.
  const body = text ? escapeEncode(text.replace(/\n$/, '')) + '\n' : '';
  return {
    html: '<pre><code>' + body + '</code></pre>\n',
    end: j,
    block: { type: 'code' },
  };
}

function parseFenced(lines, i, fence, ind) {
  let j = i + 1;
  let closed = false;
  while (j < lines.length) {
    const ln = lines[j];
    const ind2 = lineIndent(ln);
    if (ind2 <= 3) {
      const p2 = cloneLine(ln);
      lineAdvance(p2, ind2);
      const r2 = lineRest(p2);
      if (r2[0] === fence.char) {
        let k = 0;
        while (k < r2.length && r2[k] === fence.char) k++;
        if (k >= fence.len && /^ *$/.test(r2.slice(k))) { closed = true; break; }
      }
    }
    j++;
  }
  const contentLines = lines.slice(i + 1, closed ? j : lines.length);
  // Marked's indentCodeCompensation (/^(\s+)(?:```)/) only matches a
  // backtick fence: a tilde fence's content keeps its indent untouched.
  const parts =
    fence.char === '`'
      ? contentLines.map((l) => fenceCompensate(lineRest(l), ind))
      : contentLines.map((l) => lineRest(l));
  let text = parts.join('\n');
  if (!closed && text.endsWith('\n')) text = text.slice(0, -1);
  const lang = fenceLang(fence.info);
  const body = text ? escapeEncode(text.replace(/\n$/, '')) + '\n' : '';
  const html = lang
    ? '<pre><code class="language-' + escapeNoEncode(lang) + '">' + body + '</code></pre>\n'
    : '<pre><code>' + body + '</code></pre>\n';
  return { html, end: closed ? j + 1 : lines.length, block: { type: 'code' } };
}

// Parse a link reference definition starting at line i. Returns null or
// {end} (the index of the first line after the definition).
function tryParseDef(lines, i, refs) {
  // Build a window of the following lines (a definition spans at most a
  // few lines and never a blank line, except inside a double-quoted title).
  const win = [];
  for (let k = i; k < lines.length && win.length < 10; k++) win.push(lineRest(lines[k]));
  const src = win.join('\n');
  let p = 0;
  const n = src.length;
  let sp = 0;
  while (sp < 3 && src[p + sp] === ' ') sp++;
  p += sp;
  if (src[p] !== '[') return null;
  p++;
  // Label: escapes, or any char except [ ] \ and a newline (a newline is
  // allowed when the next line is not blank).
  let label = '';
  let labelOk = false;
  while (p < n) {
    const ch = src[p];
    if (ch === '\\' && p + 1 < n) { label += src[p] + src[p + 1]; p += 2; continue; }
    if (ch === ']') { labelOk = true; p++; break; }
    if (ch === '[' || ch === '\n') {
      if (ch === '\n') {
        // Newline allowed unless the following line is blank.
        let q = p + 1;
        while (q < n && (src[q] === ' ' || src[q] === '\t')) q++;
        if (q >= n || src[q] === '\n') return null;
        label += '\n';
        p++;
        continue;
      }
      return null;
    }
    label += ch;
    p++;
  }
  if (!labelOk || label.trim() === '') return null;
  if (src[p] !== ':') return null;
  p++;
  const skipWs = () => {
    while (p < n && (src[p] === ' ' || src[p] === '\t')) p++;
    if (src[p] === '\n') {
      let q = p + 1;
      while (q < n && (src[q] === ' ' || src[q] === '\t')) q++;
      if (q < n && src[q] !== '\n') { p = q; return true; }
    }
    return false;
  };
  skipWs();
  // Destination.
  let dest = '';
  let destOk = false;
  if (src[p] === '<') {
    p++;
    const start = p;
    while (p < n) {
      const ch = src[p];
      if (ch === '>') { destOk = true; p++; break; }
      if (ch === '\n' || ch === '<') return null;
      if (ch === '\\' && p + 1 < n) { p += 2; continue; }
      p++;
    }
    if (!destOk) return null;
    dest = unescapePunct(src.slice(start, p - 1));
  } else {
    const start = p;
    while (p < n && src[p] !== ' ' && src[p] !== '\t' && src[p] !== '\n') p++;
    if (p === start) return null;
    dest = src.slice(start, p);
    if (parenBalance(dest) !== -1) return null;
  }
  // Optional title. Marked's def regex requires the title to be preceded
  // by whitespace (spaces, or a newline); a title glued to the
  // destination is not a title. Escapes inside the title are kept raw
  // and unescaped with anyPunctuation (punctuation only) at the end.
  const pAfterDest = p;
  let title = null;
  {
    let q = p;
    let ws = false;
    while (q < n && (src[q] === ' ' || src[q] === '\t')) { q++; ws = true; }
    if (src[q] === '\n') {
      let r = q + 1;
      while (r < n && (src[r] === ' ' || src[r] === '\t')) r++;
      if (r < n && src[r] !== '\n') { q = r; ws = true; }
    }
    if (ws && q < n && (src[q] === '"' || src[q] === "'" || src[q] === '(')) {
      const open = src[q];
      const close = open === '(' ? ')' : open;
      let r = q + 1;
      let t = '';
      let ok = false;
      while (r < n) {
        const ch = src[r];
        if (ch === '\\' && r + 1 < n) { t += src[r] + src[r + 1]; r += 2; continue; }
        if (ch === close) { ok = true; r++; break; }
        if (open === '(' && ch === '(') break;
        if (ch === '\n' && open === "'") {
          if (src[r + 1] === '\n') break;
        }
        t += ch;
        r++;
      }
      if (ok) { title = unescapePunct(t); p = r; }
    }
  }
  // The definition must end at a line end. If a title was parsed but is
  // followed by other text, marked backtracks to the title-less
  // definition (the line ends after the destination).
  while (p < n && (src[p] === ' ' || src[p] === '\t')) p++;
  if (p < n && src[p] !== '\n') {
    if (title !== null) {
      title = null;
      p = pAfterDest;
      while (p < n && (src[p] === ' ' || src[p] === '\t')) p++;
      if (p < n && src[p] !== '\n') return null;
    } else return null;
  }
  // How many lines did the definition consume?
  let consumed = 0;
  let seen = 0;
  for (let k = 0; k < win.length; k++) {
    if (seen > p) break;
    consumed = k + 1;
    seen += win[k].length + 1;
  }
  if (p === 0) return null;
  const key = labelKey(label);
  if (!refs.has(key)) refs.set(key, { href: dest, title });
  return { end: i + consumed };
}

// Which HTML block type starts here (marked's Ue alternatives), or null.
// rest is the line after stripping up to 3 indent columns.
function htmlBlockStart(rest) {
  const m1 = /^<(script|pre|style|textarea)(?:[\s>]|$)/i.exec(rest);
  if (m1) return { type: 1, tag: m1[1].toLowerCase() };
  if (rest.startsWith('<!--')) return { type: 2 };
  if (rest.startsWith('<?')) return { type: 3 };
  if (/^<![A-Za-z]/.test(rest)) return { type: 4 };
  if (rest.startsWith('<![CDATA[')) return { type: 5 };
  let j = 0;
  if (rest[0] === '<') {
    j = 1;
    if (rest[j] === '/') j++;
    let k = j;
    while (k < rest.length && /[A-Za-z0-9-]/.test(rest[k])) k++;
    if (k > j) {
      const name = rest.slice(j, k).toLowerCase();
      const after = rest[k];
      if (BLOCK_TAG_SET.has(name) && (after === undefined || after === ' ' || after === '\t' || after === '\n' || after === '/' || after === '>')) {
        return { type: 6 };
      }
    }
  }
  // Type 7: a complete open tag alone on the line.
  if (rest[0] === '<' && rest[1] !== '/' && rest[1] !== '!' && rest[1] !== '?') {
    const tag = parseCompleteOpenTag(rest);
    if (tag !== -1) return { type: 7 };
  }
  // Type 8: a complete close tag alone on the line.
  if (/^<\/[A-Za-z][A-Za-z0-9-]*\s*>[ \t]*$/.test(rest)) return { type: 8 };
  return null;
}

// Parse a complete open tag at the start of rest; returns the index just
// past the '>' or -1. Tag names exclude script/pre/style/textarea.
function parseCompleteOpenTag(rest) {
  let i = 1;
  if (!/[A-Za-z]/.test(rest[i] || '')) return -1;
  let name = '';
  while (i < rest.length && /[A-Za-z0-9-]/.test(rest[i])) { name += rest[i]; i++; }
  const low = name.toLowerCase();
  if (low === 'script' || low === 'pre' || low === 'style' || low === 'textarea') return -1;
  while (i < rest.length) {
    const ch = rest[i];
    if (ch === '>') {
      let j = i + 1;
      while (j < rest.length && (rest[j] === ' ' || rest[j] === '\t')) j++;
      return j === rest.length ? i + 1 : -1;
    }
    if (ch === '/') {
      if (rest[i + 1] === '>') {
        let j = i + 2;
        while (j < rest.length && (rest[j] === ' ' || rest[j] === '\t')) j++;
        return j === rest.length ? i + 2 : -1;
      }
      return -1;
    }
    if (ch === ' ' || ch === '\t') {
      // Attribute: name, optional = value.
      let j = i;
      while (j < rest.length && (rest[j] === ' ' || rest[j] === '\t')) j++;
      if (!/[A-Za-z_:]/.test(rest[j] || '')) return -1;
      while (j < rest.length && /[\w.:-]/.test(rest[j])) j++;
      while (j < rest.length && (rest[j] === ' ' || rest[j] === '\t')) j++;
      if (rest[j] === '=') {
        j++;
        while (j < rest.length && (rest[j] === ' ' || rest[j] === '\t')) j++;
        if (rest[j] === '"') {
          j++;
          while (j < rest.length && rest[j] !== '"' && rest[j] !== '\n') j++;
          if (rest[j] !== '"') return -1;
          j++;
        } else if (rest[j] === "'") {
          j++;
          while (j < rest.length && rest[j] !== "'" && rest[j] !== '\n') j++;
          if (rest[j] !== "'") return -1;
          j++;
        } else {
          let k = j;
          while (k < rest.length && !/[\s"'=<>`]/.test(rest[k])) k++;
          if (k === j) return -1;
          j = k;
        }
      }
      i = j;
      continue;
    }
    return -1;
  }
  return -1;
}

// HTML block. Returns null when the line does not start one.
function parseHtmlBlock(lines, i, rest, ind) {
  const start = htmlBlockStart(rest);
  if (!start) return null;
  let endLine = i;
  if (start.type <= 5) {
    // Terminator-based: find the line containing the terminator.
    const term = start.type === 1 ? '</' + start.tag + '>'
      : start.type === 2 ? '-->'
      : start.type === 3 ? '?>'
      : start.type === 4 ? '>'
      : ']]>';
    let found = false;
    for (let j = i; j < lines.length; j++) {
      const text = lineRest(lines[j]).toLowerCase();
      if (text.indexOf(term.toLowerCase()) !== -1) { endLine = j; found = true; break; }
    }
    if (!found) endLine = lines.length - 1;
  } else {
    // Blank-line-based: run to the first blank line.
    endLine = i;
    for (let j = i + 1; j < lines.length; j++) {
      if (lineBlank(lines[j])) break;
      endLine = j;
    }
  }
  const text = htmlRawText(lines, i, endLine, start.type <= 5 ? 'empty' : 'blank');
  const next = endLine + 1;
  return { html: text, end: next, block: { type: 'html' } };
}

// The raw text of an HTML block: lines i..endLine joined with '\n', plus
// the newline after endLine and the following blank lines (whitespace-only
// for 'blank', empty only for 'empty'), then ge()-trimmed.
function htmlRawText(lines, i, endLine, blankKind) {
  let raw = '';
  for (let k = i; k <= endLine; k++) {
    if (k > i) raw += '\n';
    raw += lineRest(lines[k]);
  }
  if (endLine + 1 < lines.length) {
    raw += '\n';
    for (let t = endLine + 1; t < lines.length; t++) {
      const r = lineRest(lines[t]);
      const isBlank = blankKind === 'blank' ? /^[ \t]*$/.test(r) : r === '';
      if (!isBlank) break;
      raw += r;
      if (t + 1 < lines.length) raw += '\n';
      else break;
    }
  }
  return geText(raw);
}

// Expand the leading whitespace of a string starting at column `start`.
function expandLeadingFrom(s, start) {
  let k = 0;
  let col = start;
  while (k < s.length && (s[k] === ' ' || s[k] === '\t')) {
    if (s[k] === ' ') col++;
    else col += 4 - (col % 4);
    k++;
  }
  if (k === 0) return s;
  return ' '.repeat(col - start) + s.slice(k);
}

// Strip a blockquote marker from a line: the indent, '>', one whitespace
// character, then expand the remaining leading whitespace.
function stripBlockquoteLine(l, ind) {
  const c = cloneLine(l);
  lineAdvance(c, ind + 1);
  const ch = linePeek(c);
  if (ch === ' ' || ch === '\t') lineAdvance(c, 1);
  expandLeading(c);
  return lineRest(c);
}

// Does this line start a block at an indent of at most R spaces (marked's
// nextBullet/hr/fences/heading/html/blockquote regexes for list items)?
function listStopLine(f, R) {
  let sp = 0;
  while (sp < f.length && f[sp] === ' ') sp++;
  // Marked's stop regexes use indent D(R) = clamp(R-1, 0, 3): a line
  // indented more than min(3, R-1) spaces cannot be a stop.
  if (sp > Math.min(3, R - 1)) return false;
  const rest = f.slice(sp);
  if (rest[0] === '\t') return false;
  if (rest.startsWith('```') || rest.startsWith('~~~')) return true;
  if (matchAtx(rest) !== null) return true;
  if (isInterruptHtml(rest)) return true;
  if (rest[0] === '>') return true;
  if (matchHr(rest)) return true;
  const lm = matchListMarker(rest);
  if (lm) {
    const after = rest[lm.markerLen];
    if (after === undefined || after === ' ' || after === '\t') return true;
  }
  return false;
}

// The fence/heading/html/hr stop tests on a list item's previous line
// content (marked tests only these four on `m`). Same R-1 threshold.
function listStopLineM(m, R) {
  let sp = 0;
  while (sp < m.length && m[sp] === ' ') sp++;
  if (sp > Math.min(3, R - 1)) return false;
  const rest = m.slice(sp);
  if (rest[0] === '\t') return false;
  if (rest.startsWith('```') || rest.startsWith('~~~')) return true;
  if (matchAtx(rest) !== null) return true;
  if (isInterruptHtml(rest)) return true;
  if (matchHr(rest)) return true;
  return false;
}

// Can a lazy (non-'>') line be consumed by the blockquote whose inner
// lines are `inner`? Returns the last inner block's type, or false.
function canLazyContinue(inner, ln, refs) {
  if (inner.length === 0) return false;
  if (lineBlank(inner[inner.length - 1])) return false;
  // The probe parse is speculative: save and restore the document-wide
  // inLink state so it cannot leak into the real parse.
  const savedInLink = refs.inLink;
  const res = parseBlocks(inner, refs, true);
  refs.inLink = savedInLink;
  if (res.blocks.length === 0) return false;
  const last = res.blocks[res.blocks.length - 1];
  if (last.type === 'paragraph' || last.type === 'text') {
    const ind = lineIndent(ln);
    if (ind >= 4) return last.type;
    const probe = cloneLine(ln);
    lineAdvance(probe, ind);
    return !isInterrupt(lineRest(probe), true) ? last.type : false;
  }
  if (last.type === 'list') {
    const st = last.lastItemLazy;
    if (!st) return false;
    const f = lineRest(ln);
    if (listStopLine(f, st.R)) return false;
    if (st.y) return false;
    if (st.m.replace(/\t/g, '    ').search(/[^ ]/) >= 4) return false;
    if (listStopLineM(st.m, st.R)) return false;
    return last.type;
  }
  if (last.type === 'blockquote') {
    return canLazyContinue(last.innerLines, ln, refs);
  }
  return false;
}

function parseBlockquote(lines, i, refs) {
  const inner = [];
  let j = i;
  let prevWasLazy = false;
  while (j < lines.length) {
    const ln = lines[j];
    const ind = lineIndent(ln);
    if (ind <= 3) {
      const probe = cloneLine(ln);
      lineAdvance(probe, ind);
      if (lineRest(probe)[0] === '>') {
        inner.push(makeLine(stripBlockquoteLine(ln, ind)));
        prevWasLazy = false;
        j++;
        continue;
      }
    }
    if (lineBlank(ln)) break;
    const lt = canLazyContinue(inner, ln, refs);
    if (!lt) break;
    let text = lineRest(ln);
    let lazyPara = false;
    // A lazy line that continues a paragraph is lexed by marked as its
    // own chunk, so an indented line becomes a code token merged with
    // the indent stripped (4 columns). The stripped line must stay
    // paragraph text (it may now look like a list/heading/hr), so flag
    // it for the paragraph parser.
    if ((lt === 'paragraph' || lt === 'text') && lineIndent(ln) >= 4) {
      text = stripCodeIndentStr(text);
      lazyPara = true;
    }
    // A lazy setext underline is re-indented by 4 spaces when it is not
    // the first line of its chunk (marked's blockquoteSetextReplace).
    if (prevWasLazy) {
      const lind = lineIndent(ln);
      if (lind <= 3) {
        const p = cloneLine(ln);
        lineAdvance(p, lind);
        if (isSetextUnderline(lineRest(p)) !== 0) {
          text = '    ' + expandLeadingStr(text).replace(/^ {0,3}/, '');
        }
      }
    }
    const ml = makeLine(text);
    if (lazyPara) ml.lazyPara = true;
    inner.push(ml);
    prevWasLazy = true;
    j++;
  }
  const res = parseBlocks(inner, refs, true);
  return {
    html: '<blockquote>\n' + res.html + '</blockquote>\n',
    end: j,
    block: { type: 'blockquote', innerLines: inner },
  };
}

// Gather one list item starting at line i. Returns the item's inner lines
// (fresh line objects), its text, where it ends, and the lazy state of
// its last line (for blockquotes that contain the list).
function gatherListItem(lines, i, ind0, marker) {
  const first = lines[i];
  const b = ind0 + marker.markerLen;
  // The text after the marker, with its leading whitespace expanded from
  // column b (marked's J(g, b)).
  const m = stripToString(first, b);
  const y0 = !m.trim();
  let R;
  let d;
  if (y0) {
    R = b + 1;
    d = '';
  } else {
    R = m.search(/[^ ]/);
    if (R > 4) R = 1;
    d = m.slice(R);
    R += b;
  }
  const innerStrs = [];
  if (!y0) innerStrs.push(d);
  let y = y0;
  let mCur = m;
  let j = i + 1;
  // An empty first line followed by a blank line ends the item.
  if (y0 && j < lines.length && lineBlank(lines[j])) {
    return { inner: [], text: '', end: j + 1, lastLazy: null, rawEnd: j + 1, firstEmpty: true };
  }
  while (j < lines.length) {
    const ln = lines[j];
    const f = lineRest(ln);
    const Z = expandLeadingStr(f);
    if (listStopLine(f, R)) break;
    if (Z.search(/[^ ]/) >= R || !f.trim()) {
      innerStrs.push(Z.slice(R));
    } else {
      if (y || mCur.replace(/\t/g, '    ').search(/[^ ]/) >= 4 || listStopLineM(mCur, R)) break;
      // Setext special case: a lazy setext underline is re-indented.
      let qe = f;
      if (/^ {0,3}(?:=+|-+) *$/.test(f)) {
        const subj = mCur + '\n' + f;
        if (isSetextHeadingText(subj)) qe = '    ' + Z.replace(/^ {0,3}/, '');
      }
      innerStrs.push(qe);
    }
    y = !f.trim();
    mCur = Z.slice(R);
    j++;
  }
  const inner = innerStrs.map((s) => makeLine(s));
  // `end` stops after the last non-blank line: trailing blank lines are
  // part of the item's text but must stay visible to the caller as
  // separators (for the list loose determination). `rawEnd` keeps them
  // for the item's raw text.
  let end = j;
  while (end > i + 1 && lineBlank(lines[end - 1])) end--;
  return {
    inner,
    text: innerStrs.join('\n'),
    end,
    lastLazy: { R, m: mCur, y },
    rawEnd: j,
    firstEmpty: y0,
  };
}

// Would `${m}\n${f}` be a setext heading (the paragraph part must not
// start a block)? Used for the list's lazy setext re-indentation.
function isSetextHeadingText(subj) {
  const first = subj.split('\n', 1)[0];
  const ind = (() => { let k = 0; while (k < first.length && first[k] === ' ') k++; return k; })();
  if (ind > 3) return false;
  const rest = first.slice(ind);
  if (rest[0] === '\t') return false;
  if (matchAtx(rest) !== null || matchFence(rest) !== null || matchHr(rest)) return false;
  if (rest[0] === '>') return false;
  if (isInterruptHtml(rest)) return false;
  const lm = matchListMarker(rest);
  if (lm) {
    const after = rest[lm.markerLen];
    if ((after === ' ' || after === '\t') && (!lm.ordered || lm.start === 1)) return false;
  }
  return true;
}

function parseList(lines, i, refs) {
  const first = lines[i];
  const ind0 = lineIndent(first);
  const probe0 = cloneLine(first);
  lineAdvance(probe0, ind0);
  const rest0 = lineRest(probe0);
  const marker0 = matchListMarker(rest0);
  if (!marker0) return null;
  const after0 = rest0[marker0.markerLen];
  if (after0 !== undefined && after0 !== ' ' && after0 !== '\t') return null;
  if (matchHr(rest0)) return null;
  const ordered = marker0.ordered;
  const delim = marker0.delim;
  const bullet = rest0[0];
  const startNum = marker0.start;
  const items = [];
  let j = i;
  let loose = false;
  let p = false;
  while (j < lines.length) {
    // Skip blank lines between items (the list's end does not swallow
    // them, so the caller can see them as separators).
    let k = j;
    while (k < lines.length && lineBlank(lines[k])) k++;
    if (k >= lines.length) break;
    const ln = lines[k];
    const indJ = lineIndent(ln);
    if (indJ > 3) break;
    const pj = cloneLine(ln);
    lineAdvance(pj, indJ);
    const rj = lineRest(pj);
    const mj = matchListMarker(rj);
    if (!mj || mj.ordered !== ordered) break;
    if (ordered && mj.delim !== delim) break;
    if (!ordered && rj[0] !== bullet) break;
    const afterJ = rj[mj.markerLen];
    if (afterJ !== undefined && afterJ !== ' ' && afterJ !== '\t') break;
    if (matchHr(rj)) break;
    const itemStart = k;
    const it = gatherListItem(lines, k, indJ, mj);
    // The item's raw text (for the double-blank-line loose test).
    const rawEnd = it.rawEnd;
    let rawStr = '';
    for (let k = itemStart; k < rawEnd; k++) {
      if (k > itemStart) rawStr += '\n';
      rawStr += lineRest(lines[k]);
    }
    if (rawEnd < lines.length) rawStr += '\n';
    const hasDoubleBlank = /\n[ \t]*\n[ \t]*$/.test(rawStr);
    const trailingBlank = rawEnd > itemStart && lineBlank(lines[rawEnd - 1]);
    const res = parseBlocks(it.inner, refs, false);
    const item = {
      blocks: res.blocks,
      innerLoose: res.loose,
      text: it.text,
      lastLazy: it.lastLazy,
      hasDoubleBlank,
      trailingBlank,
      raw: rawStr,
      checkbox: null,
    };
    // Task checkbox: strip the "[ ] " prefix from the first text block.
    if (/^\[[ xX]\][ \t]+\S/.test(it.text) && res.blocks.length > 0 && res.blocks[0].type === 'text') {
      const b0 = res.blocks[0];
      const tm = /^\[[ xX]\][ \t]+/.exec(b0.text);
      if (tm) {
        b0.text = b0.text.slice(tm[0].length);
        b0.inner = inlineParse(b0.text, refs);
        b0.html = b0.inner;
        item.checkbox = tm[0][1] === ' ' ? '<input disabled="" type="checkbox"> ' : '<input checked="" disabled="" type="checkbox"> ';
      }
    }
    items.push(item);
    // Loose determination (marked's `p` mechanism).
    if (!loose) {
      if (p) loose = true;
      else if (hasDoubleBlank) p = true;
    }
    j = it.end;
    // A blank line between items also makes the list loose; it is already
    // covered by hasDoubleBlank on the previous item's raw.
    void trailingBlank;
  }
  if (items.length === 0) return null;
  // Any item with two blocks separated by a blank line makes it loose.
  if (!loose) {
    for (const it of items) if (it.innerLoose) { loose = true; break; }
  }
  // Render.
  const tag = ordered ? 'ol' : 'ul';
  const startAttr = ordered && startNum !== 1 ? ' start="' + startNum + '"' : '';
  let html = '<' + tag + startAttr + '>\n';
  for (let ii = 0; ii < items.length; ii++) {
    const it = items[ii];
    const isLastItem = ii === items.length - 1;
    html += '<li>';
    for (let bi = 0; bi < it.blocks.length; bi++) {
      const b = it.blocks[bi];
      if (b.type === 'text') {
        let inner = b.inner;
        if (bi === 0 && it.checkbox) inner = it.checkbox + inner;
        html += loose ? '<p>' + inner + '</p>\n' : inner;
      } else if (
        b.type === 'html' &&
        (!loose || isLastItem) &&
        bi === it.blocks.length - 1 &&
        b.html.endsWith('\n')
      ) {
        // An HTML block at the end of a list item has no trailing
        // newline when the blank line after it is not between items:
        // in a tight list there is no blank between items, and for the
        // last item of a loose list the blank line is after the list,
        // so marked's list item text ends at the last non-blank line
        // and the block's raw text has no trailing newline. A non-last
        // item of a loose list keeps it (the blank is between items).
        // Code and blockquote blocks keep their own trailing newline;
        // only raw HTML blocks drop it. When another block follows in
        // the same item, the newline is a needed separator.
        html += b.html.slice(0, -1);
      } else {
        html += b.html;
      }
    }
    html += '</li>\n';
  }
  html += '</' + tag + '>\n';
  const lastItem = items[items.length - 1];
  return {
    html,
    end: j,
    block: { type: 'list', lastItemLazy: lastItem.lastLazy },
  };
}

// The main block loop. Returns the rendered HTML, the block descriptors
// (for the blockquote lazy-line check), and whether two blocks are
// separated by a blank line (for the list loose determination).
function parseBlocks(lines, refs, top) {
  const blocks = [];
  let out = '';
  let loose = false;
  let sawBlank = false;
  let sawDef = false;
  let blockCount = 0;
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const ln = lines[i];
    if (lineBlank(ln)) { sawBlank = true; i++; continue; }
    const ind = lineIndent(ln);
    if (ind >= 4) {
      const code = parseIndentedCode(lines, i);
      out += code.html;
      blocks.push({ ...code.block, html: code.html });
      if (sawBlank && (blockCount > 0 || sawDef)) loose = true;
      sawBlank = false;
      blockCount++;
      i = code.end;
      continue;
    }
    const probe = cloneLine(ln);
    lineAdvance(probe, ind);
    const rest = lineRest(probe);
    const fence = matchFence(rest);
    if (fence) {
      const f = parseFenced(lines, i, fence, ind);
      out += f.html;
      blocks.push({ ...f.block, html: f.html });
      if (sawBlank && (blockCount > 0 || sawDef)) loose = true;
      sawBlank = false;
      blockCount++;
      i = f.end;
      continue;
    }
    const atx = matchAtx(rest);
    if (atx) {
      const html = '<h' + atx.depth + '>' + inlineParse(atx.text, refs) + '</h' + atx.depth + '>\n';
      out += html;
      blocks.push({ type: 'heading', html });
      if (sawBlank && (blockCount > 0 || sawDef)) loose = true;
      sawBlank = false;
      blockCount++;
      i++;
      continue;
    }
    if (matchHr(rest)) {
      out += '<hr>\n';
      blocks.push({ type: 'hr', html: '<hr>\n' });
      if (sawBlank && (blockCount > 0 || sawDef)) loose = true;
      sawBlank = false;
      blockCount++;
      i++;
      continue;
    }
    if (rest[0] === '>') {
      const bq = parseBlockquote(lines, i, refs);
      out += bq.html;
      blocks.push({ ...bq.block, html: bq.html });
      if (sawBlank && (blockCount > 0 || sawDef)) loose = true;
      sawBlank = false;
      blockCount++;
      i = bq.end;
      continue;
    }
    const lm = matchListMarker(rest);
    if (lm) {
      const after = rest[lm.markerLen];
      if (after === undefined || after === ' ' || after === '\t') {
        const list = parseList(lines, i, refs);
        if (list) {
          out += list.html;
          blocks.push({ ...list.block, html: list.html });
          if (sawBlank && (blockCount > 0 || sawDef)) loose = true;
          sawBlank = false;
          blockCount++;
          i = list.end;
          continue;
        }
      }
    }
    const htmlBlock = parseHtmlBlock(lines, i, rest, ind);
    if (htmlBlock) {
      out += htmlBlock.html;
      blocks.push({ ...htmlBlock.block, html: htmlBlock.html });
      if (sawBlank && (blockCount > 0 || sawDef)) loose = true;
      sawBlank = false;
      blockCount++;
      i = htmlBlock.end;
      continue;
    }
    const def = tryParseDef(lines, i, refs);
    if (def) {
      if (sawBlank && (blockCount > 0 || sawDef)) loose = true;
      sawDef = true;
      sawBlank = false;
      i = def.end;
      continue;
    }
    const para = parseParagraph(lines, i, refs, top);
    if (para) {
      out += para.html;
      blocks.push({ ...para.block, html: para.html });
      if (sawBlank && (blockCount > 0 || sawDef)) loose = true;
      sawBlank = false;
      blockCount++;
      i = para.end;
      continue;
    }
    // Unreachable in practice (a non-blank line is always a paragraph),
    // but never loop forever.
    i++;
  }
  return { html: out, blocks, loose };
}

export function parse(markdown) {
  const src = String(markdown).replace(/\r\n?/g, '\n');
  const refs = new Map();
  refs.inLink = false;
  const lines = src.split('\n').map((s) => makeLine(s));
  // First pass: collect every link reference definition in the document.
  // Marked lexes all blocks before parsing any inline content, so a
  // definition below a paragraph still applies to it; rendering inline
  // content eagerly would miss those. (The first pass's HTML is discarded.)
  parseBlocks(lines, refs, true);
  // Second pass: render with the complete reference table. The
  // document-wide inLink state is reset so the render pass replays it
  // from the start, exactly as marked's single lexing pass does.
  refs.inLink = false;
  return parseBlocks(lines, refs, true).html;
}
