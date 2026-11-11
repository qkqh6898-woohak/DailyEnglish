#!/usr/bin/env node
// update-sw.mjs — sw.js 의 "자동 생성" 구역(캐시 버전, 미리 저장할 파일 목록)을 다시 쓴다.
//
// 사용법
//   node tools/update-sw.mjs          앱 파일을 고친 뒤 실행 (sw.js 갱신)
//   node tools/update-sw.mjs --check  최신인지 확인만 (CI·테스트용, 아니면 종료 코드 1)
//
// 버전 = 앱 버전(js/version.js) + 앱 파일 내용의 해시 8자리.
// 앱 파일이 한 글자라도 바뀌면 버전이 바뀌어, 사용자에게 "새 버전이 있어요"가 뜬다.
// 기사(articles/)는 여기에 포함되지 않으므로 매일 기사를 올릴 때는 실행할 필요가 없다.

import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT } from './lib.mjs';

const SW_PATH = join(ROOT, 'sw.js');
const BLOCK_RE = /\/\* ── 자동 생성 시작 \(직접 고치지 마세요\) ── \*\/[\s\S]*?\/\* ── 자동 생성 끝 ── \*\//;

/** 미리 저장할 앱 파일 목록 (저장소 기준 상대 경로, 정렬됨) */
export async function shellFiles(root = ROOT) {
  const files = ['index.html', 'manifest.webmanifest', 'vendor/ts-fsrs.umd.js'];
  const add = async (dir, test) => {
    for (const name of await readdir(join(root, dir))) if (test(name)) files.push(`${dir}/${name}`);
  };
  await add('css', (n) => n.endsWith('.css'));
  await add('js', (n) => n.endsWith('.js'));
  await add('icons', (n) => n.endsWith('.png') || n === 'favicon.svg');
  return files.sort();
}

/** sw.js 에 들어갈 "자동 생성" 구역의 글 */
export async function generatedBlock(root = ROOT) {
  const files = await shellFiles(root);
  const hash = createHash('sha256');
  for (const f of files) {
    hash.update(f + '\0');
    hash.update(await readFile(join(root, f)));
    hash.update('\0');
  }
  const appVersion = /APP_VERSION = '([^']+)'/.exec(await readFile(join(root, 'js/version.js'), 'utf8'))?.[1] ?? '0.0.0';
  const version = `${appVersion}-${hash.digest('hex').slice(0, 8)}`;
  const list = files.map((f) => `  '${f}',`).join('\n');
  return {
    version,
    files,
    text: `/* ── 자동 생성 시작 (직접 고치지 마세요) ── */\nconst VERSION = '${version}';\nconst PRECACHE = [\n${list}\n];\n/* ── 자동 생성 끝 ── */`,
  };
}

/** sw.js 가 최신인지 확인하고, write가 true면 고쳐 쓴다. */
export async function syncServiceWorker({ write = false, root = ROOT } = {}) {
  const swPath = join(root, 'sw.js');
  const current = await readFile(swPath, 'utf8');
  if (!BLOCK_RE.test(current)) throw new Error('sw.js 에서 "자동 생성" 구역을 찾지 못했어요.');
  const block = await generatedBlock(root);
  const next = current.replace(BLOCK_RE, () => block.text);
  const upToDate = next === current;
  if (!upToDate && write) await writeFile(swPath, next);
  return { upToDate, version: block.version, files: block.files };
}

async function main() {
  const check = process.argv.includes('--check');
  const { upToDate, version, files } = await syncServiceWorker({ write: !check });
  if (upToDate) console.log(`✅ sw.js 최신 (버전 ${version}, 파일 ${files.length}개)`);
  else if (check) {
    console.log('❌ sw.js 가 앱 파일과 맞지 않아요. `node tools/update-sw.mjs` 를 실행한 뒤 함께 커밋하세요.');
    process.exit(1);
  } else console.log(`✅ sw.js 갱신 (버전 ${version}, 파일 ${files.length}개)`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error('오류: ' + e.message);
    process.exit(1);
  });
}

export { SW_PATH };
