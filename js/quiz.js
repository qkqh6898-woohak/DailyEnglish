// quiz.js — 토익 Part 5, 오답 노트, 주간 퀴즈
//
// 퀴즈 결과(quizResults)의 모양
//   Part 5   { id: '2026-11-28#0', kind: 'part5', date, index, type, chosen, correct, everWrong, attempts, answeredAt, firstAnsweredAt }
//   주간 문제 { id: 'weekly#2026-11-29#3', kind: 'weekly', week, index, type, ref, chosen, correct, answeredAt }
//   주간 완료 { id: 'weekly#2026-11-29#done', kind: 'weekly-summary', week, correct, total, answeredAt }

import { cachedArticles, getArticle } from './articles.js';
import { getAll, put, tx } from './db.js';
import { speakButton } from './popup.js';
import { TOEIC_TYPE_LABEL } from './schema.js';
import { clear, emit, emptyState, h, spinner } from './ui.js';
import { daysUntilSunday, formatKoDate, formatShortDate, kstDate, kstDateOf, quizWeek, shuffle } from './util.js';

const LETTERS = ['A', 'B', 'C', 'D'];
const WEEKLY_WORDS = 10;
const WEEKLY_PART5_MAX = 5;

const fillBlank = (q, answer) => q.replace(/_{3,}/, answer);

/** 기사 속 Part 5 문제 → 퀴즈 화면용 문제 */
function part5Question(article, i) {
  const q = article.toeic_part5[i];
  return {
    key: `${article.date}#${i}`,
    kind: 'part5',
    date: article.date,
    index: i,
    type: q.type,
    tag: `Part 5 · ${TOEIC_TYPE_LABEL[q.type] ?? q.type}`,
    prompt: q.q,
    promptLang: 'en',
    choices: q.choices,
    choiceLang: 'en',
    answer: q.answer,
    explain: q.explain_ko,
    full: fillBlank(q.q, q.choices[q.answer]),
  };
}

/** Part 5 결과 저장 (처음 푼 시각, 틀린 적이 있는지, 시도 횟수를 함께 관리) */
async function recordPart5(q, chosen, correct, nowIso = new Date().toISOString()) {
  await tx('quizResults', 'readwrite', async (s, w) => {
    const prev = await w(s.quizResults.get(q.key));
    await w(
      s.quizResults.put({
        id: q.key,
        kind: 'part5',
        date: q.date,
        index: q.index,
        type: q.type,
        chosen,
        correct,
        everWrong: Boolean(prev?.everWrong) || !correct,
        attempts: (prev?.attempts ?? 0) + 1,
        answeredAt: nowIso,
        firstAnsweredAt: prev?.firstAnsweredAt ?? nowIso,
      }),
    );
  });
  emit('quiz-changed');
}

// ── 퀴즈 진행 화면 (공통) ─────────────────────────────────────────────

/**
 * 문제를 하나씩 보여 주고, 고르면 바로 정답과 해설을 보여 준다.
 * @param {HTMLElement} root
 * @param {{title: string, subtitle?: string, questions: object[], onAnswer?: Function, onDone?: Function,
 *          backHref?: string, onBack?: () => void, backLabel: string,
 *          extraLinks?: {href: string, label: string}[], onRetry?: () => void}} opts
 *   돌아가기는 backHref(다른 화면으로 이동) 또는 onBack(같은 화면 안에서 처리) 중 하나로 정한다.
 * @returns {() => void} 정리 함수
 */
