// Driver for the markdown-render-speed-02 entry.
// Reads cases from the input directory, renders each one with parse(),
// and writes the HTML strings (in order) to the output directory.
//
// Usage:
//   MAKEFUN_INPUT_DIR=<dir> MAKEFUN_OUTPUT_DIR=<dir> node main.ts
// Both default to /input and /output.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

// Harness directories, overridable by environment: MAKEFUN_INPUT_DIR is
// where cases.json is read from, MAKEFUN_OUTPUT_DIR is where html.json is
// written. Both default to the container paths /input and /output.
// The driver stays thin on purpose: all rendering lives in parse.js.
const inputDir = process.env.MAKEFUN_INPUT_DIR || '/input';
const outputDir = process.env.MAKEFUN_OUTPUT_DIR || '/output';

const cases = JSON.parse(readFileSync(join(inputDir, 'cases.json'), 'utf8'));

const renderedHtml = [];
for (let i = 0; i < cases.length; i++) {
  renderedHtml.push(parse(cases[i].markdown));
}

mkdirSync(outputDir, { recursive: true });
writeFileSync(join(outputDir, 'html.json'), JSON.stringify(renderedHtml));
