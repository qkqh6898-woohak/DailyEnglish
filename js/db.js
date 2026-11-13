// db.js — IndexedDB 래퍼 (DB 이름 'dailyenglish', 버전 1)
//
// 저장소(store)
//   words         id            단어장. id는 소문자 원형, 구는 'ph:ramp up'
//   reviewLogs    자동 증가     복습 기록
//   quizResults   id            퀴즈 결과. '2026-11-28#0', 'weekly#2026-11-29#3'
//   readHistory   date          읽은 기사 기록
//   settings      key           설정 값 (그리고 '_'로 시작하는 앱 내부 값)
//   articleCache  date          기사 JSON 사본 (오프라인용)
//
// 날짜·시각은 모두 ISO 문자열로 저장한다. 그래야 JSON 백업과 복원 결과가 완전히 같아진다.

export const DB_NAME = 'dailyenglish';
export const DB_VERSION = 1;
export const STORES = ['words', 'reviewLogs', 'quizResults', 'readHistory', 'settings', 'articleCache'];

let dbPromise = null;

export function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (!('indexedDB' in globalThis)) {
      reject(new Error('이 브라우저는 저장 기능(IndexedDB)을 지원하지 않아요.'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('words')) db.createObjectStore('words', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('reviewLogs')) {
        const s = db.createObjectStore('reviewLogs', { keyPath: 'id', autoIncrement: true });
        s.createIndex('wordId', 'wordId');
      }
      if (!db.objectStoreNames.contains('quizResults')) db.createObjectStore('quizResults', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('readHistory')) db.createObjectStore('readHistory', { keyPath: 'date' });
      if (!db.objectStoreNames.contains('settings')) db.createObjectStore('settings', { keyPath: 'key' });
      if (!db.objectStoreNames.contains('articleCache')) db.createObjectStore('articleCache', { keyPath: 'date' });
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      resolve(db);
    };
    req.onerror = () => reject(req.error ?? new Error('저장소를 열지 못했어요.'));
    req.onblocked = () => reject(new Error('다른 탭에서 앱이 열려 있어 저장소를 열지 못했어요. 다른 탭을 닫아 주세요.'));
  }).catch((e) => {
    dbPromise = null;
    throw e;
  });
  return dbPromise;
}

const wrap = (req) =>
  new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

/**
 * 트랜잭션 하나 안에서 fn을 실행한다. fn은 store 이름 → objectStore 맵을 받는다.
 * 트랜잭션이 끝까지 저장된 뒤에 fn의 결과를 돌려준다.
 */
export async function tx(storeNames, mode, fn) {
  const db = await openDB();
  const names = Array.isArray(storeNames) ? storeNames : [storeNames];
  return new Promise((resolve, reject) => {
    const t = db.transaction(names, mode);
    const stores = Object.fromEntries(names.map((n) => [n, t.objectStore(n)]));
    let result;
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error ?? new Error('저장이 취소되었어요.'));
    Promise.resolve()
      .then(() => fn(stores, wrap))
      .then((r) => {
        result = r;
      })
      .catch((e) => {
        try {
          t.abort();
        } catch {
          /* 이미 끝난 트랜잭션 */
        }
        reject(e);
      });
  });
}

export const get = (store, key) => tx(store, 'readonly', (s) => wrap(s[store].get(key)));
export const getAll = (store) => tx(store, 'readonly', (s) => wrap(s[store].getAll()));
export const count = (store) => tx(store, 'readonly', (s) => wrap(s[store].count()));
export const put = (store, value) => tx(store, 'readwrite', (s) => wrap(s[store].put(value)));
export const del = (store, key) => tx(store, 'readwrite', (s) => wrap(s[store].delete(key)));

// ── 단어장 ───────────────────────────────────────────────────────────

/** 단어장 id. 단어는 소문자 원형, 구는 'ph:' + 소문자 구 */
export function wordId(kind, text) {
  const key = String(text).trim().toLowerCase().replace(/\s+/g, ' ');
  return kind === 'phrase' ? `ph:${key}` : key;
}

const sameSource = (a, b) => a.date === b.date && a.sentence === b.sentence;