function runQuiz(root, opts) {
  const { title, subtitle, questions, onAnswer, onDone, backHref, onBack, backLabel, extraLinks = [], onRetry } = opts;
  const backEl = (cls, label) => (onBack ? h('button', { type: 'button', class: cls, onclick: onBack }, label) : h('a', { class: cls, href: backHref }, label));
  const results = [];
  let i = 0;
  let locked = false;
  let nextBtn = null;
  let choiceBtns = [];

  const onKey = (e) => {
    if (e.target.closest?.('input, textarea, select') || document.querySelector('.sheet-backdrop, .dialog-backdrop')) return;
    if (!locked) {
      const k = e.key.toUpperCase();
      const idx = LETTERS.includes(k) ? LETTERS.indexOf(k) : ['1', '2', '3', '4'].indexOf(k);
      if (idx >= 0 && choiceBtns[idx]) {
        e.preventDefault();
        choiceBtns[idx].click();
      }
    } else if (e.key === 'Enter' || e.key === ' ') {
      if (nextBtn && document.activeElement !== nextBtn) {
        e.preventDefault();
        nextBtn.click();
      }
    }
  };
  document.addEventListener('keydown', onKey);

  const head = () =>
    h(
      'header',
      { class: 'view-head' },
      backEl('back-link', `← ${backLabel}`),
      h('h1', { class: 'view-title' }, title),
      subtitle ? h('p', { class: 'view-sub' }, subtitle) : null,
    );

  const showQuestion = () => {
    const q = questions[i];
    locked = false;
    nextBtn = null;
    const feedback = h('div', { class: 'quiz-feedback', 'aria-live': 'polite' });
    choiceBtns = q.choices.map((c, ci) =>
      h(
        'button',
        {
          type: 'button',
          class: 'choice',
          dataset: { i: ci },
          onclick: () => choose(ci),
        },
        h('span', { class: 'choice-letter' }, LETTERS[ci]),
        h('span', { class: 'choice-text', lang: q.choiceLang }, c),
      ),
    );

    const choose = async (ci) => {
      if (locked) return;
      locked = true;
      const correct = ci === q.answer;
      results.push({ q, chosen: ci, correct });
      choiceBtns.forEach((b, bi) => {
        b.disabled = true;
        if (bi === q.answer) b.classList.add('right');
        else if (bi === ci) b.classList.add('wrong');
      });
      try {
        await onAnswer?.(q, ci, correct);
      } catch (err) {
        console.error(err);
      }
      const last = i === questions.length - 1;
      nextBtn = h(
        'button',
        {
          type: 'button',
          class: 'btn btn-primary btn-wide',
          onclick: () => {
            if (last) showResult();
            else {
              i++;
              showQuestion();
            }
          },
        },
        last ? '결과 보기' : '다음 문제',
      );
      feedback.append(
        h(
          'div',
          { class: `verdict ${correct ? 'verdict-right' : 'verdict-wrong'}` },
          h('b', null, correct ? '정답이에요! ✓' : `아쉬워요. 정답은 (${LETTERS[q.answer]}) ${q.choices[q.answer]}`),
          q.explain ? h('p', { class: 'explain' }, q.explain) : null,
          q.full ? h('p', { class: 'full-sentence' }, h('span', { lang: 'en' }, q.full), speakButton(q.full, { label: '정답 문장 듣기', id: 'quiz' })) : null,
        ),
        nextBtn,
      );
      nextBtn.focus({ preventScroll: true });
      nextBtn.scrollIntoView({ block: 'nearest' });
    };

    clear(root).append(
      h(
        'div',
        { class: 'quiz' },
        head(),
        h(
          'div',
          { class: 'quiz-progress' },
          h('span', { class: 'quiz-count' }, `${i + 1} / ${questions.length}`),
          h('progress', { max: questions.length, value: i, 'aria-label': '진행 상황' }),
        ),
        h('span', { class: 'badge badge-plain' }, q.tag),
        h(
          'div',
          { class: 'quiz-prompt' },
          q.promptLabel ? h('p', { class: 'quiz-prompt-label' }, q.promptLabel) : null,
          h('p', { class: 'quiz-q' }, h('span', { class: 'quiz-q-text', lang: q.promptLang }, q.prompt), q.speak ? speakButton(q.speak, { label: '발음 듣기', id: 'quiz' }) : null),
        ),
        h('div', { class: 'choices', role: 'group', 'aria-label': '보기' }, choiceBtns),
        feedback,
      ),
    );
    window.scrollTo({ top: 0 });
  };

  const showResult = async () => {
    const correct = results.filter((r) => r.correct).length;
    try {
      await onDone?.(results);
    } catch (err) {
      console.error(err);
    }
    const perfect = correct === results.length;
    clear(root).append(
      h(
        'div',
        { class: 'quiz' },
        head(),
        h(
          'div',
          { class: 'score-card' },
          h('div', { class: 'score-emoji', 'aria-hidden': 'true' }, perfect ? '🎉' : correct >= results.length / 2 ? '👍' : '💪'),
          h('p', { class: 'score' }, `${correct} / ${results.length}`),
          h('p', { class: 'score-sub' }, perfect ? '모두 맞혔어요!' : '틀린 문제는 오답 노트에서 다시 풀 수 있어요.'),
        ),
        h(
          'ol',
          { class: 'result-list' },
          results.map((r) =>
            h(
              'li',
              { class: r.correct ? 'res-right' : 'res-wrong' },
              h('span', { class: 'res-mark', 'aria-hidden': 'true' }, r.correct ? '✓' : '✗'),
              h(
                'div',
                null,
                h('p', { class: 'res-q', lang: r.q.promptLang }, r.q.prompt),
                h(
                  'p',
                  { class: 'res-a' },
                  r.correct ? `정답: ${r.q.choices[r.q.answer]}` : `내 답: ${r.q.choices[r.chosen]} → 정답: ${r.q.choices[r.q.answer]}`,
                ),
              ),
            ),
          ),
        ),
        h(
          'div',
          { class: 'col-actions' },
          onRetry ? h('button', { type: 'button', class: 'btn', onclick: onRetry }, '다시 풀기') : null,
          extraLinks.map((l) => h('a', { class: 'btn', href: l.href }, l.label)),
          backEl('btn btn-primary', backLabel),
        ),
      ),
    );
    window.scrollTo({ top: 0 });
  };

  showQuestion();
  return () => document.removeEventListener('keydown', onKey);
}

