// articles.js — 기사 목록(index.json)과 기사 파일 불러오기
//
//   목록     : 네트워크 우선 → 실패하면 기기에 저장해 둔 목록
//   기사 파일 : 기기 사본(IndexedDB) 우선 → 없으면 네트워크. 열어 본 기사는 오프라인에서도 열린다.
//
// 모든 주소는 상대 경로다. (GitHub Pages의 /DailyEnglish/ 하위 경로에서 동작해야 한다)

import { get, getAll, put } from './db.js';
import { getMeta, setMeta } from './prefs.js';
import { articlePath, isRenderable, isValidDate } from './schema.js';
import { kstDate, kstHour } from './util.js';

const INDEX_URL = 'articles/index.json';
const FETCH_TIMEOUT_MS = 8000;
const INDEX_MAX_AGE_MS = 5 * 60_000;
const PREFETCH_COUNT = 5;

let memo = null; // { items, updated, offline, loadedAt }
let indexInflight = null; // 받아 오는 중인 목록 요청 (같은 시점의 요청은 하나로 합친다)
const articleInflight = new Map(); // 날짜 → 받아 오는 중인 기사 요청

async function fetchJson(url, { timeout = FETCH_TIMEOUT_MS, cache = 'no-cache' } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, { cache, signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function cleanItems(raw) {
  if (!raw || !Array.isArray(raw.items)) return null;
  const items = raw.items
    .filter((it) => it && isValidDate(it.date) && typeof it.title_en === 'string')
    .map((it) => ({
      date: it.date,
      topic: it.topic,
      level: it.level,
      title_en: it.title_en,
      title_ko: it.title_ko ?? '',
      path: typeof it.path === 'string' && /^articles\/[\w/.-]+\.json$/.test(it.path) && !it.path.includes('..') ? it.path : articlePath(it.date),
    }))
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  return { items, updated: raw.updated ?? null };
}

/**
 * 기사 목록(최신순).
 * @param {{refresh?: boolean, maxAge?: number}} [opts]
 *   refresh가 true면 메모리에 있어도 다시 받아 온다. maxAge(ms)보다 오래된 목록도 다시 받는다.
 * @returns {Promise<{items: object[], updated: string|null, offline: boolean}>}
 *   offline이 true면 네트워크에 실패해 기기에 저장된 목록을 쓴 것이다.
 */
export function getIndex({ refresh = false, maxAge = INDEX_MAX_AGE_MS } = {}) {
  if (memo && !refresh && Date.now() - memo.loadedAt < maxAge) return Promise.resolve(memo);
  if (!indexInflight) indexInflight = loadIndex().finally(() => (indexInflight = null));
  return indexInflight;
}

async function loadIndex() {
  try {
    const fresh = cleanItems(await fetchJson(INDEX_URL));
    if (!fresh) throw new Error('목록 형식이 올바르지 않아요.');
    memo = { ...fresh, offline: false, loadedAt: Date.now() };
    setMeta('index', fresh).catch(() => {});
    schedulePrefetch(fresh.items);
    return memo;
  } catch (e) {
    const saved = cleanItems(await getMeta('index').catch(() => null));
    if (saved) {
      memo = { ...saved, offline: true, loadedAt: Date.now() };
      return memo;
    }
    // 목록이 한 번도 저장된 적 없다면, 기기에 있는 기사 사본으로라도 목록을 만든다.
    const cached = await getAll('articleCache').catch(() => []);
    if (cached.length) {
      const items = cached
        .map((c) => c.article)
        .filter(isRenderable)
        .map((a) => ({ date: a.date, topic: a.topic, level: a.level, title_en: a.title.en, title_ko: a.title.ko ?? '', path: articlePath(a.date) }))
        .sort((a, b) => (a.date < b.date ? 1 : -1));
      memo = { items, updated: null, offline: true, loadedAt: Date.now() };
      return memo;
    }
    const err = new Error('기사 목록을 불러오지 못했어요. 인터넷 연결을 확인해 주세요.');
    err.cause = e;
    throw err;
  }
}

/** 기사를 내려받아 기기에 사본을 저장한다. 같은 날짜를 받는 중이면 그 요청을 같이 쓴다. */
function downloadArticle(date, path) {
  if (articleInflight.has(date)) return articleInflight.get(date);
  const job = (async () => {
    const article = await fetchJson(path ?? articlePath(date), { cache: 'default' });
    if (!isRenderable(article) || article.date !== date) throw new Error('기사 형식이 올바르지 않아요.');
    await put('articleCache', { date, article, cachedAt: new Date().toISOString() }).catch(() => {});
    return article;
  })().finally(() => articleInflight.delete(date));
  articleInflight.set(date, job);
  return job;
}

const refreshing = new Set();

/** 기기 사본을 돌려준 뒤, 조용히 최신본으로 바꿔 둔다. (오탈자 수정 등이 다음에 열 때 반영된다) */
function refreshInBackground(date, path, cachedAt) {
  if (refreshing.has(date) || !navigator.onLine) return;
  if (cachedAt && Date.now() - Date.parse(cachedAt) < 6 * 3_600_000) return;
  refreshing.add(date);
  downloadArticle(date, path)
    .catch(() => {})
    .finally(() => refreshing.delete(date));
}

/**
 * 기사 한 편. 기기에 사본이 있으면 그것을, 없으면 내려받는다.
 * @throws 불러오지 못하면 한국어 설명이 담긴 Error
 */
export async function getArticle(date, path) {
  if (!isValidDate(date)) throw new Error('잘못된 날짜예요.');
  const cached = await get('articleCache', date).catch(() => null);
  if (cached && isRenderable(cached.article)) {
    refreshInBackground(date, path, cached.cachedAt);
    return cached.article;
  }
  try {
    return await downloadArticle(date, path);
  } catch (e) {
    const err = new Error(navigator.onLine ? `${date} 기사를 불러오지 못했어요.` : '오프라인이에요. 이 기사는 아직 내려받지 않았어요.');
    err.cause = e;
    throw err;
  }
}

let prefetchTimer = null;

/**
 * 최근 기사 몇 편을 미리 내려받아, 열어 보지 않았어도 오프라인에서 볼 수 있게 한다.
 * 첫 화면의 기사와 대역폭을 나눠 쓰지 않도록, 화면을 그리고 한가해진 뒤에 받는다.
 */
function schedulePrefetch(items) {
  clearTimeout(prefetchTimer);
  prefetchTimer = setTimeout(() => {
    const run = () => prefetchRecent(items);
    if ('requestIdleCallback' in globalThis) requestIdleCallback(run, { timeout: 5000 });
    else run();
  }, 2000);
}

async function prefetchRecent(items) {
  try {
    const have = new Set((await getAll('articleCache')).map((c) => c.date));
    for (const it of items.slice(0, PREFETCH_COUNT)) {
      if (!have.has(it.date)) await downloadArticle(it.date, it.path).catch(() => {});
    }
  } catch {
    /* 미리 받기는 실패해도 괜찮다 */
  }
}

/** 앱이 켜지자마자 목록을 받기 시작한다. (저장소 열기·화면 준비와 동시에 진행) */
export function warmIndex() {
  getIndex({ refresh: true }).catch(() => {});
}

/**
 * "오늘" 화면에 보여 줄 기사.
 * 오늘 기사가 있으면 그것을, 없거나 깨졌으면 그 이전의 가장 최근 기사를 고른다.
 * @returns {Promise<{article: object, isToday: boolean, notice: string|null, offline: boolean}>}
 */
export async function resolveToday(now = new Date()) {
  const today = kstDate(now);
  // 앱 시작 때 warmIndex()가 막 받아 둔 목록이면 그대로 쓰고, 아니면 새로 받는다.
  const index = await getIndex({ maxAge: 15_000 });
  const past = index.items.filter((it) => it.date <= today);
  const candidates = past.length ? past : index.items;
  if (!candidates.length) throw new Error('아직 올라온 기사가 없어요.');

  let failed = null;
  for (const it of candidates) {
    try {
      const article = await getArticle(it.date, it.path);
      const isToday = it.date === today;
      let notice = null;
      if (failed) notice = `${failed} 기사를 불러오지 못해 이전 기사를 보여 드려요.`;
      else if (!isToday) notice = kstHour(now) < 8 ? '오늘 기사는 07:00경 도착해요. 그동안 가장 최근 기사를 읽어 보세요.' : '오늘 기사가 아직 없어요. 가장 최근 기사를 보여 드려요.';
      return { article, isToday, notice, offline: index.offline };
    } catch {
      failed ??= it.date;
    }
  }
  throw new Error(navigator.onLine ? '기사를 불러오지 못했어요. 잠시 후 다시 시도해 주세요.' : '오프라인이에요. 저장된 기사가 없어요.');
}

/** 목록에서 앞뒤 기사. older는 더 예전, newer는 더 최근 */
export async function neighbors(date) {
  const { items } = await getIndex();
  const i = items.findIndex((it) => it.date === date);
  if (i === -1) return { older: null, newer: null };
  return { older: items[i + 1] ?? null, newer: items[i - 1] ?? null };
}

/** 기기에 사본이 있는 기사들 (퀴즈·오답 노트에서 문제를 찾을 때 쓴다) */
export async function cachedArticles() {
  return (await getAll('articleCache')).map((c) => c.article).filter(isRenderable);
}
