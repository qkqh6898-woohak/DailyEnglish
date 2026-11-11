// 기사 JSON 검증(js/schema.js, tools/validate.mjs) 단위 테스트
// 실행: node --test tests/*.test.mjs

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';

import { articlePath, countWords, isRenderable, splitSentences, tokensToText, validateArticle, validateIndex } from '../js/schema.js';
import { buildIndexItems } from '../tools/build-index.mjs';
import { INDEX_PATH, listArticleFiles, readJson, ROOT, stringifyArticle } from '../tools/lib.mjs';
import { validateFile, validateIndexFile } from '../tools/validate.mjs';

const run = promisify(execFile);
const SAMPLE = join(ROOT, 'articles/2026/11/2026-11-09.json');
const SAMPLE_PATH = 'articles/2026/11/2026-11-09.json';

const loadSample = async () => JSON.parse(await readFile(SAMPLE, 'utf8'));

/** 샘플을 복사해 일부만 망가뜨린 뒤 검증한다. */
async function broken(mutate, opts = { path: SAMPLE_PATH }) {
  const a = await loadSample();
  mutate(a);
  return validateArticle(a, opts);
}

/** 오류가 정확히 하나이고 그 내용이 기대한 문구를 포함하는지 */
function assertOnlyError(result, pattern) {
  assert.equal(result.errors.length, 1, `오류가 1건이어야 하는데 ${result.errors.length}건:\n${result.errors.join('\n')}`);
  assert.match(result.errors[0], pattern);
}

test('샘플 기사는 모두 검증을 통과한다', async () => {
  const files = await listArticleFiles();
  assert.ok(files.length >= 3, '샘플 기사가 3개 이상 있어야 한다');
  for (const f of files) {
    const r = await validateFile(f);
    assert.deepEqual(r.errors, [], `${f}\n${r.errors.join('\n')}`);
    assert.deepEqual(r.warnings, [], `${f}\n${r.warnings.join('\n')}`);
  }
});

test('샘플 기사 구성: battery B2, economy B2, battery C1', async () => {
  const kinds = new Set();
  for (const f of await listArticleFiles()) {
    const a = await readJson(f);
    kinds.add(`${a.topic}/${a.level}`);
  }
  for (const k of ['battery/B2', 'economy/B2', 'battery/C1']) assert.ok(kinds.has(k), `${k} 샘플이 없다`);
});

// ── 의도적으로 깨뜨린 JSON 5종 (plan.md S1 완료 기준) ──────────────────

test('깨뜨린 JSON ① 필드 누락: 단어 토큰의 ko가 없으면 실패', async () => {
  const r = await broken((a) => {
    const tok = a.paragraphs[0].tokens.find((t) => t.t === 'worries');
    delete tok.ko;
  });
  assertOnlyError(r, /paragraphs\[0\]\.tokens\[\d+\] \("worries"\): 단어 토큰에 ko\(뜻\)가 없습니다/);
});

test('깨뜨린 JSON ② 잘못된 ph: 없는 구 id를 가리키면 실패', async () => {
  const r = await broken((a) => {
    const tok = a.paragraphs[0].tokens.find((t) => t.t === 'worries');
    tok.ph = 99;
  });
  assertOnlyError(r, /"worries"\): ph 99에 해당하는 phrases\[\]\.id가 이 문단에 없습니다/);
});

test('깨뜨린 JSON ③ 단어 수 범위 초과: 350단어를 넘으면 실패', async () => {
  const r = await broken((a) => {
    a.paragraphs.push(structuredClone(a.paragraphs[1])); // 문단 6개, 약 360단어
    a.word_count = countWords(a);
    assert.ok(a.word_count > 350);
  });
  assertOnlyError(r, /word_count: 250~350 범위여야 합니다/);
});

test('깨뜨린 JSON ④ 보기 개수 오류: 보기가 3개면 실패', async () => {
  const r = await broken((a) => {
    a.toeic_part5[0].choices.pop();
  });
  assertOnlyError(r, /toeic_part5\[0\]\.choices: 보기는 정확히 4개여야 합니다\. \(현재 3개\)/);
});

test('깨뜨린 JSON ⑤ 잘못된 날짜: 달력에 없는 날짜면 실패', async () => {
  const r = await broken((a) => {
    a.date = '2026-13-45';
  });
  assertOnlyError(r, /date: "YYYY-MM-DD" 형식의 실제 날짜여야 합니다/);
});

// ── 그 밖의 규칙 ────────────────────────────────────────────────────

test('파일 경로와 date가 다르면 실패', async () => {
  const r = await broken((a) => {
    a.date = '2026-11-08';
  });
  assertOnlyError(r, /파일 경로와 date가 맞지 않습니다/);
});

