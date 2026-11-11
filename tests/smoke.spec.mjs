// 화면 스모크 테스트 (Playwright + Chromium)
// 실행: node --test tests/smoke.spec.mjs      (playwright가 설치되어 있어야 한다)
//
// 실제 브라우저에서 앱을 열고 1단계 완성 기준을 차례로 확인한다:
// 기사 열기 → 단어 탭 → 저장 → 단어장 → 복습(FSRS) → 퀴즈 → 백업·복원 → 오프라인 → 새 버전 알림.
// 브라우저의 시간대를 일부러 뉴욕으로 두어, 날짜 계산이 항상 한국 시간(KST) 기준인지도 함께 본다.

import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';

import { tokensToText } from '../js/schema.js';
import { ROOT } from '../tools/lib.mjs';
import { startServer } from '../tools/serve.mjs';

let chromium = null;
try {
  chromium = createRequire(import.meta.url)('playwright').chromium;
} catch {
  try {
    chromium = (await import('playwright')).chromium;
  } catch {
    /* playwright 없음 → 아래에서 건너뛴다 */
  }
}

const MOBILE = { width: 390, height: 844 };
const SMALL = { width: 360, height: 640 };
const LAPTOP = { width: 1280, height: 800 };

// 한국 시간 기준 시각들 (UTC로 적는다: KST = UTC+9)
const WED_NOON = '2026-11-11T03:00:00Z'; // 11/11(수) 12:00 KST — 오늘 기사 없음
const TUE_NOON = '2026-11-10T03:00:00Z'; // 11/10(화) 12:00 KST — 오늘 기사 있음
const WED_EARLY = '2026-11-10T21:30:00Z'; // 11/11(수) 06:30 KST — 기사 도착 전
const SUN_NOON = '2026-11-15T03:00:00Z'; // 11/15(일) 12:00 KST — 주간 퀴즈가 열리는 날

const article = async (date) => JSON.parse(await readFile(join(ROOT, `articles/${date.slice(0, 4)}/${date.slice(5, 7)}/${date}.json`), 'utf8'));

/** 테스트용 가짜 음성 엔진. 말한 내용을 window.__spoken 에 기록한다. */
function installFakeSpeech() {
  const spoken = [];
  window.__spoken = spoken;
  let current = null;
  let timer = null;
  class FakeUtterance {
    constructor(text) {
      this.text = text;
      this.rate = 1;
      this.lang = '';
      this.voice = null;
    }
  }
  const synth = {
    speaking: false,
    getVoices: () => [
      { name: 'Test US', lang: 'en-US', voiceURI: 'test-us', default: true, localService: true },
      { name: 'Test GB', lang: 'en_GB', voiceURI: 'test-gb', default: false, localService: true },
      { name: 'Test KO', lang: 'ko-KR', voiceURI: 'test-ko', default: false, localService: true },
    ],
    speak(u) {
      current = u;
      synth.speaking = true;
      spoken.push({ text: u.text, rate: u.rate, lang: u.lang, voice: u.voice ? u.voice.voiceURI : null });
      timer = setTimeout(() => {
        if (u.onstart) u.onstart({});
        timer = setTimeout(() => {
          synth.speaking = false;
          current = null;
          if (u.onend) u.onend({});
        }, window.__speechMs || 120);
      }, 10);
    },
    cancel() {
      clearTimeout(timer);
      const u = current;
      current = null;
      synth.speaking = false;
      if (u && u.onerror) setTimeout(() => u.onerror({ error: 'interrupted' }), 0);
    },
    pause() {},
    resume() {},
    addEventListener() {},
    removeEventListener() {},
  };
  Object.defineProperty(window, 'speechSynthesis', { value: synth, configurable: true });
  window.SpeechSynthesisUtterance = FakeUtterance;
}

function removeSpeech() {
  Object.defineProperty(window, 'speechSynthesis', { value: undefined, configurable: true });
  window.SpeechSynthesisUtterance = undefined;
}