function fail(root, { title, message, backHref = '#/today', backLabel = '오늘의 기사로' }) {
  clear(root).append(emptyState({ icon: '📝', title, message, action: h('a', { class: 'btn btn-primary', href: backHref }, backLabel) }));
  return () => {};
}

// ── Part 5 ───────────────────────────────────────────────────────────

/** #/quiz/2026-11-28 */
export async function renderPart5(root, date) {
  clear(root).append(spinner('문제를 불러오는 중…'));
  let article;
  try {
    article = await getArticle(date);
  } catch (e) {
    return fail(root, { title: e.message });
  }
  const total = (article.toeic_part5 ?? []).length;
  if (!total) return fail(root, { title: '이 기사에는 Part 5 문제가 없어요.', backHref: `#/article/${date}`, backLabel: '기사로 돌아가기' });

  const start = async (onlyUnanswered) => {
    const done = new Set((await getAll('quizResults')).filter((r) => r.kind === 'part5' && r.date === date).map((r) => r.index));
    let questions = article.toeic_part5.map((_, i) => part5Question(article, i));
    // 일부만 풀고 나갔다면 남은 문제부터 이어서 푼다.
    if (onlyUnanswered && done.size > 0 && done.size < total) questions = questions.filter((q) => !done.has(q.index));
    return runQuiz(root, {
      title: '토익 Part 5',
      subtitle: `${formatKoDate(article.date)} · ${article.title.en}`,
      questions,
      onAnswer: (q, chosen, correct) => recordPart5(q, chosen, correct),
      backHref: `#/article/${date}`,
      backLabel: '기사로 돌아가기',
      extraLinks: [{ href: '#/quiz/wrong', label: '오답 노트' }],
      onRetry: () => {
        stop();
        start(false).then((fn) => (stop = fn));
      },
    });
  };
  let stop = await start(true);
  return () => stop();
}

// ── 오답 노트 ────────────────────────────────────────────────────────

/** 지금 틀린 상태인 Part 5 문제들 (기사 사본에서 문제 내용을 찾는다) */
async function wrongQuestions() {
  const wrong = (await getAll('quizResults')).filter((r) => r.kind === 'part5' && !r.correct);
  if (!wrong.length) return [];
  const byDate = new Map((await cachedArticles()).map((a) => [a.date, a]));
  const out = [];
  for (const r of wrong.sort((a, b) => String(b.answeredAt).localeCompare(String(a.answeredAt)))) {
    let article = byDate.get(r.date);
    if (!article) {
      article = await getArticle(r.date).catch(() => null);
      if (article) byDate.set(r.date, article);
    }
    if (!article?.toeic_part5?.[r.index]) continue;
    out.push({ ...part5Question(article, r.index), chosen: r.chosen, attempts: r.attempts });
  }
  return out;
}