test('word_count가 실제 단어 수와 5 넘게 다르면 실패', async () => {
  const r = await broken((a) => {
    a.word_count += 6;
  });
  assertOnlyError(r, /실제 단어 수\(285\)와 5 넘게 차이 납니다/);
  const ok = await broken((a) => {
    a.word_count += 5;
  });
  assert.deepEqual(ok.errors, []);
});

test('구에 속한 토큰이 연속되지 않으면 실패', async () => {
  const r = await broken((a) => {
    const par = a.paragraphs[0];
    const rest = par.tokens.find((t) => t.t === 'rest'); // 어떤 구에도 속하지 않은, 떨어져 있는 단어
    assert.equal(rest.ph, undefined);
    rest.ph = 1; // wear out
  });
  assertOnlyError(r, /구에 속한 토큰들이 연속되어 있지 않습니다/);
});

test('구를 가리키는 토큰이 없으면 실패', async () => {
  const r = await broken((a) => {
    a.paragraphs[0].phrases.push({ id: 50, text: 'ramp up', ko: '늘리다' });
  });
  assertOnlyError(r, /phrases \(id 50\): 이 구를 가리키는 토큰\(ph\)이 없습니다/);
});

test('품사·뜻 길이·schema·topic 규칙', async () => {
  assertOnlyError(await broken((a) => (a.paragraphs[0].tokens[0].p = 'noun')), /p\(품사\)는 .* 중 하나여야 합니다/);
  assertOnlyError(await broken((a) => (a.paragraphs[0].tokens[0].ko = '가'.repeat(31))), /ko는 30자 이내여야 합니다/);
  assertOnlyError(await broken((a) => (a.schema = 2)), /schema: 1이어야 합니다/);
  assertOnlyError(await broken((a) => (a.topic = 'sports')), /topic: battery 또는 economy/);
  assertOnlyError(await broken((a) => (a.level = 'B3')), /level:/);
  assertOnlyError(await broken((a) => delete a.title.ko), /title:/);
  assertOnlyError(await broken((a) => (a.speaking = null)), /speaking: 배열이어야 합니다/);
});