/**
 * 단어를 단어장에 저장한다. 이미 있으면 새로 만들지 않고 "다른 기사 문장"만 더한다.
 * @param {{kind: 'word'|'phrase', text: string, lemma?: string, pos?: string, ko: string, ex?: string,
 *          source?: {date: string, sentence: string, t: string, ko?: string}, custom?: boolean}} entry
 * @param {object} card 새 단어일 때 붙일 FSRS 카드
 * @returns {Promise<{word: object, created: boolean, addedSource: boolean}>}
 */
export function saveWord(entry, card, nowIso = new Date().toISOString()) {
  const id = wordId(entry.kind, entry.kind === 'phrase' ? entry.text : (entry.lemma ?? entry.text));
  return tx('words', 'readwrite', async (s, w) => {
    const existing = await w(s.words.get(id));
    if (existing) {
      let addedSource = false;
      if (entry.source && !existing.sources.some((x) => sameSource(x, entry.source))) {
        existing.sources.push(entry.source);
        existing.updatedAt = nowIso;
        addedSource = true;
        await w(s.words.put(existing));
      }
      return { word: existing, created: false, addedSource };
    }
    const word = {
      id,
      kind: entry.kind,
      text: entry.kind === 'phrase' ? entry.text : (entry.lemma ?? entry.text),
      lemma: entry.lemma ?? entry.text,
      pos: entry.pos ?? '',
      ko: entry.ko,
      ex: entry.ex ?? '',
      sources: entry.source ? [entry.source] : [],
      card,
      createdAt: nowIso,
      updatedAt: nowIso,
      custom: Boolean(entry.custom),
    };
    await w(s.words.put(word));
    return { word, created: true, addedSource: false };
  });
}

/** 단어의 일부 값만 바꾼다. (뜻 수정 등) */
export function updateWord(id, patch, nowIso = new Date().toISOString()) {
  return tx('words', 'readwrite', async (s, w) => {
    const word = await w(s.words.get(id));
    if (!word) return null;
    Object.assign(word, patch, { updatedAt: nowIso });
    await w(s.words.put(word));
    return word;
  });
}

/**
 * 단어와 그 복습 기록을 함께 지운다.
 * @returns {Promise<{word: object|undefined, logs: object[]}>} 지운 내용 (restoreWord로 되돌릴 수 있다)
 */
export function deleteWord(id) {
  return tx(['words', 'reviewLogs'], 'readwrite', async (s, w) => {
    const word = await w(s.words.get(id));
    const logs = await w(s.reviewLogs.index('wordId').getAll(id));
    await w(s.words.delete(id));
    for (const log of logs) s.reviewLogs.delete(log.id);
    return { word, logs };
  });
}

/** deleteWord로 지운 단어와 복습 기록을 그대로 되살린다. ("되돌리기") */
export function restoreWord({ word, logs }) {
  return tx(['words', 'reviewLogs'], 'readwrite', async (s, w) => {
    if (!word) return;
    await w(s.words.put(word));
    for (const log of logs ?? []) s.reviewLogs.put(log);
  });
}

/**
 * 복습 결과 저장: 단어의 카드 상태를 바꾸고 복습 기록을 한 줄 더한다.
 * @returns {Promise<number>} 복습 기록 id (되돌리기에 사용)
 */
export function applyReview(id, card, log, nowIso = new Date().toISOString()) {
  return tx(['words', 'reviewLogs'], 'readwrite', async (s, w) => {
    const word = await w(s.words.get(id));
    if (!word) throw new Error('단어장에서 지워진 단어예요.');
    word.card = card;
    word.updatedAt = nowIso;
    await w(s.words.put(word));
    return w(s.reviewLogs.add({ wordId: id, ...log }));
  });
}

/** 방금 한 복습을 되돌린다. */
export function undoReview(wordBefore, logId) {
  return tx(['words', 'reviewLogs'], 'readwrite', async (s, w) => {
    await w(s.words.put(wordBefore));
    await w(s.reviewLogs.delete(logId));
  });
}

