#!/usr/bin/env node
// tokenize.mjs — 영어 글을 토큰 배열(t, sp)로 나눈다.
//
// 사용법
//   node tools/tokenize.mjs "The plant will ramp up output."
//   node tools/tokenize.mjs --file draft.txt        (빈 줄로 문단 구분)
//   node tools/tokenize.mjs --file draft.txt --bare (l, p, ko 빈 칸 없이 t, sp만)
//
// 출력: 문단별 토큰 뼈대 JSON. 단어 토큰에는 채워야 할 l(원형), p(품사), ko(뜻) 빈 칸이 붙는다.
// 한 번에 완성본을 만들려면 tools/build-article.mjs 를 쓰는 편이 쉽다.

import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { isWordToken } from '../js/schema.js';

const TOKEN_RE = new RegExp(
  [
    String.raw`(?:[A-Za-z]\.){2,}`, // U.S. · e.g. 같은 약어
    String.raw`[$€£₩¥]?\d+(?:[.,]\d+)*(?:[-–]\d+(?:[.,]\d+)*)?(?:%|(?:-[A-Za-z]+)+)?`, // 1,000 · 5.2 · 70% · $1.4 · 8–1 · 5-year
    String.raw`[A-Za-z]+(?:['’-][A-Za-z0-9]+)*`, // word · don't · state-of-the-art · mid-2027 · F-150
    String.raw`\s+`,
    String.raw`\S`, // 그 밖의 글자는 한 글자씩(구두점·기호)
  ].join('|'),
  'gu',
);

/**
 * 글 → 토큰 배열. 각 토큰은 { t, sp, start, end } (start/end는 글 안에서의 글자 위치).
 */
export function tokenizeWithOffsets(text) {
  const tokens = [];
  for (const m of String(text).matchAll(TOKEN_RE)) {
    const s = m[0];
    if (/^\s+$/u.test(s)) {
      if (tokens.length) tokens[tokens.length - 1].sp = true;
      continue;
    }
    tokens.push({ t: s, sp: false, start: m.index, end: m.index + s.length });
  }
  return tokens;
}

/** 글 → [{ t, sp }] */
export function tokenize(text) {
  return tokenizeWithOffsets(text).map(({ t, sp }) => ({ t, sp }));
}

/** 빈 줄로 나뉜 글 → 문단 배열 */
export function splitParagraphs(text) {
  return String(text)
    .replace(/\r\n?/g, '\n')
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

/** 문단별 토큰 뼈대. bare가 아니면 단어 토큰에 l, p, ko 빈 칸을 붙인다. */
export function skeleton(text, { bare = false } = {}) {
  return splitParagraphs(text).map((par) => ({
    ko: '',
    tokens: tokenize(par).map((tok) => (bare || !isWordToken(tok) ? tok : { ...tok, l: '', p: '', ko: '' })),
    phrases: [],
  }));
}

async function main(argv) {
  const args = argv.slice(2);
  const bare = args.includes('--bare');
  const fileAt = args.indexOf('--file');
  let text;
  if (fileAt !== -1) {
    const path = args[fileAt + 1];
    if (!path) throw new Error('--file 뒤에 파일 경로를 적어 주세요.');
    text = await readFile(path, 'utf8');
  } else {
    text = args.filter((a) => !a.startsWith('--')).join('\n\n');
  }
  if (!text || !text.trim()) {
    console.error('사용법: node tools/tokenize.mjs "영어 글"   또는   node tools/tokenize.mjs --file 글.txt [--bare]');
    process.exit(2);
  }
  const paragraphs = skeleton(text, { bare });
  const lines = paragraphs.map((p) => {
    const toks = p.tokens.map((t) => '      ' + JSON.stringify(t)).join(',\n');
    return `  {\n    "ko": "",\n    "tokens": [\n${toks}\n    ],\n    "phrases": []\n  }`;
  });
  console.log('[\n' + lines.join(',\n') + '\n]');
  const words = paragraphs.reduce((n, p) => n + p.tokens.filter((t) => /[A-Za-z0-9]/.test(t.t)).length, 0);
  console.error(`문단 ${paragraphs.length}개 · 단어 ${words}개`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv).catch((e) => {
    console.error('오류: ' + e.message);
    process.exit(1);
  });
}
