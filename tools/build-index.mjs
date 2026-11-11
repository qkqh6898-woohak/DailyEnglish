#!/usr/bin/env node
// build-index.mjs — articles/ 아래의 기사 파일을 모아 articles/index.json 을 다시 만든다.
//
// 사용법
//   node tools/build-index.mjs
//
// 목록 내용이 바뀌지 않았으면 파일을 건드리지 않는다(updated 시각 유지).

import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { indexItemOf, isRenderable } from '../js/schema.js';
import { ARTICLES_DIR, INDEX_PATH, kstIsoNow, listArticleFiles, readJson, relPath } from './lib.mjs';

/** 기사 파일들을 읽어 목록 항목(최신순)을 만든다. */
export async function buildIndexItems(dir = ARTICLES_DIR) {
  const items = [];
  const skipped = [];
  for (const file of await listArticleFiles(dir)) {
    try {
      const a = await readJson(file);
      if (!isRenderable(a) || typeof a.title?.ko !== 'string') throw new Error('기사 형식이 아닙니다.');
      items.push(indexItemOf(a));
    } catch (e) {
      skipped.push({ file, reason: e.message });
    }
  }
  items.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  return { items, skipped };
}

export function stringifyIndex(index) {
  const lines = index.items.map((it) => '    ' + JSON.stringify(it));
  return `{\n  "updated": ${JSON.stringify(index.updated)},\n  "items": [\n${lines.join(',\n')}\n  ]\n}\n`;
}

async function main() {
  const { items, skipped } = await buildIndexItems();
  for (const s of skipped) console.error(`⚠️  건너뜀: ${relPath(s.file)} — ${s.reason}`);

  let previous = null;
  try {
    previous = await readJson(INDEX_PATH);
  } catch {
    /* 처음 만드는 경우 */
  }
  if (previous && JSON.stringify(previous.items) === JSON.stringify(items)) {
    console.error(`✅ articles/index.json 변경 없음 (기사 ${items.length}개)`);
    return;
  }
  await writeFile(INDEX_PATH, stringifyIndex({ updated: kstIsoNow(), items }));
  console.error(`✅ articles/index.json 갱신 (기사 ${items.length}개)`);
  if (skipped.length) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error('오류: ' + e.message);
    process.exit(1);
  });
}
