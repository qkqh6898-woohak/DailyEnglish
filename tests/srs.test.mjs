// FSRS 래퍼(js/srs.js) 단위 테스트

import assert from 'node:assert/strict';
import { test } from 'node:test';

await import('../vendor/ts-fsrs.umd.js'); // 전역 FSRS를 만든다 (브라우저의 <script>와 같은 방식)
const { cardStatus, dueCards, dueCount, dueTomorrow, isHard, LEARN_AHEAD_MS, newCard, newDoneToday, pickNext, preview, Rating, rate, State } = await import('../js/srs.js');

const MIN = 60_000;
const DAY = 86_400_000;
const T0 = new Date('2026-11-28T00:00:00Z'); // 한국 시간 11/28 09:00
const at = (ms) => new Date(T0.getTime() + ms);
const gap = (card, from) => Date.parse(card.due) - from.getTime();

test('전역 FSRS 라이브러리가 준비되어 있다', () => {
  assert.equal(typeof globalThis.FSRS.fsrs, 'function');
});

test('새 카드: 저장하기 좋은 JSON 모양이고 상태는 New', () => {
  const c = newCard(T0);
  assert.deepEqual(c, {
    due: '2026-11-28T00:00:00.000Z',
    stability: 0,
    difficulty: 0,
    elapsed_days: 0,
    scheduled_days: 0,
    learning_steps: 0,
    reps: 0,
    lapses: 0,
    state: State.New,
    last_review: null,
  });
  assert.deepEqual(JSON.parse(JSON.stringify(c)), c);
});

test('새 카드 → 알맞음: 다음 복습일이 미래다', () => {
  const { card, log } = rate(newCard(T0), Rating.Good, T0);
  assert.ok(Date.parse(card.due) > T0.getTime());
  assert.equal(gap(card, T0), 10 * MIN, '첫 학습 단계는 10분 뒤');
  assert.equal(card.state, State.Learning);
  assert.equal(card.reps, 1);
  assert.equal(card.last_review, T0.toISOString());
  assert.deepEqual(
    { rating: log.rating, state: log.state, due: log.due, reviewedAt: log.reviewedAt },
    { rating: 3, state: State.New, due: card.due, reviewedAt: T0.toISOString() },
    '기록의 state는 복습 전 상태',
  );
});

test('새 카드 → 다시: 짧은 간격(1분)', () => {
  const { card } = rate(newCard(T0), Rating.Again, T0);
  assert.equal(gap(card, T0), 1 * MIN);
  assert.equal(card.state, State.Learning);
  assert.ok(gap(card, T0) < gap(rate(newCard(T0), Rating.Good, T0).card, T0));
});

test('새 카드 → 쉬움: 학습 단계를 건너뛰고 며칠 뒤 복습', () => {
  const { card } = rate(newCard(T0), Rating.Easy, T0);
  assert.equal(card.state, State.Review);
  assert.ok(gap(card, T0) >= 4 * DAY, `간격 ${gap(card, T0) / DAY}일`);
});

test('알맞음을 이어 가면 간격이 계속 늘어난다', () => {
  let card = newCard(T0);
  let now = T0;
  const intervals = [];
  for (let i = 0; i < 6; i++) {
    const next = rate(card, Rating.Good, now).card;
    intervals.push(Date.parse(next.due) - now.getTime());
    card = next;
    now = new Date(next.due);
  }
  assert.equal(intervals[0], 10 * MIN);
  assert.equal(intervals[1], 2 * DAY);
  for (let i = 2; i < intervals.length; i++) assert.ok(intervals[i] > intervals[i - 1], `${i}번째 간격이 더 길어야 한다: ${intervals.map((x) => x / DAY)}`);
  assert.equal(card.state, State.Review);
  assert.equal(card.reps, 6);
  assert.equal(card.lapses, 0);
});

test('복습 카드를 틀리면(다시) 재학습으로 가고 틀린 횟수가 늘며 안정도가 떨어진다', () => {
  let card = newCard(T0);
  let now = T0;
  for (let i = 0; i < 4; i++) {
    card = rate(card, Rating.Good, now).card;
    now = new Date(card.due);
  }
  const before = card;
  const { card: lapsed } = rate(before, Rating.Again, now);
  assert.equal(lapsed.state, State.Relearning);
  assert.equal(lapsed.lapses, 1);
  assert.equal(gap(lapsed, now), 10 * MIN);
  assert.ok(lapsed.stability < before.stability);
  assert.ok(lapsed.difficulty > before.difficulty);
  assert.equal(isHard(lapsed), true);
  assert.equal(isHard(before), false);
});

