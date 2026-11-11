#!/usr/bin/env node
// validate.mjs — 기사 JSON 검증 (예약 작업·CI 공용)
//
// 사용법
//   node tools/validate.mjs articles/2026/11/2026-11-28.json   (파일 하나 또는 여러 개)
//   node tools/validate.mjs --all                              (모든 기사 + index.json)
//
// 하나라도 실패하면 종료 코드 1, 어디가 틀렸는지 한국어로 출력한다.

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { validateArticle, validateIndex } from '../js/schema.js';
import { buildIndexItems } from './build-index.mjs';
import { ARTICLES_DIR, INDEX_PATH, listArticleFiles, readJson, relPath } from './lib.mjs';

/** 기사 파일 하나 검증. */
export async function validateFile(file) {
  const abs = resolve(file);
  let article;
  try {
    article = await readJson(abs);
  } catch (e) {
    return { file: abs, errors: [e.code === 'ENOENT' ? '파일이 없습니다.' : e.message], warnings: [], article: null };
  }
  const { errors, warnings } = validateArticle(article, { path: abs.split('\\').join('/') });
  return { file: abs, errors, warnings, article };
}

/** articles/index.json 이 실제 기사 파일들과 맞는지 검증. */
export async function validateIndexFile(dir = ARTICLES_DIR, indexPath = INDEX_PATH) {
  let index;
  try {
    index = await readJson(indexPath);
  } catch (e) {
    return { file: indexPath, errors: [e.code === 'ENOENT' ? 'index.json이 없습니다. node tools/build-index.mjs 를 실행하세요.' : e.message], warnings: [] };
  }
  const { errors } = validateIndex(index);
  if (!errors.length) {
    const { items } = await buildIndexItems(dir);
    if (JSON.stringify(items) !== JSON.stringify(index.items)) {
      const listed = new Set(index.items.map((i) => i.date));
      const actual = new Set(items.map((i) => i.date));
      const notListed = [...actual].filter((d) => !listed.has(d));
      const noFile = [...listed].filter((d) => !actual.has(d));
      if (notListed.length) errors.push(`목록에 빠진 기사: ${notListed.join(', ')}`);
      if (noFile.length) errors.push(`목록에는 있지만 파일이 없는 기사: ${noFile.join(', ')}`);
      if (!notListed.length && !noFile.length) errors.push('목록의 제목·분야·난이도가 기사 파일과 다릅니다.');
      errors.push('node tools/build-index.mjs 를 실행해 index.json을 다시 만드세요.');
    }
  }
  return { file: indexPath, errors, warnings: [] };
}

function report(result) {
  const name = relPath(result.file);
  if (result.errors.length) {
    console.log(`❌ ${name} — 오류 ${result.errors.length}건`);
    for (const e of result.errors) console.log(`   - ${e}`);
  } else {
    const words = result.article ? ` (${result.article.word_count}단어)` : '';
    console.log(`✅ ${name}${words}`);
  }
  for (const w of result.warnings) console.log(`   ⚠️  ${w}`);
}

async function main(argv) {
  const args = argv.slice(2);
  const all = args.includes('--all');
  const files = args.filter((a) => !a.startsWith('--'));
  if (!all && files.length === 0) {
    console.error('사용법: node tools/validate.mjs <기사.json ...>   또는   node tools/validate.mjs --all');
    process.exit(2);
  }

  const results = [];
  const targets = all ? await listArticleFiles() : files;
  for (const f of targets) results.push(await validateFile(f));
  if (all) results.push(await validateIndexFile());

  results.forEach(report);
  const failed = results.filter((r) => r.errors.length).length;
  const articleCount = all ? results.length - 1 : results.length;
  if (failed) {
    console.log(`\n검증 실패: ${failed}개 파일에 오류가 있습니다.`);
    process.exit(1);
  }
  console.log(`\n검증 통과: 기사 ${articleCount}개${all ? ' + index.json' : ''}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv).catch((e) => {
    console.error('오류: ' + e.message);
    process.exit(1);
  });
}