/** #/quiz/wrong */
export async function renderWrong(root) {
  clear(root).append(spinner());
  let stop = () => {};
  const list = async () => {
    const questions = await wrongQuestions();
    if (!questions.length) {
      clear(root).append(
        h(
          'div',
          { class: 'quiz' },
          h('header', { class: 'view-head' }, h('a', { class: 'back-link', href: '#/today' }, '← 오늘의 기사로'), h('h1', { class: 'view-title' }, '오답 노트')),
          emptyState({ icon: '✨', title: '틀린 문제가 없어요.', message: 'Part 5에서 틀린 문제가 여기에 모여요. 다시 풀어서 맞히면 사라져요.' }),
        ),
      );
      return;
    }
    clear(root).append(
      h(
        'div',
        { class: 'quiz' },
        h(
          'header',
          { class: 'view-head' },
          h('a', { class: 'back-link', href: '#/today' }, '← 오늘의 기사로'),
          h('h1', { class: 'view-title' }, '오답 노트'),
          h('p', { class: 'view-sub' }, `틀린 문제 ${questions.length}개 · 다시 풀어서 맞히면 사라져요.`),
        ),
        h(
          'button',
          {
            type: 'button',
            class: 'btn btn-primary btn-wide',
            onclick: () => {
              stop = runQuiz(root, {
                title: '오답 다시 풀기',
                questions: shuffle(questions),
                onAnswer: (q, chosen, correct) => recordPart5(q, chosen, correct),
                onBack: () => {
                  stop();
                  stop = () => {};
                  list();
                },
                backLabel: '오답 노트로',
              });
            },
          },
          `다시 풀기 (${questions.length}문제)`,
        ),
        h(
          'ul',
          { class: 'wrong-list' },
          questions.map((q) =>
            h(
              'li',
              { class: 'card' },
              h('div', { class: 'wrong-meta' }, h('span', { class: 'badge badge-plain' }, q.tag), h('a', { href: `#/article/${q.date}` }, formatShortDate(q.date) + ' 기사')),
              h('p', { class: 'res-q', lang: 'en' }, q.prompt),
              h('p', { class: 'res-a' }, `내 답: ${q.choices[q.chosen] ?? '-'}`),
              h(
                'details',
                { class: 'wrong-detail' },
                h('summary', null, '정답과 해설 보기'),
                h('p', { class: 'res-a' }, `정답: (${LETTERS[q.answer]}) ${q.choices[q.answer]}`),
                h('p', { class: 'explain' }, q.explain),
              ),
            ),
          ),
        ),
      ),
    );
  };
  await list();
  return () => stop();
}

// ── 주간 퀴즈 ────────────────────────────────────────────────────────

const normKo = (s) => String(s).replace(/\s+/g, '').toLowerCase();
const inWeek = (iso, week) => {
  const d = kstDateOf(iso);
  return d != null && d >= week.start && d <= week.end;
};

/** 보기로 쓸 뜻 후보: 기기에 있는 기사들의 핵심 단어(예문이 달린 단어)와 구 */
async function lexiconPool() {
  const pool = [];
  for (const a of await cachedArticles()) {
    for (const par of a.paragraphs) {
      for (const t of par.tokens) if (t.ko && t.ex) pool.push({ kind: 'word', pos: t.p, lemma: String(t.l).toLowerCase(), ko: t.ko });
      for (const ph of par.phrases ?? []) pool.push({ kind: 'phrase', pos: '', lemma: ph.text.toLowerCase(), ko: ph.ko });
    }
  }
  return pool;
}

/** 단어 하나로 "뜻 고르기" 4지선다를 만든다. 보기를 3개 못 모으면 null */
export function buildWordQuestion(word, vocab, pool, rnd = Math.random) {
  const seen = new Set([normKo(word.ko)]);
  const picks = [];
  const take = (list) => {
    for (const x of shuffle(list, rnd)) {
      if (picks.length >= 3) return;
      const k = normKo(x.ko);
      if (!k || seen.has(k)) continue;
      seen.add(k);
      picks.push(x.ko);
    }
  };
  const me = word.text.toLowerCase();
  const others = vocab.filter((x) => x.id !== word.id);
  take(others.filter((x) => x.kind === word.kind && x.pos === word.pos)); // ① 저장한 단어 중 같은 품사
  take(pool.filter((x) => x.kind === word.kind && x.pos === (word.pos ?? '') && x.lemma !== me)); // ② 기사 단어 중 같은 품사
  take(others); // ③ 저장한 다른 단어
  take(pool.filter((x) => x.lemma !== me)); // ④ 그 밖의 기사 단어
  if (picks.length < 3) return null;
  const choices = shuffle([word.ko, ...picks], rnd);
  return {
    key: word.id,
    kind: 'word',
    type: 'word',
    ref: word.id,
    tag: word.kind === 'phrase' ? '표현 뜻 고르기' : '단어 뜻 고르기',
    promptLabel: word.kind === 'phrase' ? '다음 표현의 뜻은?' : '다음 단어의 뜻은?',
    prompt: word.text,
    promptLang: 'en',
    speak: word.text,
    choices,
    choiceLang: 'ko',
    answer: choices.indexOf(word.ko),
    explain: word.sources?.[0]?.sentence ? `기사 문장: ${word.sources[0].sentence}` : word.ex ? `예문: ${word.ex}` : '',
  };
}