test('직렬화(JSON) 후 복원해도 같은 결과가 나온다', () => {
  let card = rate(newCard(T0), Rating.Good, T0).card;
  card = rate(card, Rating.Good, at(10 * MIN)).card;
  const restored = JSON.parse(JSON.stringify(card));
  assert.deepEqual(restored, card);
  const when = new Date(card.due);
  assert.deepEqual(rate(restored, Rating.Good, when), rate(card, Rating.Good, when));
  assert.deepEqual(preview(restored, when), preview(card, when));
});

test('rate는 넘겨받은 카드를 바꾸지 않는다', () => {
  const card = newCard(T0);
  const copy = structuredClone(card);
  rate(card, Rating.Good, T0);
  preview(card, T0);
  assert.deepEqual(card, copy);
});

test('미리보기: 버튼 네 개의 간격과 한국어 표시', () => {
  const pv = preview(newCard(T0), T0);
  assert.deepEqual(
    [1, 2, 3].map((r) => pv[r].label),
    ['1분', '6분', '10분'],
  );
  assert.match(pv[4].label, /^\d+일$/);
  assert.ok(pv[1].intervalMs < pv[2].intervalMs && pv[2].intervalMs < pv[3].intervalMs && pv[3].intervalMs < pv[4].intervalMs);
  // 미리보기와 실제 평가 결과가 같다
  for (const r of [1, 2, 3, 4]) assert.equal(pv[r].due, rate(newCard(T0), r, T0).card.due);
});

test('목표 기억률이 높을수록 복습 간격이 짧다', () => {
  const grown = (retention) => {
    let card = newCard(T0);
    let now = T0;
    for (let i = 0; i < 5; i++) {
      card = rate(card, Rating.Good, now, retention).card;
      now = new Date(card.due);
    }
    return card.scheduled_days;
  };
  assert.ok(grown(0.95) < grown(0.9));
  assert.ok(grown(0.9) < grown(0.8));
});

test('잘못된 평가 값은 거절한다', () => {
  assert.throws(() => rate(newCard(T0), 0, T0), /잘못된 평가 값/);
  assert.throws(() => rate(newCard(T0), 5, T0), /잘못된 평가 값/);
});

test('단어 상태: 새 단어 → 학습 중 → 익힘', () => {
  let card = newCard(T0);
  assert.equal(cardStatus(card), 'new');
  let now = T0;
  card = rate(card, Rating.Good, now).card;
  assert.equal(cardStatus(card), 'learning');
  for (let i = 0; i < 6 && cardStatus(card) !== 'mature'; i++) {
    now = new Date(card.due);
    card = rate(card, Rating.Good, now).card;
  }
  assert.equal(cardStatus(card), 'mature');
  assert.ok(card.stability >= 21);
});

// ── 오늘 복습할 단어 고르기 ──────────────────────────────────────────

const word = (id, card, createdAt = '2026-11-20T00:00:00.000Z') => ({ id, card, createdAt });

function sampleWords(now) {
  const reviewDueToday = { ...rate(rate(newCard(at(-3 * DAY)), 3, at(-3 * DAY)).card, 3, at(-3 * DAY + 10 * MIN)).card }; // 2일 간격 → 어제 예정
  const reviewLater = { ...reviewDueToday, due: new Date(now.getTime() + 5 * DAY).toISOString() };
  const reviewTonight = { ...reviewDueToday, due: '2026-11-28T14:00:00.000Z' }; // 한국 시간 오늘 23:00
  const reviewTomorrow = { ...reviewDueToday, due: '2026-11-28T15:30:00.000Z' }; // 한국 시간 내일 00:30
  const learningSoon = rate(newCard(now), 3, at(-5 * MIN)).card; // 5분 뒤
  const learningDue = rate(newCard(now), 1, at(-5 * MIN)).card; // 이미 지남
  return [
    word('fresh-b', newCard(now), '2026-11-27T00:00:00.000Z'),
    word('fresh-a', newCard(now), '2026-11-26T00:00:00.000Z'),
    word('fresh-c', newCard(now), '2026-11-27T12:00:00.000Z'),
    word('review-today', reviewDueToday),
    word('review-later', reviewLater),
    word('review-tonight', reviewTonight),
    word('review-tomorrow', reviewTomorrow),
    word('learning-soon', learningSoon),
    word('learning-due', learningDue),
  ];
}