// ── 읽은 기록 ────────────────────────────────────────────────────────

export function markOpened(date, nowIso = new Date().toISOString()) {
  return tx('readHistory', 'readwrite', async (s, w) => {
    const rec = (await w(s.readHistory.get(date))) ?? { date, openedAt: nowIso, finishedAt: null };
    await w(s.readHistory.put(rec));
    return rec;
  });
}

/** 끝까지 읽음 처리. 이미 읽은 기사면 처음 읽은 시각을 유지한다. @returns 새로 읽음 처리했는지 */
export function markFinished(date, nowIso = new Date().toISOString()) {
  return tx('readHistory', 'readwrite', async (s, w) => {
    const rec = (await w(s.readHistory.get(date))) ?? { date, openedAt: nowIso, finishedAt: null };
    if (rec.finishedAt) return false;
    rec.finishedAt = nowIso;
    await w(s.readHistory.put(rec));
    return true;
  });
}

// ── 백업 ─────────────────────────────────────────────────────────────

export const BACKUP_APP = 'DailyEnglishReader';
export const BACKUP_VERSION = 1;

/**
 * 기기 안의 학습 데이터를 백업용 객체로 만든다. (기사 사본·내부 값은 제외)
 * @param {string[]} settingKeys 백업에 넣을 설정 이름들
 */
export async function exportBackup(settingKeys, nowIso = new Date().toISOString()) {
  const [words, reviewLogs, quizResults, readHistory, settings] = await Promise.all([
    getAll('words'),
    getAll('reviewLogs'),
    getAll('quizResults'),
    getAll('readHistory'),
    getAll('settings'),
  ]);
  return {
    app: BACKUP_APP,
    backup_version: BACKUP_VERSION,
    exported_at: nowIso,
    words,
    reviewLogs,
    quizResults,
    readHistory,
    settings: settings.filter((x) => settingKeys.includes(x.key)),
  };
}

/** 백업 파일이 맞는지 확인한다. 문제가 있으면 한국어 설명을 던진다. */
export function checkBackup(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('백업 파일 형식이 아니에요.');
  if (data.app !== BACKUP_APP) throw new Error('Daily English Reader의 백업 파일이 아니에요.');
  if (data.backup_version !== BACKUP_VERSION) throw new Error(`지원하지 않는 백업 버전이에요. (버전 ${data.backup_version})`);
  for (const k of ['words', 'reviewLogs', 'quizResults', 'readHistory', 'settings']) {
    if (!Array.isArray(data[k])) throw new Error(`백업 파일에 ${k} 목록이 없어요.`);
  }
  if (!data.words.every((w) => w && typeof w.id === 'string' && typeof w.ko === 'string' && w.card && Array.isArray(w.sources))) {
    throw new Error('백업 파일의 단어 정보가 올바르지 않아요.');
  }
  if (!data.reviewLogs.every((l) => l && typeof l.wordId === 'string' && typeof l.reviewedAt === 'string')) {
    throw new Error('백업 파일의 복습 기록이 올바르지 않아요.');
  }
  if (!data.quizResults.every((q) => q && typeof q.id === 'string')) throw new Error('백업 파일의 퀴즈 기록이 올바르지 않아요.');
  if (!data.readHistory.every((r) => r && typeof r.date === 'string')) throw new Error('백업 파일의 읽은 기록이 올바르지 않아요.');
  if (!data.settings.every((x) => x && typeof x.key === 'string')) throw new Error('백업 파일의 설정이 올바르지 않아요.');
  return data;
}

const newer = (a, b, field) => String(a?.[field] ?? '') >= String(b?.[field] ?? '');

/**
 * 백업을 가져온다.
 *   mode 'replace' : 지금 데이터를 지우고 백업으로 바꾼다.
 *   mode 'merge'   : 합친다. 같은 단어는 updatedAt이 최신인 쪽을 남긴다.
 * @param {string[]} settingKeys 복원할 설정 이름들 (그 밖의 키는 무시)
 * @returns {Promise<{words: number, reviewLogs: number, quizResults: number, readHistory: number}>} 가져온 뒤의 개수
 */
