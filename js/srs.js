// srs.js — 간격 반복(FSRS) 래퍼. vendor/ts-fsrs.umd.js 가 만든 전역 FSRS를 쓴다.
// 화면·DB와 무관한 순수 함수라서 Node 테스트에서도 그대로 돌아간다.
// (vendor/ts-fsrs.umd.js 는 아래 import로 함께 불러온다)
//
// 카드는 JSON으로 저장하기 좋은 모양(날짜는 ISO 문자열)으로만 주고받는다.

import '../vendor/ts-fsrs.umd.js'; // 전역 FSRS를 만든다 (UMD 파일을 모듈로 불러와도 globalThis에 붙는다)
import { addDays, formatInterval, kstDate } from './util.js';

export const Rating = Object.freeze({ Again: 1, Hard: 2, Good: 3, Easy: 4 });
export const State = Object.freeze({ New: 0, Learning: 1, Review: 2, Relearning: 3 });

export const RATING_LABEL = { 1: '다시', 2: '어려움', 3: '알맞음', 4: '쉬움' };

/** 지금 볼 것이 없을 때, 이 시간 안에 돌아올 학습 카드는 미리 보여 준다. */
export const LEARN_AHEAD_MS = 20 * 60_000;

/** "익힘"으로 보는 안정도(일). 이만큼 지나도 목표 기억률을 유지한다는 뜻 */
export const MATURE_STABILITY_DAYS = 21;

const lib = () => {
  const F = globalThis.FSRS;
  if (!F?.fsrs) throw new Error('FSRS 라이브러리(vendor/ts-fsrs.umd.js)를 불러오지 못했어요.');
  return F;
};

const schedulers = new Map();

/** 목표 기억률별 FSRS 스케줄러 */
export function scheduler(retention = 0.9) {
  const key = Math.round(retention * 100) / 100;
  if (!schedulers.has(key)) {
    const F = lib();
    schedulers.set(key, F.fsrs(F.generatorParameters({ request_retention: key, enable_fuzz: true, enable_short_term: true })));
  }
  return schedulers.get(key);
}

/** ts-fsrs 카드(Date 포함) → 저장용 JSON */
export function toJSON(card) {
  return {
    due: new Date(card.due).toISOString(),
    stability: card.stability,
    difficulty: card.difficulty,
    elapsed_days: card.elapsed_days,
    scheduled_days: card.scheduled_days,
    learning_steps: card.learning_steps ?? 0,
    reps: card.reps,
    lapses: card.lapses,
    state: card.state,
    last_review: card.last_review ? new Date(card.last_review).toISOString() : null,
  };
}

/** 저장용 JSON → ts-fsrs 카드 */
function fromJSON(json) {
  const { last_review, ...rest } = json;
  return lib().TypeConvert.card(last_review ? { ...rest, last_review } : rest);
}

/** 아직 한 번도 복습하지 않은 새 카드 */
export function newCard(now = new Date()) {
  return toJSON(lib().createEmptyCard(now));
}

/**
 * 버튼 네 개를 각각 눌렀을 때의 다음 복습 시점 미리보기.
 * @returns {{[rating: number]: {due: string, intervalMs: number, label: string}}}
 */
export function preview(card, now = new Date(), retention = 0.9) {
  const rec = scheduler(retention).repeat(fromJSON(card), now);
  const out = {};
  for (const r of [Rating.Again, Rating.Hard, Rating.Good, Rating.Easy]) {
    const due = new Date(rec[r].card.due);
    const intervalMs = due.getTime() - now.getTime();
    out[r] = { due: due.toISOString(), intervalMs, label: formatInterval(intervalMs) };
  }
  return out;
}

/**
 * 복습 결과 반영.
 * @returns {{card: object, log: {rating: number, state: number, due: string, reviewedAt: string, stability: number, difficulty: number, scheduledDays: number}}}
 *   card는 새 카드 상태, log.state는 복습 "전"의 상태, log.due는 새 복습 예정 시각
 */
export function rate(card, rating, now = new Date(), retention = 0.9) {
  if (![1, 2, 3, 4].includes(rating)) throw new Error(`잘못된 평가 값: ${rating}`);
  const { card: next } = scheduler(retention).next(fromJSON(card), now, rating);
  const json = toJSON(next);
  return {
    card: json,
    log: {
      rating,
      state: card.state,
      due: json.due,
      reviewedAt: now.toISOString(),
      stability: json.stability,
      difficulty: json.difficulty,
      scheduledDays: json.scheduled_days,
    },
  };
}