test('dueCards: 종류별로 나누고, 복습 카드는 "오늘(한국 날짜) 안"이면 포함한다', () => {
  const q = dueCards(sampleWords(T0), T0, { limitNew: 20, doneNew: 0 });
  assert.deepEqual(q.learning.map((w) => w.id), ['learning-due', 'learning-soon']);
  assert.deepEqual(q.review.map((w) => w.id), ['review-today', 'review-tonight'], '밤 11시 예정도 오늘 복습에 포함, 내일 0시 30분은 제외');
  assert.deepEqual(q.fresh.map((w) => w.id), ['fresh-a', 'fresh-b', 'fresh-c'], '새 단어는 저장한 순서');
  assert.equal(q.total, 7);
  assert.equal(q.freshWaiting, 0);
});

test('dueCards: 하루 새 단어 한도에서 오늘 이미 시작한 수를 뺀다', () => {
  const words = sampleWords(T0);
  const limited = dueCards(words, T0, { limitNew: 2, doneNew: 0 });
  assert.deepEqual(limited.fresh.map((w) => w.id), ['fresh-a', 'fresh-b']);
  assert.equal(limited.freshWaiting, 1);
  assert.equal(limited.total, 6);
  const used = dueCards(words, T0, { limitNew: 2, doneNew: 2 });
  assert.equal(used.fresh.length, 0);
  assert.equal(used.freshWaiting, 3);
  assert.equal(dueCards(words, T0, { limitNew: 0 }).fresh.length, 0);
});

test('newDoneToday: 오늘(한국 날짜) 처음 시작한 단어 수', () => {
  const logs = [
    { wordId: 'a', state: State.New, reviewedAt: '2026-11-27T23:30:00.000Z' }, // 한국 시간 11/28 08:30 → 오늘
    { wordId: 'a', state: State.Learning, reviewedAt: '2026-11-27T23:40:00.000Z' },
    { wordId: 'b', state: State.New, reviewedAt: '2026-11-27T14:59:00.000Z' }, // 한국 시간 11/27 23:59 → 어제
    { wordId: 'c', state: State.New, reviewedAt: '2026-11-28T00:10:00.000Z' },
    { wordId: 'c', state: State.New, reviewedAt: '2026-11-28T00:20:00.000Z' }, // 되돌리고 다시 한 경우: 한 번만 센다
    { wordId: 'd', state: State.Review, reviewedAt: '2026-11-28T00:30:00.000Z' },
  ];
  assert.equal(newDoneToday(logs, T0), 2);
  assert.equal(dueCount(sampleWords(T0), logs, T0, 3), 4 + 1, '학습 2 + 복습 2 + 새 단어 (3 - 2)');
});

test('pickNext: 시각이 된 학습 카드 → 복습 → 새 단어 → 곧 돌아올 학습 카드 순서', () => {
  const q = dueCards(sampleWords(T0), T0);
  const order = [];
  for (let i = 0; i < 20; i++) {
    const pick = pickNext(q, T0);
    if (!pick.word) break;
    order.push(`${pick.kind}:${pick.word.id}`);
    for (const k of ['learning', 'review', 'fresh']) q[k] = q[k].filter((w) => w.id !== pick.word.id);
  }
  assert.deepEqual(order, [
    'learning:learning-due',
    'review:review-today',
    'review:review-tonight',
    'fresh:fresh-a',
    'fresh:fresh-b',
    'fresh:fresh-c',
    'learning:learning-soon', // 5분 뒤 예정이지만 다른 할 일이 없으므로 미리 보여 준다
  ]);
  assert.deepEqual(pickNext(q, T0), { word: null, waitMs: null });
});

test('pickNext: 남은 학습 카드가 20분보다 멀면 기다리라고 알려 준다', () => {
  const far = word('far', { ...rate(newCard(T0), 3, T0).card, due: at(LEARN_AHEAD_MS + 5 * MIN).toISOString() });
  const q = { learning: [far], review: [], fresh: [] };
  assert.deepEqual(pickNext(q, T0), { word: null, waitMs: LEARN_AHEAD_MS + 5 * MIN });
  assert.equal(pickNext(q, at(6 * MIN)).word.id, 'far');
});

test('dueTomorrow: 내일(한국 날짜) 예정인 카드 수', () => {
  assert.equal(dueTomorrow(sampleWords(T0), T0), 1);
});
