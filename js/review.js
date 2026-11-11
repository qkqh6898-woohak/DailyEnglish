// review.js — 복습 화면 (FSRS)
// 오늘 복습할 단어를 한 장씩 보여 주고, 다시/어려움/알맞음/쉬움으로 평가한다.

import { applyReview, getAll, undoReview } from './db.js';
import { highlightIn, speakButton } from './popup.js';
import { pref, setPref } from './prefs.js';
import { POS_LABEL } from './schema.js';
import { dueCards, dueTomorrow, newDoneToday, pickNext, preview, rate, RATING_LABEL, State } from './srs.js';
import * as tts from './tts.js';
import { clear, emit, emptyState, h, toast } from './ui.js';
import { formatInterval, kstDate, splitAround } from './util.js';

const RATING_CLASS = { 1: 'again', 2: 'hard', 3: 'good', 4: 'easy' };

export async function render(root) {
  let words = [];
  let queues = null;
  let current = null; // { word, kind }
  let revealed = false;
  let done = 0;
  let lastUndo = null; // { wordBefore, logId }
  let forceAhead = false;
  let disposed = false;

  const load = async () => {
    const now = new Date();
    const [w, logs] = await Promise.all([getAll('words'), getAll('reviewLogs')]);
    words = w;
    queues = dueCards(words, now, { limitNew: pref('newPerDay'), doneNew: newDoneToday(logs, now) });
  };

  const removeFromQueues = (id) => {
    for (const k of ['learning', 'review', 'fresh']) queues[k] = queues[k].filter((x) => x.id !== id);
  };

  const remaining = () => queues.learning.length + queues.review.length + queues.fresh.length;

  // ── 화면 틀 ───────────────────────────────────────────────────────
  const counts = h('p', { class: 'view-sub', 'aria-live': 'polite' });
  const progress = h('progress', { max: 1, value: 0, 'aria-label': '오늘 복습 진행' });
  const stage = h('div', { class: 'review-stage' });
  const undoBtn = h('button', { type: 'button', class: 'link-btn', hidden: true, onclick: () => undo() }, '↩︎ 방금 평가 되돌리기');
  const modeBtns = [
    ['en-ko', '영 → 한'],
    ['ko-en', '한 → 영'],
  ].map(([id, label]) =>
    h(
      'button',
      {
        type: 'button',
        class: 'seg',
        dataset: { mode: id },
        onclick: async () => {
          await setPref('reviewMode', id);
          paintMode();
          if (current) showCard();
        },
      },
      label,
    ),
  );
  const paintMode = () =>
    modeBtns.forEach((b) => {
      const on = b.dataset.mode === pref('reviewMode');
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', String(on));
    });
  paintMode();

  clear(root).append(
    h(
      'div',
      { class: 'review' },
      h(
        'header',
        { class: 'view-head' },
        h('div', { class: 'row between' }, h('h1', { class: 'view-title' }, '🔁 복습'), h('div', { class: 'segmented', role: 'group', 'aria-label': '복습 방향' }, modeBtns)),
        counts,
        progress,
      ),
      stage,
      h('div', { class: 'review-foot' }, undoBtn),
    ),
  );
  document.title = '복습 — Daily English Reader';

  const paintCounts = () => {
    const left = remaining();
    counts.textContent = left
      ? `오늘 복습 ${queues.review.length + queues.learning.length}개 · 새 단어 ${queues.fresh.length}개`
      : words.length
        ? '오늘 복습을 모두 마쳤어요.'
        : '';
    progress.max = Math.max(1, done + left);
    progress.value = done;
    undoBtn.hidden = !lastUndo;
  };

  // ── 카드 ──────────────────────────────────────────────────────────
  function showCard() {
    const { word } = current;
    const mode = pref('reviewMode');
    const src = word.sources?.[0] ?? null;
    const parts = src ? splitAround(src.sentence, src.t) : null;
    const posLabel = word.kind === 'phrase' ? '구' : (POS_LABEL[word.pos] ?? '');

    const sentenceFull = src ? h('p', { class: 'rc-sent' }, highlightIn(src.sentence, src.t), speakButton(src.sentence, { label: '기사 문장 듣기', id: 'sentence' })) : null;
    const sentenceBlank =
      src && parts ? h('p', { class: 'rc-sent' }, h('span', { lang: 'en' }, parts[0], h('span', { class: 'blank', 'aria-label': '빈칸' }, '＿＿＿＿'), parts[2])) : null;

    const wordLine = h(
      'div',
      { class: 'rc-word-line' },
      h('h2', { class: 'rc-word', lang: 'en' }, word.text),
      posLabel ? h('span', { class: 'ws-pos' }, posLabel) : null,
      speakButton(word.text, { label: `${word.text} 발음 듣기` }),
    );
    const meaning = h('p', { class: 'rc-ko' }, word.ko);
    const contextKo = src?.ko && src.ko !== word.ko ? h('p', { class: 'rc-context' }, `이 문장에서의 뜻: ${src.ko}`) : null;
    const example = word.ex ? h('p', { class: 'ws-ex' }, h('span', { class: 'ws-ex-label' }, '예문'), h('span', { lang: 'en' }, word.ex), speakButton(word.ex, { label: '예문 듣기', id: 'ex' })) : null;

    const front = mode === 'en-ko' ? [wordLine, sentenceFull] : [h('p', { class: 'rc-prompt-label' }, '이 뜻의 영어 표현은?'), meaning, sentenceBlank];
    const back = mode === 'en-ko' ? [meaning, contextKo, example] : [wordLine, sentenceFull, contextKo, example];

    const kindLabel = { learning: '학습 중', review: '복습', fresh: '새 단어' }[current.kind];
    const card = h('div', { class: 'review-card' }, h('span', { class: `badge badge-${current.kind}` }, kindLabel), h('div', { class: 'rc-front' }, front));

    const actions = h('div', { class: 'review-actions' });
    if (!revealed) {
      actions.append(h('button', { type: 'button', class: 'btn btn-primary btn-wide btn-reveal', onclick: reveal }, mode === 'en-ko' ? '뜻 보기' : '정답 보기'));
    } else {
      card.append(h('hr', { class: 'rc-divider' }), h('div', { class: 'rc-back' }, back));
      const pv = preview(word.card, new Date(), pref('retention'));
      actions.append(
        h(
          'div',
          { class: 'ratings', role: 'group', 'aria-label': '얼마나 잘 기억했나요?' },
          [1, 2, 3, 4].map((r) =>
            h(
              'button',
              { type: 'button', class: `rating rating-${RATING_CLASS[r]}`, dataset: { rating: r }, onclick: () => onRate(r) },
              h('span', { class: 'rating-label' }, RATING_LABEL[r]),
              h('span', { class: 'rating-int' }, pv[r].label),
            ),
          ),
        ),
      );
    }
    clear(stage).append(card, actions);
    paintCounts();
    if (!revealed) actions.querySelector('.btn-reveal')?.focus({ preventScroll: true });
  }

  function reveal() {
    if (!current || revealed) return;
    revealed = true;
    showCard();
  }

  async function onRate(r) {
    if (!current || !revealed) return;
    const { word } = current;
    const now = new Date();
    const wordBefore = structuredClone(word);
    try {
      const result = rate(word.card, r, now, pref('retention'));
      const logId = await applyReview(word.id, result.card, result.log, now.toISOString());
      removeFromQueues(word.id);
      word.card = result.card;
      // 아직 배우는 중(분 단위 간격)이고 오늘 다시 나올 카드는 학습 줄에 다시 넣는다.
      const again = (result.card.state === State.Learning || result.card.state === State.Relearning) && kstDate(new Date(result.card.due)) <= kstDate(now);
      if (again) {
        queues.learning.push(word);
        queues.learning.sort((a, b) => Date.parse(a.card.due) - Date.parse(b.card.due));
      } else {
        done++;
      }
      lastUndo = { wordBefore, logId, counted: !again };
      tts.stop();
      emit('review-changed');
      next();
    } catch (err) {
      toast('저장하지 못했어요: ' + err.message, { kind: 'warn' });
    }
  }

  async function undo() {
    if (!lastUndo) return;
    const { wordBefore, logId, counted } = lastUndo;
    lastUndo = null;
    try {
      await undoReview(wordBefore, logId);
      await load();
      if (counted) done = Math.max(0, done - 1);
      const word = words.find((w) => w.id === wordBefore.id);
      emit('review-changed');
      if (word) {
        const kind = word.card.state === State.New ? 'fresh' : word.card.state === State.Review ? 'review' : 'learning';
        current = { word, kind };
        revealed = false;
        showCard();
        toast('되돌렸어요.');
      } else next();
    } catch (err) {
      toast('되돌리지 못했어요: ' + err.message, { kind: 'warn' });
    }
  }

  // ── 다음 카드 / 완료 ──────────────────────────────────────────────
  function next() {
    if (disposed) return;
    const now = new Date();
    let pick = pickNext(queues, now);
    if (!pick.word && forceAhead && queues.learning.length) pick = { word: queues.learning[0], kind: 'learning' };
    if (pick.word) {
      current = pick;
      revealed = false;
      showCard();
      return;
    }
    current = null;
    forceAhead = false;
    showDone(pick.waitMs);
  }

  function showDone(waitMs) {
    paintCounts();
    if (!words.length) {
      clear(stage).append(
        emptyState({
          icon: '🌱',
          title: '복습할 단어가 아직 없어요.',
          message: '기사에서 단어를 ⭐로 저장하면 여기서 간격 반복으로 복습해요.',
          action: h('a', { class: 'btn btn-primary', href: '#/today' }, '오늘의 기사 읽기'),
        }),
      );
      return;
    }
    const tomorrow = dueTomorrow(words, new Date());
    const waiting = queues.freshWaiting;
    const lines = [];
    if (waitMs != null) lines.push(`약 ${formatInterval(waitMs)} 뒤에 다시 볼 카드가 ${queues.learning.length}개 있어요.`);
    lines.push(`내일 복습 예정: ${tomorrow}개` + (waiting ? ` · 대기 중인 새 단어 ${waiting}개 (하루 ${pref('newPerDay')}개씩)` : ''));
    clear(stage).append(
      emptyState({
        icon: '🎉',
        title: done ? '오늘 복습 완료!' : '지금은 복습할 단어가 없어요.',
        message: lines.join(' '),
        action: h(
          'div',
          { class: 'col-actions' },
          waitMs != null
            ? h(
                'button',
                {
                  type: 'button',
                  class: 'btn',
                  onclick: () => {
                    forceAhead = true;
                    next();
                  },
                },
                '기다리지 않고 지금 보기',
              )
            : null,
          h('a', { class: 'btn btn-primary', href: '#/today' }, '오늘의 기사로'),
          h('a', { class: 'btn', href: '#/vocab' }, '단어장 보기'),
        ),
      }),
    );
  }

  // ── 키보드: Space/Enter 뜻 보기, 1~4 평가, Z 되돌리기 ───────────────
  const onKey = (e) => {
    if (e.target.closest?.('input, textarea, select') || document.querySelector('.sheet-backdrop, .dialog-backdrop')) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (!current) return;
    if (!revealed && (e.key === ' ' || e.key === 'Enter')) {
      e.preventDefault();
      reveal();
    } else if (revealed && ['1', '2', '3', '4'].includes(e.key)) {
      e.preventDefault();
      onRate(Number(e.key));
    } else if (e.key.toLowerCase() === 'z' && lastUndo) {
      e.preventDefault();
      undo();
    }
  };
  document.addEventListener('keydown', onKey);

  await load();
  next();

  return () => {
    disposed = true;
    document.removeEventListener('keydown', onKey);
    tts.stop();
  };
}
