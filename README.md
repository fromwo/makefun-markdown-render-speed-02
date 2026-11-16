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