export function importBackup(data, mode, settingKeys) {
  checkBackup(data);
  const stores = ['words', 'reviewLogs', 'quizResults', 'readHistory', 'settings'];
  return tx(stores, 'readwrite', async (s, w) => {
    if (mode === 'replace') {
      for (const name of ['words', 'reviewLogs', 'quizResults', 'readHistory']) await w(s[name].clear());
      for (const key of settingKeys) await w(s.settings.delete(key));
      for (const x of data.words) s.words.put(x);
      for (const x of data.reviewLogs) s.reviewLogs.put(x);
      for (const x of data.quizResults) s.quizResults.put(x);
      for (const x of data.readHistory) s.readHistory.put(x);
      for (const x of data.settings) if (settingKeys.includes(x.key)) s.settings.put(x);
    } else {
      // 단어: 최신 쪽을 남기되, 기사 문장은 양쪽 것을 모두 모은다.
      for (const incoming of data.words) {
        const mine = await w(s.words.get(incoming.id));
        if (!mine) {
          s.words.put(incoming);
          continue;
        }
        const incomingWins = newer(incoming, mine, 'updatedAt');
        const keep = { ...(incomingWins ? incoming : mine) };
        const other = incomingWins ? mine : incoming;
        keep.sources = [...keep.sources];
        for (const src of other.sources ?? []) if (!keep.sources.some((x) => sameSource(x, src))) keep.sources.push(src);
        if (other.createdAt && String(other.createdAt) < String(keep.createdAt)) keep.createdAt = other.createdAt;
        s.words.put(keep);
      }
      // 복습 기록: (단어, 시각)이 같은 줄은 한 번만
      const seen = new Set((await w(s.reviewLogs.getAll())).map((l) => `${l.wordId}|${l.reviewedAt}`));
      for (const log of data.reviewLogs) {
        const key = `${log.wordId}|${log.reviewedAt}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const { id: _id, ...rest } = log;
        s.reviewLogs.add(rest);
      }
      for (const incoming of data.quizResults) {
        const mine = await w(s.quizResults.get(incoming.id));
        if (!mine || newer(incoming, mine, 'answeredAt')) s.quizResults.put(incoming);
      }
      for (const incoming of data.readHistory) {
        const mine = await w(s.readHistory.get(incoming.date));
        if (!mine) {
          s.readHistory.put(incoming);
          continue;
        }
        const openedAt = [mine.openedAt, incoming.openedAt].filter(Boolean).sort()[0] ?? null;
        const finishedAt = [mine.finishedAt, incoming.finishedAt].filter(Boolean).sort()[0] ?? null;
        s.readHistory.put({ ...mine, openedAt, finishedAt });
      }
      // 합치기에서는 이 기기의 설정을 그대로 둔다.
    }
    const [words, reviewLogs, quizResults, readHistory] = await Promise.all([
      w(s.words.count()),
      w(s.reviewLogs.count()),
      w(s.quizResults.count()),
      w(s.readHistory.count()),
    ]);
    return { words, reviewLogs, quizResults, readHistory };
  });
}

/** 기기 안의 모든 데이터를 지운다. (단어장, 기록, 설정, 기사 사본) */
export function wipeAll() {
  return tx(STORES, 'readwrite', async (s, w) => {
    for (const name of STORES) await w(s[name].clear());
  });
}

// ── 저장 공간 ────────────────────────────────────────────────────────

/** 브라우저에 "이 데이터를 지우지 말아 달라"고 요청한다. (Android Chrome에서 효과가 있다) */
export async function requestPersist() {
  try {
    if (!navigator.storage?.persist) return null;
    if (await navigator.storage.persisted()) return true;
    return await navigator.storage.persist();
  } catch {
    return null;
  }
}

export async function storageInfo() {
  try {
    const [persisted, estimate] = await Promise.all([navigator.storage?.persisted?.() ?? null, navigator.storage?.estimate?.() ?? null]);
    return { persisted, usage: estimate?.usage ?? null, quota: estimate?.quota ?? null };
  } catch {
    return { persisted: null, usage: null, quota: null };
  }
}