describe('Daily English Reader 스모크 테스트', { skip: chromium ? false : 'playwright가 설치되어 있지 않아 건너뜁니다.' }, () => {
  let server;
  let browser;
  const contexts = [];

  before(async () => {
    server = await startServer({ port: 0, quiet: true });
    browser = await chromium.launch();
  });

  after(async () => {
    await Promise.all(contexts.map((c) => c.close().catch(() => {})));
    await browser?.close();
    await server?.close();
  });

  /**
   * 새 브라우저(빈 저장소)로 앱을 연다.
   * @returns {Promise<{ctx, page, problems: string[]}>} problems에는 콘솔 오류·예외가 쌓인다.
   */
  async function open({ viewport = MOBILE, time = WED_NOON, speech = 'fake', serviceWorkers = 'block', hash = '', userAgent, baseUrl, setup } = {}) {
    const mobile = viewport.width < 700;
    const ctx = await browser.newContext({
      viewport,
      deviceScaleFactor: 1,
      hasTouch: mobile,
      isMobile: mobile,
      locale: 'ko-KR',
      timezoneId: 'America/New_York',
      serviceWorkers,
      acceptDownloads: true,
      ...(userAgent ? { userAgent } : {}),
    });
    contexts.push(ctx);
    const page = await ctx.newPage();
    const problems = [];
    page.on('console', (m) => m.type() === 'error' && problems.push(m.text()));
    page.on('pageerror', (e) => problems.push('pageerror: ' + e.message));
    if (time) await page.clock.install({ time: new Date(time) });
    if (speech === 'fake') await page.addInitScript(installFakeSpeech);
    else if (speech === 'none') await page.addInitScript(removeSpeech);
    if (setup) await setup(page, ctx);
    await page.goto((baseUrl ?? server.url) + hash);
    return { ctx, page, problems };
  }

  const go = async (page, hash, selector) => {
    await page.evaluate((h) => (location.hash = h), hash);
    await page.waitForSelector(selector);
  };

  /** IndexedDB 저장소 내용을 통째로 읽는다. */
  const dbAll = (page, store) =>
    page.evaluate(
      (name) =>
        new Promise((resolve, reject) => {
          const open = indexedDB.open('dailyenglish');
          open.onerror = () => reject(open.error);
          open.onsuccess = () => {
            const req = open.result.transaction(name).objectStore(name).getAll();
            req.onsuccess = () => {
              open.result.close();
              resolve(req.result);
            };
            req.onerror = () => reject(req.error);
          };
        }),
      store,
    );

  /** 기사에서 단어를 눌러 ⭐ 저장한다. */
  async function saveFromArticle(page, text, { phrase = false } = {}) {
    await page.locator('.w', { hasText: new RegExp(`^${text}$`) }).first().click();
    const star = page.locator(phrase ? '.ws-phrase .star-btn' : '.ws-main .star-btn');
    await star.click();
    await page.locator(phrase ? '.ws-phrase .star-btn.on' : '.ws-main .star-btn.on').waitFor();
    await page.locator('.sheet-close').click();
    await page.locator('.sheet').waitFor({ state: 'detached' });
  }

  /** 설정 값이 기기에 저장될 때까지 기다린다. (저장은 비동기라서 바로 새로고침하면 놓칠 수 있다) */
  async function waitForSetting(page, key, value) {
    for (let i = 0; i < 50; i++) {
      const row = (await dbAll(page, 'settings')).find((x) => x.key === key);
      if (row && (value === undefined || row.value === value)) return;
      await page.waitForTimeout(40);
    }
    assert.fail(`설정 ${key}가 저장되지 않았다`);
  }

  const noOverflow = async (page, label) => {
    const { sw, iw } = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
    assert.ok(sw <= iw, `${label}: 가로로 넘치는 내용이 있다 (scrollWidth ${sw} > ${iw})`);
  };

  // ── 기사 화면 ──────────────────────────────────────────────────────

  test('오늘 화면: 기사가 보이고, 원문이 토큰 그대로 복원된다', async () => {
    const { page, problems } = await open();
    await page.waitForSelector('.article');
    const a = await article('2026-11-10');

    assert.equal(await page.locator('.article').getAttribute('data-date'), '2026-11-10', '오늘(11/11) 기사가 없으면 가장 최근 기사를 보여 준다');
    assert.match(await page.locator('.notice').first().innerText(), /오늘 기사가 아직 없어요/);
    assert.equal(await page.locator('.art-title').innerText(), a.title.en);
    assert.equal(await page.locator('.art-date').innerText(), '11월 10일 (화)');
    assert.match(await page.locator('.art-meta').innerText(), /경제[\s\S]*B2 · 284단어 · 약 3분[\s\S]*샘플/);

    const texts = await page.locator('.para-en').allInnerTexts();
    assert.deepEqual(
      texts,
      a.paragraphs.map((p) => tokensToText(p.tokens)),
      '문단의 공백·구두점이 원문과 같아야 한다',
    );
    const tappable = a.paragraphs.flatMap((p) => p.tokens).filter((t) => t.ko).length;
    assert.equal(await page.locator('.w').count(), tappable);
    assert.equal(await page.locator('.key-item').count(), 5);
    assert.equal(await page.locator('.sources a').count(), a.sources.length);
    assert.equal(await page.locator('.sources a').first().getAttribute('rel'), 'noopener noreferrer');
    assert.equal(await page.evaluate(() => location.hash), '#/today');
    assert.equal(await page.locator('#tabs a[aria-current="page"]').getAttribute('data-tab'), 'today');
    await noOverflow(page, '오늘 화면');
    assert.deepEqual(problems, []);
  });

  test('오늘 기사가 있으면 안내 없이 그 기사를, 아침 일찍이면 도착 안내를 보여 준다', async () => {
    const a = await open({ time: TUE_NOON });
    await a.page.waitForSelector('.article');
    assert.equal(await a.page.locator('.article').getAttribute('data-date'), '2026-11-10');
    assert.equal(await a.page.locator('.notice').count(), 0);

    const b = await open({ time: WED_EARLY });
    await b.page.waitForSelector('.article');
    assert.match(await b.page.locator('.notice').first().innerText(), /오늘 기사는 07:00경 도착해요/);
  });

  test('첫 문단의 모든 단어를 눌러도 문맥 뜻 창이 뜬다 (구두점·숫자는 제외)', async () => {
    const { page, problems } = await open();
    await page.waitForSelector('.article');
    const a = await article('2026-11-10');
    const tokens = a.paragraphs[0].tokens;
    const words = page.locator('.para[data-p="0"] .w');
    const expected = tokens.filter((t) => t.ko);
    assert.equal(await words.count(), expected.length);
    for (let i = 0; i < expected.length; i++) {
      await words.nth(i).click();
      const sheet = page.locator('.sheet');
      await sheet.waitFor();
      assert.equal(await sheet.locator('.ws-main .ws-word').innerText(), expected[i].t);
      assert.equal(await sheet.locator('.ws-main .ws-ko').innerText(), expected[i].ko);
      await page.keyboard.press('Escape');
      await sheet.waitFor({ state: 'detached' });
    }
    // 뜻이 없는 토큰(쉼표, 뜻을 달지 않은 숫자)은 눌러도 아무 일도 없다
    const plain = page.locator('.para[data-p="0"] .tok:not(.w)');
    assert.ok((await plain.count()) > 0);
    await plain.first().click();
    assert.equal(await page.locator('.sheet').count(), 0);
    assert.deepEqual(problems, []);
  });

  test('뜻 창: 원형·품사·예문·기사 문장, 구는 전체가 강조되고 구의 뜻이 먼저 나온다', async () => {
    const { page } = await open();
    await page.waitForSelector('.article');

    await page.locator('.w', { hasText: /^raised$/ }).first().click();
    const sheet = page.locator('.sheet');
    await sheet.waitFor();
    assert.match(await sheet.locator('.ws-main').innerText(), /raised[\s\S]*동사[\s\S]*올리다, 인상하다[\s\S]*원형:\s*raise[\s\S]*The firm raised prices by 5%\./);
    assert.match(await sheet.locator('.ws-sentence').innerText(), /^기사 문장\s+The Bank of England raised its key interest rate/);
    assert.equal(await sheet.locator('.ws-sentence mark').innerText(), 'raised');
    assert.equal(await page.locator('.w.sel').innerText(), 'raised');
    assert.equal(await sheet.locator('.ws-phrase').count(), 0);
    await page.locator('.sheet-backdrop').click({ position: { x: 10, y: 10 } }); // 바깥을 누르면 닫힌다
    await sheet.waitFor({ state: 'detached' });
    assert.equal(await page.locator('.w.sel').count(), 0);

    // "ahead of the curve" 중 한 단어만 눌러도 구 전체가 강조된다
    await page.locator('.w', { hasText: /^curve$/ }).click();
    await sheet.waitFor();
    assert.deepEqual(await page.locator('.w.ph-sel').allInnerTexts(), ['ahead', 'of', 'the']);
    assert.equal(await page.locator('.w.sel').innerText(), 'curve');
    assert.match(await sheet.locator('.ws-phrase').innerText(), /ahead of the curve[\s\S]*\(변화에\) 한발 앞서[\s\S]*We must stay ahead of the curve\./);
    assert.equal(await sheet.locator('.ws-sentence mark').innerText(), 'ahead of the curve');
    const order = await sheet.locator('.ws-card').evaluateAll((els) => els.map((e) => e.className));
    assert.match(order[0], /ws-phrase/, '구 카드가 맨 위');
  });

  test('문단 번역을 펼치고 접을 수 있다', async () => {
    const { page } = await open();
    await page.waitForSelector('.article');
    const a = await article('2026-11-10');
    const para = page.locator('.para[data-p="1"]');
    assert.equal(await para.locator('.para-ko').isVisible(), false);
    const btn = para.locator('.chip-btn', { hasText: '번역' });
    assert.equal(await btn.getAttribute('aria-expanded'), 'false');
    await btn.click();
    assert.equal(await para.locator('.para-ko').innerText(), a.paragraphs[1].ko);
    assert.equal(await btn.getAttribute('aria-expanded'), 'true');
    assert.match(await btn.innerText(), /번역 접기/);
    assert.equal(await page.locator('.para[data-p="0"] .para-ko').isVisible(), false, '다른 문단은 그대로');
    await btn.click();
    assert.equal(await para.locator('.para-ko').isVisible(), false);

    // 3줄 요약
    await page.locator('.summary summary').click();
    assert.equal(await page.locator('.summary li').count(), 3);
  });

  // ── 발음 ───────────────────────────────────────────────────────────

  test('발음: 단어·예문·문장, 전체 듣기(문장 강조·일시정지·이어 듣기·정지), 문단 듣기, 속도', async () => {
    const { page, problems } = await open();
    await page.waitForSelector('.article');
    const a = await article('2026-11-10');
    const spoken = () => page.evaluate(() => window.__spoken.map((s) => s.text));

    // 단어·원형·예문·기사 문장
    await page.locator('.w', { hasText: /^raised$/ }).first().click();
    const sheet = page.locator('.sheet');
    await sheet.locator('.ws-main .ws-head .speak-btn').click();
    await page.waitForFunction(() => window.__spoken.length === 1);
    await sheet.locator('.ws-lemma .speak-btn').click();
    await page.waitForFunction(() => window.__spoken.length === 2);
    await sheet.locator('.ws-main .ws-ex .speak-btn').click();
    await page.waitForFunction(() => window.__spoken.length === 3);
    await sheet.locator('.ws-sentence .speak-btn').click();
    await page.waitForFunction(() => window.__spoken.length === 4);
    const first = await page.evaluate(() => window.__spoken);
    assert.deepEqual(
      first.map((s) => s.text),
      ['raised', 'raise', 'The firm raised prices by 5%.', tokensToText(a.paragraphs[0].tokens, 0, a.paragraphs[0].tokens.findIndex((t) => t.t === '.') + 1)],
    );
    assert.equal(first[0].voice, 'test-us', '기본은 미국식 음성');
    assert.equal(first[0].rate, 0.9, '기본 속도 0.9');
    await page.keyboard.press('Escape');
    await sheet.waitFor({ state: 'detached' });

    // 전체 듣기
    await page.evaluate(() => {
      window.__spoken.length = 0;
      window.__speechMs = 250;
    });
    const play = page.locator('.play-btn');
    assert.match(await play.innerText(), /전체 듣기/);
    await play.click();
    await page.waitForSelector('.sent.speaking');
    assert.match(await play.innerText(), /일시정지/);
    assert.equal(await page.locator('.player [aria-label="듣기 정지"]').isVisible(), true);
    assert.equal(await page.locator('.sent.speaking').count(), 1, '한 번에 한 문장만 강조');
    await page.waitForFunction(() => window.__spoken.length >= 3);

    await play.click(); // 일시정지
    assert.match(await play.innerText(), /이어 듣기/);
    const paused = await spoken();
    await page.waitForTimeout(600);
    assert.deepEqual(await spoken(), paused, '일시정지 중에는 더 읽지 않는다');

    await page.locator('.rate-select').selectOption('1.2');
    await play.click(); // 이어 듣기: 멈춘 문장부터 다시
    await page.waitForFunction((n) => window.__spoken.length > n, paused.length);
    const resumed = await page.evaluate(() => window.__spoken);
    assert.equal(resumed[paused.length].text, paused[paused.length - 1]);
    assert.equal(resumed[paused.length].rate, 1.2, '바꾼 속도가 다음 문장부터 적용된다');

    await page.locator('.player [aria-label="듣기 정지"]').click();
    assert.equal(await page.locator('.sent.speaking').count(), 0);
    assert.match(await play.innerText(), /전체 듣기/);

    const sentences = a.paragraphs.flatMap((p) => {
      const out = [];
      let start = 0;
      p.tokens.forEach((t, i) => {
        if (/^[.?!]$/.test(t.t) && (t.sp || i === p.tokens.length - 1)) {
          out.push(tokensToText(p.tokens, start, i + 1));
          start = i + 1;
        }
      });
      return out;
    });
    const all = (await spoken()).filter((t, i, arr) => arr.indexOf(t) === i);
    assert.equal(all[0], a.title.en, '제목부터 읽는다');
    assert.deepEqual(all.slice(1), sentences.slice(0, all.length - 1), '문장 순서대로 읽는다');

    // 문단 듣기: 그 문단만 읽고 끝나면 버튼이 원래대로 돌아온다
    await page.evaluate(() => {
      window.__spoken.length = 0;
      window.__speechMs = 30;
    });
    const p4 = page.locator('.para[data-p="3"] .chip-btn', { hasText: '문단 듣기' });
    await p4.click();
    await page.locator('.para[data-p="3"] .chip-btn', { hasText: '멈춤' }).waitFor();
    await page.locator('.para[data-p="3"] .chip-btn', { hasText: '문단 듣기' }).waitFor();
    assert.equal((await spoken()).join(' '), tokensToText(a.paragraphs[3].tokens));
    assert.deepEqual(problems, []);
  });

  test('발음: 설정에서 영국식을 고르면 영국식 음성으로, 미지원 브라우저에서는 버튼이 비활성화된다', async () => {
    const { page } = await open({ hash: '#/settings' });
    await page.waitForSelector('.settings');
    assert.deepEqual(await page.locator('select[aria-label="음성 선택"] option').allInnerTexts(), ['자동 (억양에 맞게)', 'Test US (en-US)', 'Test GB (en-GB)']);
    await page.locator('.seg', { hasText: '영국식' }).click();
    await page.locator('button', { hasText: '미리 듣기' }).click();
    await page.waitForFunction(() => window.__spoken.length === 1);
    assert.deepEqual(await page.evaluate(() => window.__spoken[0]), { text: 'This is how your daily article will sound.', rate: 0.9, lang: 'en-GB', voice: 'test-gb' });

    const none = await open({ speech: 'none' });
    await none.page.waitForSelector('.article');
    assert.equal(await none.page.locator('.play-btn').isDisabled(), true);
    assert.match(await none.page.locator('.player .hint').innerText(), /Chrome 또는 Safari/);
    assert.equal(await none.page.locator('.para-tools .chip-btn', { hasText: '문단 듣기' }).first().isDisabled(), true);
    await none.page.locator('.w').first().click();
    assert.equal(await none.page.locator('.sheet .speak-btn').first().isDisabled(), true);
    assert.deepEqual(none.problems, []);
  });

  // ── 단어장 ─────────────────────────────────────────────────────────

  test('⭐ 저장 → 단어장에 나타나고, 새로고침해도 남고, 같은 단어는 중복 저장되지 않는다', async () => {
    const { page, problems } = await open();
    await page.waitForSelector('.article');
    await saveFromArticle(page, 'raised');
    await saveFromArticle(page, 'curve', { phrase: true });
    assert.equal(await page.locator('#review-badge').innerText(), '2');

    // 저장한 단어는 점선 밑줄: raised, (다른 문단의) raise, ahead·of·the·curve
    assert.deepEqual(await page.locator('.w.saved').allInnerTexts(), ['raised', 'ahead', 'of', 'the', 'curve', 'raise']);
    // 핵심 표현 목록의 같은 구도 저장됨으로 표시
    assert.match(await page.locator('.key-item', { hasText: 'ahead of the curve' }).locator('.star-btn').innerText(), /저장됨/);

    // 같은 원형(raise)을 다른 문장에서 누르면 이미 저장됨으로 보이고, 문장만 추가할 수 있다
    await page.locator('.w', { hasText: /^raise$/ }).click();
    const sheet = page.locator('.sheet');
    assert.match(await sheet.locator('.ws-main .star-btn').innerText(), /저장됨/);
    assert.match(await sheet.locator('.ws-saved-note').innerText(), /단어장에 있음 · 11\/11 저장/);
    await sheet.locator('.link-btn', { hasText: '이 문장도 추가' }).click();
    await sheet.locator('.link-btn', { hasText: '이 문장도 추가' }).waitFor({ state: 'detached' });
    await page.keyboard.press('Escape');

    let words = await dbAll(page, 'words');
    assert.deepEqual(words.map((w) => w.id).sort(), ['ph:ahead of the curve', 'raise']);
    const raise = words.find((w) => w.id === 'raise');
    assert.equal(raise.kind, 'word');
    assert.equal(raise.text, 'raise');
    assert.equal(raise.pos, 'v');
    assert.equal(raise.ko, '올리다, 인상하다');
    assert.equal(raise.sources.length, 2, '두 번째 기사 문장이 더해졌다');
    assert.deepEqual(
      raise.sources.map((s) => s.t),
      ['raised', 'raise'],
    );
    assert.equal(raise.card.state, 0);
    assert.equal(raise.createdAt, '2026-11-11T03:00:00.000Z'.slice(0, 10) + raise.createdAt.slice(10), '저장 시각은 ISO 문자열');

    await page.reload();
    await page.waitForSelector('.article');
    await page.waitForFunction(() => document.querySelectorAll('.w.saved').length === 6);
    await go(page, '#/vocab', '.vocab-item');
    assert.equal(await page.locator('.vocab-item').count(), 2);
    assert.match(await page.locator('.vocab .view-sub').innerText(), /단어 1개 · 구 1개/);
    words = await dbAll(page, 'words');
    assert.equal(words.length, 2);

    // 별을 다시 누르면 단어장에서 빠진다
    await go(page, '#/today', '.article');
    await page.locator('.w', { hasText: /^raised$/ }).first().click();
    await page.locator('.ws-main .star-btn.on').click();
    await page.locator('.ws-main .star-btn:not(.on)').waitFor();
    assert.equal((await dbAll(page, 'words')).length, 1);
    assert.deepEqual(problems, []);
  });

  test('단어장 화면: 검색·필터·정렬, 상세, 뜻 수정, 직접 추가, 삭제', async () => {
    const { page, problems } = await open();
    await page.waitForSelector('.article');
    await saveFromArticle(page, 'raised');
    await page.clock.fastForward(60_000);
    await saveFromArticle(page, 'inflation');
    await page.clock.fastForward(60_000);
    await saveFromArticle(page, 'curve', { phrase: true });
    await go(page, '#/vocab', '.vocab-item');
    const names = () => page.locator('.vocab-item .vi-word').allInnerTexts();

    assert.deepEqual(await names(), ['ahead of the curve', 'inflation', 'raise'], '기본은 최근 저장순');
    await page.locator('select[aria-label="정렬"]').selectOption('alpha');
    assert.deepEqual(await names(), ['ahead of the curve', 'inflation', 'raise']);
    await page.locator('select[aria-label="정렬"]').selectOption('due');
    assert.deepEqual(await names(), ['raise', 'inflation', 'ahead of the curve'], '복습 전인 단어는 저장한 순서');

    await page.locator('.chip', { hasText: /^구$/ }).click();
    assert.deepEqual(await names(), ['ahead of the curve']);
    await page.locator('.chip', { hasText: /^단어$/ }).click();
    assert.deepEqual(await names(), ['raise', 'inflation']);
    await page.locator('.chip', { hasText: '어려운 단어' }).click();
    assert.equal(await page.locator('.vocab-item').count(), 0);
    assert.match(await page.locator('.empty-title').innerText(), /조건에 맞는 단어가 없어요/);
    await page.locator('.chip', { hasText: '전체' }).click();

    const search = page.locator('input[type="search"]');
    await search.fill('물가');
    assert.deepEqual(await names(), ['inflation'], '뜻으로 검색');
    await search.fill('RAISED');
    assert.deepEqual(await names(), ['raise'], '기사에 나온 형태로도 검색');
    await search.fill('');

    // 상세 → 뜻 수정
    const item = page.locator('.vocab-item', { hasText: 'inflation' });
    assert.match(await item.innerText(), /inflation\s+명사\s+새 단어\s+물가 상승\(률\), 인플레이션\s+저장 11\/11 · 아직 복습 전/);
    await item.click();
    const sheet = page.locator('.sheet');
    assert.match(await sheet.innerText(), /기사 문장 1개[\s\S]*warning that inflation is moving[\s\S]*11월 10일 \(화\) 기사 보기[\s\S]*복습 횟수\s+0회 \(틀림 0회\)/);
    await sheet.locator('.link-btn', { hasText: '수정' }).click();
    await sheet.locator('input[aria-label="뜻"]').fill('인플레이션');
    await sheet.locator('button[type="submit"]').click();
    await page.locator('.sheet .ws-ko', { hasText: /^인플레이션$/ }).waitFor();
    await page.keyboard.press('Escape');
    assert.match(await page.locator('.vocab-item', { hasText: 'inflation' }).innerText(), /인플레이션/);

    // 직접 추가 (띄어쓰기가 있으면 구)
    await page.locator('button', { hasText: '직접 추가' }).click();
    const form = page.locator('.sheet form');
    await form.locator('input').nth(0).fill('ramp  up');
    await form.locator('input').nth(1).fill('(생산을) 늘리다');
    await form.locator('input').nth(2).fill('We need to ramp up output.');
    await form.locator('button[type="submit"]').click();
    await page.locator('.vocab-item', { hasText: 'ramp up' }).waitFor();
    let words = await dbAll(page, 'words');
    const custom = words.find((w) => w.id === 'ph:ramp up');
    assert.equal(custom.custom, true);
    assert.equal(custom.kind, 'phrase');
    assert.equal(custom.ex, 'We need to ramp up output.');
    assert.deepEqual(custom.sources, []);

    // 같은 단어를 다시 추가하면 새로 만들지 않는다
    await page.locator('button', { hasText: '직접 추가' }).click();
    await page.locator('.sheet form input').nth(0).fill('Ramp Up');
    await page.locator('.sheet form input').nth(1).fill('다른 뜻');
    await page.locator('.sheet form button[type="submit"]').click();
    await page.locator('.toast', { hasText: '이미 단어장에 있는 단어예요' }).waitFor();
    assert.equal((await dbAll(page, 'words')).length, 4);
    await page.keyboard.press('Escape');

    // 삭제
    await page.locator('.vocab-item', { hasText: 'ramp up' }).click();
    await page.locator('.sheet button', { hasText: '단어장에서 지우기' }).click();
    await page.locator('.dialog button', { hasText: '지우기' }).click();
    await page.locator('.vocab-item', { hasText: 'ramp up' }).waitFor({ state: 'detached' });
    words = await dbAll(page, 'words');
    assert.equal(words.length, 3);
    await noOverflow(page, '단어장');
    assert.deepEqual(problems, []);
  });

  // ── 복습 ───────────────────────────────────────────────────────────

  test('복습: FSRS 간격 미리보기, 평가, 시간을 앞당기면 복습 일정대로 다시 나온다', async () => {
    const { page, problems } = await open();
    await page.waitForSelector('.article');
    await saveFromArticle(page, 'raised');
    await page.clock.fastForward(1000);
    await saveFromArticle(page, 'inflation');
    await go(page, '#/review', '.review-card');

    assert.match(await page.locator('.review .view-sub').innerText(), /오늘 복습 0개 · 새 단어 2개/);
    const card = page.locator('.review-card');
    assert.match(await card.innerText(), /새 단어\s+raise\s+동사[\s\S]*The Bank of England raised its key interest rate/);
    assert.equal(await card.locator('mark').innerText(), 'raised');
    assert.equal(await page.locator('.rc-ko').count(), 0, '뜻은 아직 가려져 있다');

    await page.locator('.btn-reveal').click();
    assert.equal(await page.locator('.rc-ko').innerText(), '올리다, 인상하다');
    const labels = await page.locator('.rating').allInnerTexts();
    assert.deepEqual(
      labels.slice(0, 3).map((t) => t.replace(/\s+/g, ' ')),
      ['다시 1분', '어려움 6분', '알맞음 10분'],
    );
    assert.match(labels[3].replace(/\s+/g, ' '), /^쉬움 \d+일$/);

    // 알맞음 → 10분 뒤 다시(학습 중). 다음 새 단어가 나온다
    await page.locator('.rating-good').click();
    await page.locator('.rc-word', { hasText: 'inflation' }).waitFor();
    let words = await dbAll(page, 'words');
    let raise = words.find((w) => w.id === 'raise');
    assert.equal(raise.card.state, 1, '학습 중');
    assert.equal(raise.card.reps, 1);
    assert.equal(Date.parse(raise.card.due) - Date.parse(raise.card.last_review), 10 * 60_000);

    // 되돌리기 → 방금 평가가 취소된다
    await page.locator('.link-btn', { hasText: '되돌리기' }).click();
    await page.locator('.rc-word', { hasText: /^raise$/ }).waitFor();
    assert.equal((await dbAll(page, 'reviewLogs')).length, 0);
    assert.equal((await dbAll(page, 'words')).find((w) => w.id === 'raise').card.state, 0);

    // 키보드: Space(뜻 보기) → 3(알맞음)
    await page.keyboard.press('Space');
    await page.locator('.rating-good').waitFor();
    await page.keyboard.press('3');
    await page.locator('.rc-word', { hasText: 'inflation' }).waitFor();
    await page.keyboard.press('Enter');
    await page.keyboard.press('4'); // 쉬움 → 바로 며칠 뒤 복습으로

    // 남은 것은 10분 뒤의 학습 카드뿐 → 20분 안이므로 바로 다시 보여 준다
    await page.locator('.review-card .badge', { hasText: '학습 중' }).waitFor();
    assert.match(await page.locator('.rc-word').innerText(), /^raise$/);
    await page.keyboard.press('Space');
    assert.match((await page.locator('.rating-good').innerText()).replace(/\s+/g, ' '), /^알맞음 2일$/);
    await page.keyboard.press('3');
    await page.locator('.empty-title', { hasText: '오늘 복습 완료!' }).waitFor();
    assert.match(await page.locator('.empty-msg').innerText(), /내일 복습 예정: 0개/);
    assert.equal(await page.locator('#review-badge').isVisible(), false);

    words = await dbAll(page, 'words');
    raise = words.find((w) => w.id === 'raise');
    const inflation = words.find((w) => w.id === 'inflation');
    assert.equal(raise.card.state, 2, '복습 단계로 올라갔다');
    assert.equal(raise.card.scheduled_days, 2);
    assert.equal(inflation.card.state, 2);
    assert.ok(inflation.card.scheduled_days >= 4, '쉬움은 더 긴 간격');
    const logs = await dbAll(page, 'reviewLogs');
    assert.deepEqual(
      logs.map((l) => [l.wordId, l.rating, l.state]),
      [
        ['raise', 3, 0],
        ['inflation', 4, 0],
        ['raise', 3, 1],
      ],
    );

    // 하루 뒤: 아직 복습할 것이 없다
    await page.clock.fastForward('24:00:00');
    await go(page, '#/today', '.article');
    await go(page, '#/review', '.empty');
    assert.match(await page.locator('.empty-title').innerText(), /지금은 복습할 단어가 없어요/);
    assert.match(await page.locator('.empty-msg').innerText(), /내일 복습 예정: 1개/);

    // 이틀 뒤: raise가 복습 카드로 돌아온다
    await page.clock.fastForward('24:00:00');
    await go(page, '#/today', '.article');
    await page.locator('#review-badge', { hasText: '1' }).waitFor();
    await go(page, '#/review', '.review-card');
    assert.match(await page.locator('.review .view-sub').innerText(), /오늘 복습 1개 · 새 단어 0개/);
    assert.match(await page.locator('.review-card').innerText(), /^복습\s+raise/);

    // 한 → 영 방향: 뜻과 빈칸 문장을 먼저 보여 준다
    await page.locator('.seg', { hasText: '한 → 영' }).click();
    await page.locator('.rc-prompt-label').waitFor();
    assert.match(await page.locator('.rc-front').innerText(), /이 뜻의 영어 표현은\?\s+올리다, 인상하다\s+The Bank of England ＿＿＿＿ its key interest rate/);
    assert.equal(await page.locator('.rc-word').count(), 0);
    await page.locator('.btn-reveal').click();
    assert.match(await page.locator('.rc-back .rc-word').innerText(), /^raise$/);

    // 다시(틀림) → 재학습 10분, 틀린 횟수 1
    await page.locator('.rating-again').click();
    await page.locator('.review-card .badge', { hasText: '학습 중' }).waitFor();
    raise = (await dbAll(page, 'words')).find((w) => w.id === 'raise');
    assert.equal(raise.card.state, 3);
    assert.equal(raise.card.lapses, 1);
    await go(page, '#/vocab', '.vocab-item');
    await page.locator('.chip', { hasText: '어려운 단어' }).click();
    assert.deepEqual(await page.locator('.vocab-item .vi-word').allInnerTexts(), ['raise']);
    assert.deepEqual(problems, []);
  });

  test('복습: 하루 새 단어 수 한도를 지킨다', async () => {
    const { page } = await open({ hash: '#/settings' });
    await page.waitForSelector('.settings');
    await page.locator('input[aria-label="하루 새 단어 수"]').fill('1');
    await page.locator('input[aria-label="하루 새 단어 수"]').blur();
    await go(page, '#/today', '.article');
    await saveFromArticle(page, 'raised');
    await page.clock.fastForward(1000);
    await saveFromArticle(page, 'inflation');
    await page.locator('#review-badge', { hasText: '1' }).waitFor();
    await go(page, '#/review', '.review-card');
    assert.match(await page.locator('.review .view-sub').innerText(), /새 단어 1개/);
    await page.keyboard.press('Space');
    await page.keyboard.press('4');
    await page.locator('.empty-title', { hasText: '오늘 복습 완료!' }).waitFor();
    assert.match(await page.locator('.empty-msg').innerText(), /대기 중인 새 단어 1개 \(하루 1개씩\)/);

    // 다음 날에는 남은 새 단어가 나온다
    await page.clock.fastForward('24:00:00');
    await go(page, '#/today', '.article');
    await go(page, '#/review', '.review-card');
    assert.match(await page.locator('.rc-word').innerText(), /^inflation$/);
  });

  // ── 퀴즈 ───────────────────────────────────────────────────────────

  test('토익 Part 5: 풀기 → 정답·해설 → 결과 저장 → 오답 노트에서 다시 풀면 사라진다', async () => {
    const { page, problems } = await open();
    await page.waitForSelector('.article');
    const a = await article('2026-11-10');
    assert.match(await page.locator('.quiz-card').first().innerText(), /토익 Part 5 \(0\/3\)/);
    await page.locator('.quiz-card a', { hasText: '풀기' }).click();
    await page.waitForSelector('.choice');
    assert.equal(await page.evaluate(() => location.hash), '#/quiz/2026-11-10');

    // 1번: 일부러 틀린다
    assert.equal(await page.locator('.quiz-count').innerText(), '1 / 3');
    assert.equal(await page.locator('.quiz-q-text').innerText(), a.toeic_part5[0].q);
    assert.deepEqual(await page.locator('.choice-text').allInnerTexts(), a.toeic_part5[0].choices);
    const wrongIdx = (a.toeic_part5[0].answer + 1) % 4;
    await page.locator('.choice').nth(wrongIdx).click();
    assert.match(await page.locator('.verdict').innerText(), /아쉬워요\. 정답은 \(B\) due to/);
    assert.match(await page.locator('.explain').innerText(), /전치사 역할을 하는 due to/);
    assert.match(await page.locator('.full-sentence').innerText(), /raised the rate due to concerns/);
    assert.equal(await page.locator('.choice.right').count(), 1);
    assert.equal(await page.locator('.choice.wrong').count(), 1);
    assert.equal(await page.locator('.choice').first().isDisabled(), true, '고른 뒤에는 바꿀 수 없다');
    await page.locator('button', { hasText: '다음 문제' }).click();

    // 2번: 키보드로 정답(A)
    assert.equal(await page.locator('.quiz-count').innerText(), '2 / 3');
    await page.keyboard.press(['a', 'b', 'c', 'd'][a.toeic_part5[1].answer]);
    assert.match(await page.locator('.verdict').innerText(), /정답이에요/);
    await page.locator('button', { hasText: '다음 문제' }).click();

    // 3번: 정답
    await page.locator('.choice').nth(a.toeic_part5[2].answer).click();
    await page.locator('button', { hasText: '결과 보기' }).click();
    assert.equal(await page.locator('.score').innerText(), '2 / 3');
    assert.equal(await page.locator('.result-list .res-wrong').count(), 1);

    let results = await dbAll(page, 'quizResults');
    assert.deepEqual(
      results.map((r) => [r.id, r.kind, r.type, r.correct, r.everWrong, r.attempts]),
      [
        ['2026-11-10#0', 'part5', 'preposition', false, true, 1],
        ['2026-11-10#1', 'part5', 'verb_form', true, false, 1],
        ['2026-11-10#2', 'part5', 'pronoun', true, false, 1],
      ],
    );
    assert.equal(results[0].chosen, wrongIdx);

    // 오늘 화면의 카드에 진행 상황과 오답 노트가 보인다
    await page.locator('a', { hasText: '기사로 돌아가기' }).last().click();
    await page.waitForSelector('.article');
    const cardText = await page.locator('.quiz-card').first().innerText();
    assert.match(cardText, /토익 Part 5 \(3\/3\)[\s\S]*정답 2개[\s\S]*다시 풀기[\s\S]*오답 노트 1문제/);
    assert.doesNotMatch(cardText, /null|undefined/);

    // 오답 노트
    await page.locator('a', { hasText: '오답 노트 1문제' }).click();
    await page.waitForSelector('.wrong-list');
    assert.equal(await page.locator('.wrong-list > li').count(), 1);
    assert.match(await page.locator('.wrong-list').innerText(), /Part 5 · 전치사[\s\S]*내 답: /);
    await page.locator('button', { hasText: '다시 풀기 (1문제)' }).click();
    await page.locator('.choice').nth(a.toeic_part5[0].answer).click();
    await page.locator('button', { hasText: '결과 보기' }).click();
    assert.equal(await page.locator('.score').innerText(), '1 / 1');
    await page.locator('button.btn', { hasText: '오답 노트로' }).click();
    await page.locator('.empty-title', { hasText: '틀린 문제가 없어요' }).waitFor();
    results = await dbAll(page, 'quizResults');
    assert.deepEqual([results[0].correct, results[0].everWrong, results[0].attempts], [true, true, 2], '맞혔지만 틀린 적이 있다는 기록은 남는다');
    await noOverflow(page, '퀴즈');
    assert.deepEqual(problems, []);
  });

  test('주간 퀴즈: 일요일에 열리고, 그 주에 저장한 단어와 틀린 Part 5로 만들어진다', async () => {
    // 수요일, 아무것도 없을 때
    const wed = await open({ hash: '#/quiz/weekly' });
    await wed.page.locator('.empty-title', { hasText: '이번 주간 퀴즈에 낼 문제가 없어요' }).waitFor();
    assert.match(await wed.page.locator('.empty-msg').innerText(), /일요일\(4일 뒤\)/);

    const { page, problems } = await open({ time: SUN_NOON });
    await page.waitForSelector('.article');
    const a = await article('2026-11-10');
    assert.equal(await page.locator('.quiz-card', { hasText: '주간 퀴즈' }).count(), 1);
    assert.match(await page.locator('.quiz-card', { hasText: '주간 퀴즈' }).innerText(), /주간 퀴즈가 열렸어요[\s\S]*11\/9~11\/15 · 이번 주에 저장한 단어가 없어요/);

    await saveFromArticle(page, 'raised');
    await saveFromArticle(page, 'inflation');
    await saveFromArticle(page, 'curve', { phrase: true });
    // Part 5 한 문제를 틀려 둔다
    await go(page, '#/quiz/2026-11-10', '.choice');
    await page.locator('.choice').nth((a.toeic_part5[0].answer + 1) % 4).click();
    await go(page, '#/today', '.article');
    const card = page.locator('.quiz-card', { hasText: '주간 퀴즈' });
    assert.match(await card.innerText(), /이번 주 단어와 틀린 문제 복습[\s\S]*풀기/);
    await card.locator('a', { hasText: '풀기' }).click();
    await page.waitForSelector('.choice');

    assert.equal(await page.locator('.quiz-count').innerText(), '1 / 4', '단어 3개 + 틀린 Part 5 1개');
    const words = await dbAll(page, 'words');
    for (let i = 0; i < 3; i++) {
      const prompt = await page.locator('.quiz-q-text').innerText();
      const w = words.find((x) => x.text === prompt);
      assert.ok(w, `저장한 단어가 문제로 나온다: ${prompt}`);
      const choices = await page.locator('.choice-text').allInnerTexts();
      assert.equal(new Set(choices).size, 4, '보기는 서로 다른 4개');
      assert.ok(choices.includes(w.ko), '정답 뜻이 보기에 있다');
      await page.locator('.choice', { hasText: w.ko }).first().click();
      assert.match(await page.locator('.verdict').innerText(), /정답이에요/);
      await page.locator('.quiz-feedback .btn-primary').click();
    }
    assert.equal(await page.locator('.quiz-q-text').innerText(), a.toeic_part5[0].q, '틀렸던 Part 5가 다시 나온다');
    await page.locator('.choice').nth(a.toeic_part5[0].answer).click();
    await page.locator('button', { hasText: '결과 보기' }).click();
    assert.equal(await page.locator('.score').innerText(), '4 / 4');

    const results = await dbAll(page, 'quizResults');
    const weekly = results.filter((r) => String(r.id).startsWith('weekly#2026-11-15#'));
    assert.equal(weekly.length, 5, '문제 4개 + 완료 기록');
    assert.deepEqual(weekly.find((r) => r.id.endsWith('#done')) && [weekly.find((r) => r.id.endsWith('#done')).correct, weekly.find((r) => r.id.endsWith('#done')).total], [4, 4]);
    assert.equal(results.find((r) => r.id === '2026-11-10#0').correct, true, '다시 맞힌 Part 5는 오답 노트에서도 해결된다');

    await page.locator('a.btn-primary', { hasText: '오늘의 기사로' }).click();
    await page.waitForSelector('.article');
    assert.match(await page.locator('.quiz-card', { hasText: '주간 퀴즈' }).innerText(), /완료 ✓ \(4\/4\)[\s\S]*다시 풀기/);

    // 월요일: 지난주 퀴즈를 이미 마쳤으므로 카드가 사라진다
    await page.clock.fastForward('24:00:00');
    await page.reload();
    await page.waitForSelector('.article');
    await page.waitForTimeout(300);
    assert.equal(await page.locator('.quiz-card', { hasText: '주간 퀴즈' }).count(), 0);
    assert.deepEqual(problems, []);
  });

  // ── 지난 기사 · 읽음 · 연속 학습일 ──────────────────────────────────

  test('지난 기사: 날짜별 목록, 분야 필터, 이전/다음 이동, 끝까지 읽으면 읽음 ✓ 과 연속 학습일', async () => {
    const { page, problems } = await open({ time: TUE_NOON });
    await page.waitForSelector('.article');
    assert.equal(await page.locator('.streak').isVisible(), false);

    // 끝까지 내려가고 잠시 머물면 읽음 처리
    await page.locator('.art-nav').scrollIntoViewIfNeeded();
    await page.clock.fastForward(4000);
    await page.locator('.toast', { hasText: '다 읽었어요' }).waitFor();
    assert.equal(await page.locator('.streak').innerText(), '🔥 연속 1일');
    const history = await dbAll(page, 'readHistory');
    assert.equal(history.length, 1);
    assert.equal(history[0].date, '2026-11-10');
    assert.ok(history[0].finishedAt);

    await page.locator('.art-nav a', { hasText: '지난 기사' }).click();
    await page.waitForSelector('.archive-item');
    assert.equal(await page.locator('.archive-item').count(), 3);
    assert.match(await page.locator('.archive .view-sub').innerText(), /기사 3편 · 읽음 1편/);
    assert.equal(await page.locator('.month-title').innerText(), '2026년 11월');
    assert.deepEqual(await page.locator('.archive-item .ai-date').allInnerTexts(), ['11월 10일 (화)', '11월 9일 (월)', '11월 7일 (토)']);
    assert.match(await page.locator('.archive-item').first().innerText(), /읽음/);
    assert.doesNotMatch(await page.locator('.archive-item').nth(1).innerText(), /읽음/);

    await page.locator('.chip', { hasText: '경제' }).click();
    assert.equal(await page.locator('.archive-item').count(), 1);
    await page.locator('.chip', { hasText: '배터리' }).click();
    assert.equal(await page.locator('.archive-item').count(), 2);
    await page.locator('.archive-item', { hasText: 'Chinese Battery Makers' }).click();
    await page.waitForSelector('.article[data-date="2026-11-07"]');
    assert.equal(await page.evaluate(() => location.hash), '#/article/2026-11-07');
    assert.match(await page.locator('.art-meta').innerText(), /배터리[\s\S]*C1 · 305단어/);
    assert.equal(await page.locator('.quiz-card', { hasText: '주간 퀴즈' }).count(), 0, '주간 퀴즈 카드는 오늘 화면에만');

    // 이전/다음
    assert.equal(await page.locator('.art-nav .btn.disabled').innerText(), '◀ 이전 글', '가장 오래된 기사');
    await page.locator('.art-nav a', { hasText: '다음 글' }).click();
    await page.waitForSelector('.article[data-date="2026-11-09"]');
    await page.locator('.art-nav a', { hasText: '이전 글' }).click();
    await page.waitForSelector('.article[data-date="2026-11-07"]');
    await page.locator('.notice a', { hasText: '오늘의 기사로' }).click();
    await page.waitForSelector('.article[data-date="2026-11-10"]');

    // 다음 날 읽으면 연속 2일, 하루 건너뛰면 다시 1일
    await page.clock.fastForward('24:00:00');
    await go(page, '#/article/2026-11-09', '.article[data-date="2026-11-09"]');
    await page.locator('.art-nav').scrollIntoViewIfNeeded();
    await page.clock.fastForward(4000);
    await page.locator('.toast', { hasText: '연속 2일' }).waitFor();
    await page.clock.fastForward('48:00:00');
    await go(page, '#/article/2026-11-07', '.article[data-date="2026-11-07"]');
    assert.equal(await page.locator('.streak').isVisible(), false, '어제 읽지 않았으면 연속 기록이 끊긴다');
    assert.deepEqual(problems, []);
  });

  test('없는 주소는 오늘 화면으로, 없는 날짜의 기사는 안내를 보여 준다', async () => {
    const { page } = await open({ hash: '#/nowhere' });
    await page.waitForSelector('.article');
    assert.equal(await page.evaluate(() => location.hash), '#/today');
    await page.evaluate(() => (location.hash = '#/article/2020-01-01'));
    await page.locator('.empty-title', { hasText: '2020-01-01 기사를 불러오지 못했어요' }).waitFor();
    await page.locator('.empty a, .empty button', { hasText: '지난 기사' }).click();
    await page.waitForSelector('.archive-item');
  });

  test('기사 파일이 깨졌으면 이전 기사로 대신하고 알려 준다', async () => {
    const { page } = await open({
      setup: (p) => p.route('**/articles/2026/11/2026-11-10.json', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{ "schema": 1, "date": "2026-11-10", ' })),
    });
    await page.waitForSelector('.article');
    assert.equal(await page.locator('.article').getAttribute('data-date'), '2026-11-09');
    assert.match(await page.locator('.notice').first().innerText(), /2026-11-10 기사를 불러오지 못해 이전 기사를 보여 드려요/);
  });

  // ── 설정 · 백업 ────────────────────────────────────────────────────

  test('설정: 테마·글자 크기·번역 펼쳐 두기가 적용되고 새로고침해도 유지된다', async () => {
    const { page, problems } = await open({ hash: '#/settings' });
    await page.waitForSelector('.settings');
    const root = (attr) => page.evaluate((a) => document.documentElement.getAttribute(a), attr);
    assert.equal(await root('data-theme'), 'light');
    await page.locator('.seg', { hasText: '다크' }).click();
    assert.equal(await root('data-theme'), 'dark');
    await page.locator('.seg', { hasText: '크게' }).click();
    assert.equal(await root('data-font'), 'l');
    await page.locator('input[role="switch"]').check();
    await page.locator('select[aria-label="목표 기억률"]').selectOption('0.85');
    await page.waitForFunction(() => localStorage.getItem('de:theme') === 'dark' && localStorage.getItem('de:font') === 'l');
    await waitForSetting(page, 'retention', 0.85);

    await page.reload();
    await page.waitForSelector('.settings');
    assert.equal(await root('data-theme'), 'dark');
    assert.equal(await root('data-font'), 'l');
    assert.equal(await page.locator('.seg.on', { hasText: '다크' }).count(), 1);
    assert.equal(await page.locator('input[role="switch"]').isChecked(), true);
    assert.equal(await page.locator('select[aria-label="목표 기억률"]').inputValue(), '0.85');
    assert.match(await page.locator('.settings').innerText(), /Daily English Reader 1\.0\.0/);

    await go(page, '#/today', '.article');
    assert.equal(await page.locator('.para-ko:visible').count(), 5, '번역이 처음부터 펼쳐져 있다');
    assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.para-en')).fontSize), '21px');
    assert.equal(await page.evaluate(() => getComputedStyle(document.body).backgroundColor), 'rgb(17, 23, 21)');

    // 시스템 테마를 따르는 설정
    await go(page, '#/settings', '.settings');
    await page.locator('.seg', { hasText: '시스템' }).click();
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
    await page.emulateMedia({ colorScheme: 'light' });
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'light');
    await noOverflow(page, '설정');
    assert.deepEqual(problems, []);
  });

  test('백업 내보내기 → 전체 삭제 → 가져오기: 데이터가 똑같이 돌아온다. 합치기는 양쪽을 모은다', async () => {
    const { page, problems } = await open();
    await page.waitForSelector('.article');
    const a = await article('2026-11-10');
    await saveFromArticle(page, 'raised');
    await saveFromArticle(page, 'curve', { phrase: true });
    await go(page, '#/review', '.review-card');
    await page.keyboard.press('Space');
    await page.keyboard.press('3');
    await page.locator('.rc-word', { hasText: 'ahead of the curve' }).waitFor();
    await go(page, '#/quiz/2026-11-10', '.choice');
    await page.locator('.choice').nth(a.toeic_part5[0].answer).click();
    await go(page, '#/settings', '.settings');
    await page.locator('.seg', { hasText: '크게' }).click();
    assert.match(await page.locator('.set-stats').first().innerText(), /단어 2개 · 복습 기록 1건 · 퀴즈 기록 1건 · 열어 본 기사 1편/);
    assert.match(await page.locator('.settings').innerText(), /마지막 백업: 아직 없음/);

    // 내보내기
    const exportOnce = async () => {
      const [download] = await Promise.all([page.waitForEvent('download'), page.locator('button', { hasText: '백업 내보내기' }).click()]);
      return { name: download.suggestedFilename(), data: JSON.parse(await readFile(await download.path(), 'utf8')) };
    };
    const first = await exportOnce();
    assert.equal(first.name, 'DEReader-backup-2026-11-11.json');
    assert.equal(first.data.app, 'DailyEnglishReader');
    assert.equal(first.data.backup_version, 1);
    assert.deepEqual(Object.keys(first.data), ['app', 'backup_version', 'exported_at', 'words', 'reviewLogs', 'quizResults', 'readHistory', 'settings']);
    assert.equal(first.data.words.length, 2);
    assert.equal(first.data.reviewLogs.length, 1);
    assert.deepEqual(first.data.settings, [{ key: 'fontSize', value: 'l' }], '바꾼 설정만, 내부 값(기사 목록 사본 등)은 제외');
    await page.locator('.hint', { hasText: '마지막 백업: 2026년 11월 11일' }).waitFor();

    // 전체 삭제 (두 번 확인)
    await page.locator('button', { hasText: '전체 삭제' }).click();
    await page.locator('.dialog button', { hasText: '계속' }).click();
    await page.locator('.dialog button', { hasText: '모두 지우기' }).click();
    await page.waitForSelector('.article');
    assert.deepEqual(await dbAll(page, 'words'), []);
    assert.deepEqual(await dbAll(page, 'reviewLogs'), []);
    assert.equal(await page.evaluate(() => document.documentElement.dataset.font), 'm', '설정도 기본값으로');
    assert.equal(await page.locator('.w.saved').count(), 0);

    // 가져오기 (덮어쓰기)
    const file = join(await mkdtemp(join(tmpdir(), 'de-backup-')), first.name);
    await writeFile(file, JSON.stringify(first.data));
    const importWith = async (path, button) => {
      await go(page, '#/settings', '.settings');
      const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.locator('button', { hasText: '백업 가져오기' }).click()]);
      await chooser.setFiles(path);
      if (button) {
        await page.locator('.dialog').waitFor();
        await page.locator('.dialog button', { hasText: button }).click();
        await page.locator('.toast', { hasText: '가져왔어요' }).waitFor();
      }
    };
    await importWith(file, '덮어쓰기');
    await page.waitForFunction(() => document.documentElement.dataset.font === 'l');
    await page.waitForSelector('.settings');

    const second = await exportOnce();
    for (const key of ['words', 'reviewLogs', 'quizResults', 'readHistory', 'settings']) {
      assert.deepEqual(second.data[key], first.data[key], `복원 후 ${key}가 백업과 같아야 한다`);
    }
    await page.locator('#review-badge', { hasText: '2' }).waitFor();

    // 합치기: 이 기기에서 새로 저장한 단어 + 백업의 단어가 모두 남는다. 다시 합쳐도 늘어나지 않는다.
    await go(page, '#/today', '.article');
    await saveFromArticle(page, 'inflation');
    await importWith(file, '합치기');
    let words = await dbAll(page, 'words');
    assert.deepEqual(words.map((w) => w.id).sort(), ['inflation', 'ph:ahead of the curve', 'raise']);
    assert.equal((await dbAll(page, 'reviewLogs')).length, 1, '같은 복습 기록은 한 번만');
    await importWith(file, '합치기');
    words = await dbAll(page, 'words');
    assert.equal(words.length, 3);
    assert.equal((await dbAll(page, 'reviewLogs')).length, 1);

    // 엉뚱한 파일은 거절하고 이유를 알려 준다
    const bad = join(tmpdir(), `de-bad-${Date.now()}.json`);
    await writeFile(bad, '{"hello": "world"}');
    await importWith(bad, null);
    await page.locator('.toast', { hasText: '백업 파일이 아니에요' }).waitFor();
    await writeFile(bad, 'not json at all');
    await importWith(bad, null);
    await page.locator('.toast', { hasText: 'JSON 형식이 아니에요' }).waitFor();
    assert.equal((await dbAll(page, 'words')).length, 3);
    await rm(bad, { force: true });
    assert.deepEqual(problems, []);
  });

  test('백업한 지 14일이 넘으면 오늘 화면에 안내가 뜬다', async () => {
    const { page } = await open();
    await page.waitForSelector('.article');
    await saveFromArticle(page, 'raised');
    await page.reload();
    await page.waitForSelector('.article');
    await page.waitForTimeout(300);
    assert.equal(await page.locator('.notice-warn').count(), 0);
    await page.clock.fastForward(15 * 24 * 3600 * 1000);
    await page.reload();
    await page.waitForSelector('.notice-warn');
    assert.match(await page.locator('.notice-warn').innerText(), /단어장을 아직 한 번도 백업하지 않았어요\. 설정에서 백업하기/);
  });

  // ── 화면 크기 · 기기 ───────────────────────────────────────────────

  test('노트북(1280×800): 탭이 위에 있고 본문은 가운데 720px, 넘치는 화면이 없다', async () => {
    const { page, problems } = await open({ viewport: LAPTOP });
    await page.waitForSelector('.article');
    const box = await page.locator('#view').boundingBox();
    assert.equal(box.width, 720);
    assert.equal(Math.round(box.x), 280);
    const tabs = await page.locator('#tabs').boundingBox();
    assert.equal(tabs.y, 0, '넓은 화면에서는 탭이 위쪽');
    await page.locator('.w', { hasText: /^raised$/ }).first().click();
    await page.locator('.sheet').waitFor();
    await page.locator('.ws-main .star-btn').click();
    await page.keyboard.press('Escape');
    for (const [hash, sel] of [
      ['#/today', '.article'],
      ['#/vocab', '.vocab-item'],
      ['#/review', '.review-card'],
      ['#/quiz/2026-11-10', '.choice'],
      ['#/archive', '.archive-item'],
      ['#/settings', '.settings'],
    ]) {
      await go(page, hash, sel);
      await noOverflow(page, `노트북 ${hash}`);
    }
    assert.deepEqual(problems, []);
  });

  test('작은 폰(360×640)에서도 넘치는 화면이 없고, 누르는 곳은 44px 이상이다', async () => {
    const { page, problems } = await open({ viewport: SMALL });
    await page.waitForSelector('.article');
    await saveFromArticle(page, 'stronger-than-expected');
    await saveFromArticle(page, 'curve', { phrase: true });
    for (const [hash, sel] of [
      ['#/today', '.article'],
      ['#/vocab', '.vocab-item'],
      ['#/review', '.review-card'],
      ['#/quiz/2026-11-10', '.choice'],
      ['#/quiz/wrong', '.quiz'],
      ['#/archive', '.archive-item'],
      ['#/settings', '.settings'],
      ['#/article/2026-11-07', '.article[data-date="2026-11-07"]'],
    ]) {
      await go(page, hash, sel);
      await noOverflow(page, `360px ${hash}`);
      const small = await page.evaluate(() =>
        [...document.querySelectorAll('#view .btn, #view .choice, #view .rating, #tabs a')]
          .filter((el) => el.offsetParent !== null)
          .map((el) => ({ text: el.textContent.trim().slice(0, 20), h: Math.round(el.getBoundingClientRect().height) }))
          .filter((x) => x.h < 44 && !/btn-small/.test(x.text)),
      );
      assert.deepEqual(small, [], `${hash}: 44px보다 낮은 버튼`);
    }
    await go(page, '#/review', '.review-card');
    await page.keyboard.press('Space');
    await page.locator('.ratings').waitFor();
    await noOverflow(page, '360px 복습 평가 버튼');
    assert.deepEqual(problems, []);
  });

  test('iPhone Safari로 처음 열면 홈 화면 추가 안내가 뜨고, 닫으면 다시 뜨지 않는다', async () => {
    const { page } = await open({
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
    });
    await page.waitForSelector('.article');
    const banner = page.locator('#banner-ios');
    await banner.waitFor();
    assert.match(await banner.innerText(), /홈 화면에 추가[\s\S]*저장한 단어가 지워질 수 있어요/);
    await banner.locator('button', { hasText: '닫기' }).click();
    await waitForSetting(page, 'iosHintDismissedAt');
    await page.reload();
    await page.waitForSelector('.article');
    await page.waitForTimeout(300);
    assert.equal(await page.locator('#banner-ios').count(), 0);

    const android = await open();
    await android.page.waitForSelector('.article');
    await android.page.waitForTimeout(200);
    assert.equal(await android.page.locator('#banner-ios').count(), 0);
  });

  // ── 설치 · 오프라인 · 새 버전 ──────────────────────────────────────

  test('설치 조건: 매니페스트, 아이콘, 서비스 워커', async () => {
    const manifest = JSON.parse(await readFile(join(ROOT, 'manifest.webmanifest'), 'utf8'));
    assert.equal(manifest.name, 'Daily English Reader');
    assert.equal(manifest.short_name, 'DE Reader');
    assert.equal(manifest.display, 'standalone');
    assert.equal(manifest.start_url, './');
    assert.equal(manifest.scope, './');
    const pngSize = async (file) => {
      const buf = await readFile(join(ROOT, file));
      assert.equal(buf.toString('latin1', 1, 4), 'PNG', `${file}은 PNG여야 한다`);
      return `${buf.readUInt32BE(16)}x${buf.readUInt32BE(20)}`;
    };
    for (const icon of manifest.icons) assert.equal(await pngSize(icon.src), icon.sizes);
    assert.ok(manifest.icons.some((i) => i.sizes === '192x192'));
    assert.ok(manifest.icons.some((i) => i.sizes === '512x512' && i.purpose === 'any'));
    assert.ok(manifest.icons.some((i) => i.purpose === 'maskable'));
    assert.equal(await pngSize('icons/apple-touch-icon.png'), '180x180');

    const { page, problems } = await open({ serviceWorkers: 'allow', time: null });
    await page.waitForSelector('.article');
    const info = await page.evaluate(async () => {
      const reg = await navigator.serviceWorker.ready;
      return {
        scope: new URL(reg.scope).pathname,
        manifest: document.querySelector('link[rel="manifest"]').href,
        apple: document.querySelector('link[rel="apple-touch-icon"]').href,
        theme: document.querySelector('meta[name="theme-color"]').content,
      };
    });
    assert.equal(info.scope, '/DailyEnglish/', '서비스 워커 범위는 앱 폴더(상대 경로 등록)');
    assert.match(info.manifest, /\/DailyEnglish\/manifest\.webmanifest$/);
    assert.match(info.apple, /\/DailyEnglish\/icons\/apple-touch-icon\.png$/);
    assert.equal(info.theme, '#0f766e');
    for (const url of [info.manifest, info.apple]) assert.equal((await page.request.get(url)).status(), 200);
    assert.deepEqual(problems, []);
  });

  test('오프라인: 인터넷을 끊어도 앱·기사·단어장·복습이 동작한다', async () => {
    const { ctx, page, problems } = await open({ serviceWorkers: 'allow', time: null });
    await page.waitForSelector('.article');
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
    await saveFromArticle(page, 'raised');
    // 최근 기사 미리 받기가 끝날 때까지 기다린다
    await page.waitForFunction(
      () =>
        new Promise((resolve) => {
          const open = indexedDB.open('dailyenglish');
          open.onsuccess = () => {
            const req = open.result.transaction('articleCache').objectStore('articleCache').count();
            req.onsuccess = () => {
              open.result.close();
              resolve(req.result >= 3);
            };
          };
        }),
    );

    await ctx.setOffline(true);
    problems.length = 0;
    await page.reload();
    await page.waitForSelector('.article');
    assert.ok(await page.locator('.art-title').innerText());
    await page.locator('#offline-chip').waitFor();
    await page.waitForFunction(() => document.querySelectorAll('.w.saved').length > 0);

    await page.locator('.w', { hasText: /^inflation$/ }).first().click();
    await page.locator('.ws-main .star-btn').click();
    await page.locator('.ws-main .star-btn.on').waitFor();
    await page.keyboard.press('Escape');

    await go(page, '#/vocab', '.vocab-item');
    assert.equal(await page.locator('.vocab-item').count(), 2);
    await go(page, '#/review', '.review-card');
    await page.keyboard.press('Space');
    await page.keyboard.press('3');
    await go(page, '#/archive', '.archive-item');
    assert.equal(await page.locator('.archive-item').count(), 3);
    assert.match(await page.locator('.archive .view-sub').innerText(), /오프라인/);
    await page.locator('.archive-item').nth(2).click(); // 열어 본 적 없는 기사도 미리 받아 두었다
    await page.waitForSelector('.article[data-date="2026-11-07"]');
    await go(page, '#/quiz/2026-11-09', '.choice');
    await go(page, '#/settings', '.settings');
    assert.deepEqual(
      problems.filter((p) => !/net::ERR_INTERNET_DISCONNECTED|Failed to load resource/.test(p)),
      [],
    );

    await ctx.setOffline(false);
    await page.locator('#offline-chip').waitFor({ state: 'hidden' });
  });

  test('새 버전: 배포된 파일이 바뀌면 "새 버전이 있어요"가 뜨고, 새로고침하면 적용된다', async () => {
    // 저장소를 임시 폴더에 복사해 따로 서버를 띄우고, 중간에 파일을 바꿔 "새 배포"를 흉내 낸다.
    const dir = await mkdtemp(join(tmpdir(), 'de-site-'));
    for (const name of ['index.html', 'manifest.webmanifest', 'sw.js', 'css', 'js', 'vendor', 'icons', 'articles']) {
      await cp(join(ROOT, name), join(dir, name), { recursive: true });
    }
    const site = await startServer({ port: 0, quiet: true, root: dir });
    try {
      const { page } = await open({ serviceWorkers: 'allow', time: null, baseUrl: site.url });
      await page.waitForSelector('.article');
      await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
      await page.waitForTimeout(300);
      assert.equal(await page.locator('#banner-update').count(), 0, '처음 설치할 때는 알리지 않는다');
      const swText = await readFile(join(dir, 'sw.js'), 'utf8');
      const oldVersion = /const VERSION = '([^']+)'/.exec(swText)[1];

      // 새 배포: 앱 이름을 바꾸고 캐시 버전을 올린다
      const version = await readFile(join(dir, 'js/version.js'), 'utf8');
      await writeFile(join(dir, 'js/version.js'), version.replace("APP_VERSION = '1.0.0'", "APP_VERSION = '9.9.9'"));
      await writeFile(join(dir, 'sw.js'), swText.replace(oldVersion, '9.9.9-testtest'));

      await go(page, '#/settings', '.settings');
      await page.locator('button', { hasText: '업데이트 확인' }).click();
      await page.locator('#banner-update').waitFor();
      assert.match(await page.locator('.settings').innerText(), /Daily English Reader 1\.0\.0/, '새로고침 전에는 이전 버전 그대로');
      await page.locator('.dialog button', { hasText: '취소' }).click();

      await Promise.all([page.waitForNavigation(), page.locator('#banner-update button', { hasText: '새로고침' }).click()]);
      await page.waitForSelector('.settings');
      await page.locator('.set-stats', { hasText: 'Daily English Reader 9.9.9 · 캐시 9.9.9-testtest' }).waitFor();
      const caches = await page.evaluate(() => caches.keys());
      assert.deepEqual(caches.filter((k) => k.startsWith('de-shell-')), ['de-shell-9.9.9-testtest'], '이전 버전의 저장본은 지워진다');
      assert.equal(await page.locator('#banner-update').count(), 0);
    } finally {
      await site.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