test('출처는 1개 이상, https 주소만 허용', async () => {
  assertOnlyError(await broken((a) => (a.sources = [])), /sources: 출처가 1개 이상/);
  assertOnlyError(await broken((a) => (a.sources[0].url = 'http://example.com/a')), /sources\[0\]\.url: https:\/\//);
});

test('문단은 3~6개, 문단마다 번역이 있어야 한다', async () => {
  const few = await broken((a) => {
    a.paragraphs.length = 2;
    a.word_count = countWords(a);
  });
  assert.ok(few.errors.some((e) => /paragraphs: 문단은 3~6개여야 합니다/.test(e)));
  assertOnlyError(await broken((a) => (a.paragraphs[2].ko = '  ')), /paragraphs\[2\]\.ko: 문단의 한글 번역이 없습니다/);
});

test('토익 Part 5 규칙: 3문제, answer 0~3, 빈칸, type', async () => {
  assertOnlyError(await broken((a) => a.toeic_part5.pop()), /toeic_part5: 문제는 정확히 3개여야 합니다\. \(현재 2개\)/);
  assertOnlyError(await broken((a) => (a.toeic_part5[1].answer = 4)), /toeic_part5\[1\]\.answer: 0~3 사이의 정수/);
  assertOnlyError(await broken((a) => (a.toeic_part5[2].q = 'No blank here.')), /toeic_part5\[2\]\.q: 빈칸/);
  assertOnlyError(await broken((a) => (a.toeic_part5[0].type = 'grammar')), /toeic_part5\[0\]\.type/);
  assertOnlyError(await broken((a) => (a.toeic_part5[0].choices[1] = a.toeic_part5[0].choices[0])), /같은 보기가 중복/);
});

test('권장 사항은 오류가 아니라 경고로 알려 준다', async () => {
  const r = await broken((a) => {
    a.key_expressions.pop();
    a.summary_ko.pop();
    a.toeic_part5[1].type = a.toeic_part5[0].type;
  });
  assert.deepEqual(r.errors, []);
  assert.equal(r.warnings.length, 3);
});

test('선택 필드를 더해도 통과한다', async () => {
  const r = await broken((a) => {
    a.note = '선택 필드';
    a.paragraphs[0].tokens[0].extra = 1;
  });
  assert.deepEqual(r.errors, []);
});

test('숫자 토큰은 뜻이 없어도 되지만, 하나라도 달면 모두 있어야 한다', async () => {
  const r = await broken((a) => {
    const num = a.paragraphs[0].tokens.find((t) => t.t === '100,000');
    num.ko = '10만';
  });
  assert.equal(r.errors.length, 2); // l, p 누락
});

test('앱용 최소 확인(isRenderable)', async () => {
  const a = await loadSample();
  assert.equal(isRenderable(a), true);
  assert.equal(isRenderable({ ...a, paragraphs: [] }), false);
  assert.equal(isRenderable({ ...a, date: 'today' }), false);
  assert.equal(isRenderable(null), false);
});

test('토큰을 이으면 자연스러운 원문이 된다', async () => {
  for (const f of await listArticleFiles()) {
    const a = await readJson(f);
    for (const par of a.paragraphs) {
      const text = tokensToText(par.tokens);
      assert.doesNotMatch(text, /\s[,.;:!?)]/, `구두점 앞 공백: ${text}`);
      assert.doesNotMatch(text, /[(]\s/, `괄호 뒤 공백: ${text}`);
      assert.doesNotMatch(text, /\s{2,}/);
      assert.match(text, /^[A-Z].*[.?!]$/s);
    }
  }
});

test('문장 나누기', async () => {
  const a = await loadSample();
  const tokens = a.paragraphs[3].tokens; // Why does this matter? Battery health ... If carmakers ...
  const sentences = splitSentences(tokens).map((s) => tokensToText(tokens, s.start, s.end));
  assert.equal(sentences.length, 3);
  assert.equal(sentences[0], 'Why does this matter?');
  assert.match(sentences[2], /^If carmakers .* electric car\.$/);
  assert.equal(sentences.join(' '), tokensToText(tokens));
});

test('저장 형식(stringifyArticle)은 다시 읽어도 같은 내용이다', async () => {
  const text = await readFile(SAMPLE, 'utf8');
  const a = JSON.parse(text);
  assert.equal(stringifyArticle(a), text);
});

// ── index.json ──────────────────────────────────────────────────────

test('index.json은 실제 기사 파일과 일치한다', async () => {
  const index = await readJson(INDEX_PATH);
  assert.deepEqual(validateIndex(index).errors, []);
  const { items, skipped } = await buildIndexItems();
  assert.deepEqual(skipped, []);
  assert.deepEqual(index.items, items);
  for (const it of index.items) assert.equal(it.path, articlePath(it.date));
  assert.deepEqual((await validateIndexFile()).errors, []);
});

test('index.json 규칙: 최신순 정렬, 중복 날짜 금지, 경로 일치', async () => {
  const index = await readJson(INDEX_PATH);
  const reversed = { ...index, items: [...index.items].reverse() };
  assert.ok(validateIndex(reversed).errors.some((e) => /최신 날짜가 먼저/.test(e)));
  const dup = { ...index, items: [index.items[0], index.items[0]] };
  assert.ok(validateIndex(dup).errors.some((e) => /중복/.test(e)));
  const badPath = { ...index, items: [{ ...index.items[0], path: 'articles/x.json' }] };
  assert.ok(validateIndex(badPath).errors.some((e) => /path/.test(e)));
});

// ── 명령줄 ──────────────────────────────────────────────────────────

test('명령줄: --all 은 종료 코드 0', async () => {
  const { stdout } = await run(process.execPath, ['tools/validate.mjs', '--all'], { cwd: ROOT });
  assert.match(stdout, /검증 통과: 기사 \d+개 \+ index\.json/);
});

test('명령줄: 깨진 파일은 종료 코드 1과 한국어 설명', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'de-validate-'));
  try {
    const file = join(dir, 'articles/2026/11/2026-11-09.json');
    await mkdir(join(dir, 'articles/2026/11'), { recursive: true });
    const a = await loadSample();
    a.toeic_part5[0].choices.pop();
    await writeFile(file, JSON.stringify(a));
    await assert.rejects(run(process.execPath, ['tools/validate.mjs', file], { cwd: ROOT }), (e) => {
      assert.equal(e.code, 1);
      assert.match(e.stdout, /보기는 정확히 4개여야 합니다/);
      assert.match(e.stdout, /검증 실패/);
      return true;
    });

    await writeFile(file, '{ "schema": 1, ');
    await assert.rejects(run(process.execPath, ['tools/validate.mjs', file], { cwd: ROOT }), (e) => {
      assert.equal(e.code, 1);
      assert.match(e.stdout, /JSON 형식이 깨졌습니다/);
      return true;
    });

    await assert.rejects(run(process.execPath, ['tools/validate.mjs', join(dir, 'none.json')], { cwd: ROOT }), (e) => {
      assert.equal(e.code, 1);
      assert.match(e.stdout, /파일이 없습니다/);
      return true;
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