/** 이번 주간 퀴즈에 낼 문제를 모은다. */
async function buildWeekly(week) {
  const [vocab, results, pool, articles] = await Promise.all([getAll('words'), getAll('quizResults'), lexiconPool(), cachedArticles()]);

  // ① 그 주에 저장한 단어 (10개까지). 모자라면 그 전에 저장한 단어로 채운다.
  const thisWeek = shuffle(vocab.filter((w) => inWeek(w.createdAt, week)));
  const older = vocab.filter((w) => kstDateOf(w.createdAt) < week.start).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  const chosen = [...thisWeek, ...(thisWeek.length ? older : [])].slice(0, WEEKLY_WORDS);
  const wordQs = chosen.map((w) => buildWordQuestion(w, vocab, pool)).filter(Boolean);

  // ② 그 주에 틀린 Part 5 문제 + 같은 유형의 아직 안 푼 문제
  const part5 = results.filter((r) => r.kind === 'part5');
  const wrong = part5.filter((r) => r.everWrong && (inWeek(r.firstAnsweredAt, week) || inWeek(r.answeredAt, week)));
  const byDate = new Map(articles.map((a) => [a.date, a]));
  const p5 = [];
  for (const r of wrong) {
    const a = byDate.get(r.date);
    if (a?.toeic_part5?.[r.index]) p5.push(part5Question(a, r.index));
  }
  const wrongTypes = new Set(wrong.map((r) => r.type));
  const answered = new Set(part5.map((r) => r.id));
  for (const a of articles) {
    if (a.date < week.start || a.date > week.end) continue;
    (a.toeic_part5 ?? []).forEach((q, i) => {
      if (wrongTypes.has(q.type) && !answered.has(`${a.date}#${i}`)) p5.push(part5Question(a, i));
    });
  }
  const part5Qs = p5.slice(0, WEEKLY_PART5_MAX);

  return { questions: [...wordQs, ...part5Qs], weekWords: thisWeek.length, wrongCount: wrong.length };
}

/**
 * 주간 퀴즈 상태 (오늘 화면의 카드에 쓴다).
 * @returns {Promise<{week: object, available: boolean, done: boolean, correct: number, answered: number}>}
 */
export async function weeklyStatus(now = new Date()) {
  const week = quizWeek(kstDate(now));
  const [vocab, results] = await Promise.all([getAll('words'), getAll('quizResults')]);
  const summary = results.find((r) => r.id === `weekly#${week.id}#done`);
  const hasWords = vocab.some((w) => inWeek(w.createdAt, week));
  const hasWrong = results.some((r) => r.kind === 'part5' && r.everWrong && (inWeek(r.firstAnsweredAt, week) || inWeek(r.answeredAt, week)));
  return { week, available: hasWords || hasWrong, done: Boolean(summary), correct: summary?.correct ?? 0, answered: summary?.total ?? 0 };
}

/** #/quiz/weekly */
export async function renderWeekly(root) {
  clear(root).append(spinner('주간 퀴즈를 만드는 중…'));
  const today = kstDate();
  const week = quizWeek(today);
  const range = `${formatShortDate(week.start)}~${formatShortDate(week.end)}`;
  const { questions } = await buildWeekly(week);

  if (!questions.length) {
    const n = daysUntilSunday(today);
    return fail(root, {
      title: '이번 주간 퀴즈에 낼 문제가 없어요.',
      message: `기사에서 단어를 ⭐로 저장하거나 Part 5를 풀면, 일요일${n ? `(${n}일 뒤)` : ''}에 그 주 내용으로 퀴즈가 만들어져요.`,
    });
  }

  const prefix = `weekly#${week.id}#`;
  // 다시 풀 때는 지난 결과를 지우고 새로 기록한다.
  await tx('quizResults', 'readwrite', async (s, w) => {
    for (const key of await w(s.quizResults.getAllKeys())) if (String(key).startsWith(prefix)) s.quizResults.delete(key);
  });
  emit('quiz-changed');

  let n = 0;
  return runQuiz(root, {
    title: '주간 퀴즈',
    subtitle: `${range} · 이번 주에 저장한 단어와 틀린 문제`,
    questions,
    onAnswer: async (q, chosen, correct) => {
      const nowIso = new Date().toISOString();
      await put('quizResults', { id: `${prefix}${n}`, kind: 'weekly', week: week.id, index: n, type: q.type, ref: q.kind === 'part5' ? q.key : q.ref, chosen, correct, answeredAt: nowIso });
      n++;
      if (q.kind === 'part5') await recordPart5(q, chosen, correct, nowIso);
    },
    onDone: async (results) => {
      await put('quizResults', {
        id: `${prefix}done`,
        kind: 'weekly-summary',
        week: week.id,
        correct: results.filter((r) => r.correct).length,
        total: results.length,
        answeredAt: new Date().toISOString(),
      });
      emit('quiz-changed');
    },
    backHref: '#/today',
    backLabel: '오늘의 기사로',
    extraLinks: [{ href: '#/quiz/wrong', label: '오답 노트' }],
  });
}