/** 단어 상태: 'new'(새 단어) | 'learning'(학습 중) | 'mature'(익힘) */
export function cardStatus(card) {
  if (card.state === State.New) return 'new';
  if (card.state === State.Review && card.stability >= MATURE_STABILITY_DAYS) return 'mature';
  return 'learning';
}

export const STATUS_LABEL = { new: '새 단어', learning: '학습 중', mature: '익힘' };

/** 어려운 단어: 한 번이라도 잊었거나, 복습해 본 결과 난이도가 높은 단어 */
export function isHard(card) {
  return card.lapses >= 1 || (card.reps > 0 && card.difficulty >= 7);
}

/** 오늘(한국 날짜) 새로 시작한 단어 수. 복습 기록에서 "복습 전 상태가 새 단어"였던 줄을 센다. */
export function newDoneToday(reviewLogs, now = new Date()) {
  const today = kstDate(now);
  const ids = new Set();
  for (const l of reviewLogs) {
    if (l.state === State.New && kstDate(new Date(l.reviewedAt)) === today) ids.add(l.wordId);
  }
  return ids.size;
}

/**
 * 오늘 복습할 단어를 종류별로 나눈다.
 *   learning : 배우는 중(분 단위 간격). 예정 시각이 오늘 안인 것 — 시각순
 *   review   : 복습 카드. 예정일이 오늘이거나 지난 것 — 오래 밀린 순
 *   fresh    : 새 단어. 하루 한도(limitNew)에서 오늘 이미 시작한 수(doneNew)를 뺀 만큼 — 저장한 순
 * @param {{id: string, card: object, createdAt: string}[]} words
 */
export function dueCards(words, now = new Date(), { limitNew = 20, doneNew = 0 } = {}) {
  const today = kstDate(now);
  const learning = [];
  const review = [];
  const fresh = [];
  for (const w of words) {
    const c = w.card;
    if (!c) continue;
    if (c.state === State.New) fresh.push(w);
    else if (c.state === State.Review) {
      if (kstDate(new Date(c.due)) <= today) review.push(w);
    } else if (kstDate(new Date(c.due)) <= today) learning.push(w);
  }
  const byDue = (a, b) => Date.parse(a.card.due) - Date.parse(b.card.due);
  learning.sort(byDue);
  review.sort(byDue);
  fresh.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  const freshAllowed = Math.max(0, limitNew - doneNew);
  return {
    learning,
    review,
    fresh: fresh.slice(0, freshAllowed),
    freshWaiting: Math.max(0, fresh.length - freshAllowed),
    total: learning.length + review.length + Math.min(fresh.length, freshAllowed),
  };
}

/**
 * 지금 보여 줄 다음 단어를 고른다.
 * 순서: ① 시각이 된 학습 카드 → ② 복습 카드 → ③ 새 단어 → ④ 곧(20분 안에) 돌아올 학습 카드
 * @returns {{word: object, kind: 'learning'|'review'|'fresh'} | {word: null, waitMs: number|null}}
 *   볼 것이 없으면 word는 null. waitMs는 다음 학습 카드까지 남은 시간(없으면 null).
 */
export function pickNext(queues, now = new Date()) {
  const t = now.getTime();
  const dueLearning = queues.learning.find((w) => Date.parse(w.card.due) <= t);
  if (dueLearning) return { word: dueLearning, kind: 'learning' };
  if (queues.review.length) return { word: queues.review[0], kind: 'review' };
  if (queues.fresh.length) return { word: queues.fresh[0], kind: 'fresh' };
  const soon = queues.learning[0];
  if (soon) {
    const waitMs = Date.parse(soon.card.due) - t;
    if (waitMs <= LEARN_AHEAD_MS) return { word: soon, kind: 'learning' };
    return { word: null, waitMs };
  }
  return { word: null, waitMs: null };
}

/** 내일 복습 예정 개수 (복습 카드 중 예정일이 내일인 것 + 오늘 밤 넘겨 배우는 중인 것) */
export function dueTomorrow(words, now = new Date()) {
  const tomorrow = addDays(kstDate(now), 1);
  let n = 0;
  for (const w of words) {
    if (w.card && w.card.state !== State.New && kstDate(new Date(w.card.due)) === tomorrow) n++;
  }
  return n;
}

/** 탭 배지에 쓸 "오늘 복습할 개수" */
export function dueCount(words, reviewLogs, now, limitNew) {
  return dueCards(words, now, { limitNew, doneNew: newDoneToday(reviewLogs, now) }).total;
}
