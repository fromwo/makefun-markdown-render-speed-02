# markdown-render-speed-02

[![make.fun](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/c/markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/fromwo/makefun-markdown-render-speed-02/rank.svg)](https://make.fun/c/markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/fromwo/makefun-markdown-render-speed-02/reward.svg)](https://make.fun/c/markdown-render-speed-02)

A fast, dependency-free Markdown renderer written from scratch. It is a
drop-in replacement for [marked](https://github.com/markedjs/marked) 18.1.3
with the default options (GFM on, breaks off, pedantic off): `parse()` in
`parse.js` returns byte-identical HTML to `marked.parse` for CommonMark
0.31.2 plus the GFM extensions (tables, task lists, strikethrough,
extended autolinks, disallowed raw HTML).

This is an entry for the [make.fun competition
markdown-render-speed-02](https://make.fun/c/markdown-render-speed-02) — make
Markdown rendering faster.

## How it works

`parse.js` is a single self-contained ES module with no dependencies. It
lexes blocks line by line (headings, fences, indented code, lists,
blockquotes, HTML blocks, link reference definitions, tables, paragraphs)
and parses inline content with a delimiter-stack emphasis resolver, exactly
matching marked's output rules: tab expansion, link reference lookup,
entity handling, and the GFM table/list/blockquote edge cases.

`main.ts` is the driver: it reads `cases.json` from the input directory,
renders every case with `parse()`, and writes the HTML strings in order to
`html.json` in the output directory.

## Performance

Local practice set (720 cases, kit scorer: 720/720 passed), measured on
this machine (Node v24.22.1, shared-CPU VM, so times vary run to run):

- End-to-end `node main.ts` (startup + read + render + write): about
  1.8–2.1 s wall clock (four runs: 1.76, 1.94, 2.00, 2.07 s). The marked
  18.1.3 baseline driver measured 1.3–2.0 s on the same machine, so the
  wall-clock gap is within run-to-run noise here.
- Render-only, in-process (720 cases, excluding startup and I/O):
  first run about 1.65 s (JIT warm-up), warm steady state about
  0.74–0.79 s per full pass. Marked measured about 1.05 s cold and
  0.74–0.81 s warm on the same set — warm steady state is essentially
  tied on the practice set; the hidden-set timing is what the
  competition harness measures.

Reproduce the timing with the commands in [Test](#test) below, timing
`node main.ts` with `date +%s%N` before and after.

## Run

```sh
node main.ts
```

With the harness directories:

```sh
MAKEFUN_INPUT_DIR=/input MAKEFUN_OUTPUT_DIR=/output node main.ts
```

## Test

Against the kit's practice set and scorer:

```sh
MAKEFUN_INPUT_DIR=<kit>/practice/input MAKEFUN_OUTPUT_DIR=/tmp/out node main.ts
MAKEFUN_OUTPUT_DIR=/tmp/out MAKEFUN_REFERENCE_DIR=<kit>/practice/reference \
  MAKEFUN_SCORES_DIR=/tmp/out node <kit>/program/scorer/main.ts
```

## License

MIT — see [LICENSE](LICENSE).
