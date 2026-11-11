// lib.mjs — tools/ 스크립트가 함께 쓰는 파일 처리 함수

import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 저장소 최상위 폴더 */
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const ARTICLES_DIR = join(ROOT, 'articles');
export const INDEX_PATH = join(ARTICLES_DIR, 'index.json');

const ARTICLE_FILE = /^\d{4}-\d{2}-\d{2}\.json$/;

/** 저장소 기준 상대 경로 (항상 / 로 구분) */
export function relPath(absPath, root = ROOT) {
  return relative(root, absPath).split(sep).join('/');
}

export async function readJson(path) {
  const text = await readFile(path, 'utf8');
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`JSON 형식이 깨졌습니다: ${e.message}`);
  }
}

/** articles/ 아래의 기사 파일(YYYY-MM-DD.json)을 모두 찾아 절대 경로로 돌려준다. (날짜 오름차순) */
export async function listArticleFiles(dir = ARTICLES_DIR) {
  const out = [];
  async function walk(d) {
    let entries;
    try {
      entries = await readdir(d, { withFileTypes: true });
    } catch (e) {
      if (e.code === 'ENOENT') return;
      throw e;
    }
    for (const ent of entries) {
      const p = join(d, ent.name);
      if (ent.isDirectory()) await walk(p);
      else if (ARTICLE_FILE.test(ent.name)) out.push(p);
    }
  }
  await walk(dir);
  return out.sort((a, b) => a.split(sep).pop().localeCompare(b.split(sep).pop()));
}

/**
 * 기사 JSON을 사람이 읽기 좋은 모양으로 저장용 문자열로 만든다.
 * 토큰·구는 한 줄에 하나씩 써서 파일이 지나치게 길어지지 않게 한다.
 */
export function stringifyArticle(article) {
  const inline = [];
  const mark = (obj) => {
    inline.push(JSON.stringify(obj));
    return `@@INLINE_${inline.length - 1}@@`;
  };
  const prepared = {
    ...article,
    paragraphs: (article.paragraphs ?? []).map((par) => ({
      ...par,
      tokens: (par.tokens ?? []).map(mark),
      ...(par.phrases ? { phrases: par.phrases.map(mark) } : {}),
    })),
  };
  return JSON.stringify(prepared, null, 2).replace(/"@@INLINE_(\d+)@@"/g, (_, i) => inline[Number(i)]) + '\n';
}

/** 현재 시각을 한국 시간(KST) ISO 문자열로. 예: 2026-11-28T06:52:00+09:00 */
export function kstIsoNow(now = new Date()) {
  return new Date(now.getTime() + 9 * 3600 * 1000).toISOString().replace(/\.\d{3}Z$/, '+09:00');
}
