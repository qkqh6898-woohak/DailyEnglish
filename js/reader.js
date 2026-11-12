// reader.js — 기사 화면 ("오늘" 탭과 지난 기사 보기)
// 토큰을 <span>으로 그리고, 단어를 누르면 뜻 창을 연다. 번역 펼치기, 듣기, 핵심 표현, 퀴즈 진입, 출처, 이전/다음.

import { getArticle, getIndex, neighbors, resolveToday } from './articles.js';
import { count, getAll, markFinished, markOpened, wordId } from './db.js';
import { openWordSheet, speakButton, starButton } from './popup.js';
import { pref, setPref } from './prefs.js';
import { weeklyStatus } from './quiz.js';
import { splitSentences, tokensToText, TOPIC_LABEL } from './schema.js';
import * as tts from './tts.js';
import { clear, emit, emptyState, fill, go, h, on, spinner, toast } from './ui.js';
import { computeStreak, diffDays, formatKoDate, formatShortDate, kstDate, kstDateOf, readingMinutes } from './util.js';

const READ_DWELL_MS = 3000; // 글을 연 뒤 이 시간이 지나고 끝까지 내려야 "읽음"으로 본다
const BACKUP_REMIND_DAYS = 14;
const RATES = [0.7, 0.8, 0.9, 1.0, 1.1, 1.2, 1.3];

async function currentStreak() {
  const history = await getAll('readHistory');
  const days = history.map((r) => kstDateOf(r.finishedAt)).filter(Boolean);
  return computeStreak(days, kstDate());
}

/** 문단 하나를 그린다. 문장은 .sent, 단어는 .w 로 감싼다. */
function renderParagraph(par, pi) {
  const p = h('p', { class: 'para-en', lang: 'en' });
  const sentences = splitSentences(par.tokens);
  const phraseIds = new Map((par.phrases ?? []).map((ph) => [ph.id, wordId('phrase', ph.text)]));
  sentences.forEach((s, si) => {
    const sent = h('span', { class: 'sent', dataset: { p: pi, s: si } });
    for (let ti = s.start; ti < s.end; ti++) {
      const tok = par.tokens[ti];
      const span = h('span', { class: tok.ko ? 'tok w' : 'tok' }, tok.t);
      if (tok.ko) {
        span.dataset.p = pi;
        span.dataset.i = ti;
        span.dataset.id = wordId('word', tok.l ?? tok.t);
        if (tok.ph != null) {
          span.dataset.ph = tok.ph;
          if (phraseIds.has(tok.ph)) span.dataset.phid = phraseIds.get(tok.ph);
        }
      }
      sent.append(span);
      if (tok.sp && ti < s.end - 1) sent.append(' ');
    }
    p.append(sent);
    if (par.tokens[s.end - 1].sp && si < sentences.length - 1) p.append(' ');
  });
  return { p, sentences };
}

/**
 * 기사 화면을 그린다.
 * @param {HTMLElement} root
 * @param {{date?: string}} params date가 없으면 "오늘" 화면
 * @returns {Promise<() => void>} 화면을 떠날 때 부를 정리 함수
 */
export async function render(root, { date } = {}) {
  const isTodayView = !date;
  const cleanups = [];
  const cleanup = () => {
    tts.stop();
    for (const fn of cleanups.splice(0)) fn();
  };
  clear(root).append(spinner('기사를 불러오는 중…'));

  let article;
  let notice = null;
  try {
    if (isTodayView) {
      const r = await resolveToday();
      article = r.article;
      notice = r.notice;
    } else {
      const index = await getIndex().catch(() => null);
      article = await getArticle(date, index?.items.find((it) => it.date === date)?.path);
    }
  } catch (e) {
    clear(root).append(
      emptyState({
        icon: '📡',
        title: e.message,
        message: '한 번 열어 본 기사는 인터넷이 없어도 다시 볼 수 있어요.',
        action: h(
          'div',
          { class: 'row center' },
          h('button', { class: 'btn btn-primary', type: 'button', onclick: () => go(location.hash || '#/today') }, '다시 시도'),
          h('button', { class: 'btn', type: 'button', onclick: () => go('#/archive') }, '지난 기사'),
        ),
      }),
    );
    return cleanup;
  }

  const today = kstDate();
  const openedAt = Date.now();
  markOpened(article.date).catch(() => {});

  // ── 머리말 ────────────────────────────────────────────────────────
  const streakEl = h('span', { class: 'streak', hidden: true });
  const paintStreak = async () => {
    const n = await currentStreak().catch(() => 0);
    streakEl.hidden = n < 1;
    streakEl.textContent = `🔥 연속 ${n}일`;
  };
  paintStreak();

  const header = h(
    'header',
    { class: 'art-head' },
    h('div', { class: 'art-date-row' }, h('span', { class: 'art-date' }, formatKoDate(article.date)), streakEl),
    h(
      'div',
      { class: 'art-meta' },
      h('span', { class: `badge topic-${article.topic}` }, TOPIC_LABEL[article.topic] ?? article.topic),
      h('span', null, `${article.level} · ${article.word_count}단어 · 약 ${readingMinutes(article.word_count)}분`),
      article.sample ? h('span', { class: 'badge badge-sample', title: '앱을 만들 때 넣어 둔 예시 기사' }, '샘플') : null,
    ),
    h('h1', { class: 'art-title', lang: 'en' }, article.title.en),
    article.title.ko ? h('p', { class: 'art-title-ko' }, article.title.ko) : null,
  );

  // ── 듣기 막대 ─────────────────────────────────────────────────────
  const paragraphs = article.paragraphs.map((par, pi) => ({ par, pi, ...renderParagraph(par, pi) }));
  const sentenceSegments = (items) =>
    items.flatMap(({ par, p, sentences }) =>
      sentences.map((s, si) => ({ text: tokensToText(par.tokens, s.start, s.end), el: p.children[si], scroll: true })),
    );

  const playBtn = h('button', { class: 'btn btn-primary play-btn', type: 'button', disabled: !tts.supported });
  const stopBtn = h('button', { class: 'btn icon-only', type: 'button', 'aria-label': '듣기 정지', hidden: true, onclick: () => tts.stop() }, '⏹');
  const rateSel = h(
    'select',
    {
      class: 'rate-select',
      'aria-label': '읽는 속도',
      disabled: !tts.supported,
      onchange: (e) => setPref('ttsRate', Number(e.target.value)),
    },
    RATES.map((r) => h('option', { value: String(r), selected: Math.abs(r - pref('ttsRate')) < 0.001 }, `${r.toFixed(1)}x`)),
  );
  if (![...rateSel.options].some((o) => o.selected)) rateSel.prepend(h('option', { value: String(pref('ttsRate')), selected: true }, `${pref('ttsRate')}x`));
  playBtn.addEventListener('click', () => tts.toggle('article', () => [{ text: article.title.en }, ...sentenceSegments(paragraphs)]));
  const player = h(
    'div',
    { class: 'player' },
    playBtn,
    stopBtn,
    h('label', { class: 'rate' }, h('span', { class: 'rate-label' }, '속도'), rateSel),
    tts.supported ? null : h('p', { class: 'hint' }, '이 브라우저는 발음 듣기를 지원하지 않아요. Chrome 또는 Safari에서 사용하세요.'),
  );

  // ── 3줄 요약 ──────────────────────────────────────────────────────
  const summary =
    Array.isArray(article.summary_ko) && article.summary_ko.length
      ? h('details', { class: 'summary' }, h('summary', null, '3줄 요약 (한글)'), h('ol', null, article.summary_ko.map((s) => h('li', null, s))))
      : null;

  // ── 본문 ──────────────────────────────────────────────────────────
  const paraButtons = [];
  const paras = h(
    'section',
    { class: 'paras', 'aria-label': '기사 본문' },
    paragraphs.map(({ par, pi, p }) => {
      const ko = h('p', { class: 'para-ko', hidden: !pref('showTranslation') }, par.ko ?? '');
      const trBtn = h('button', { class: 'chip-btn', type: 'button', 'aria-expanded': String(!ko.hidden) });
      const paintTr = () => {
        trBtn.textContent = ko.hidden ? '🇰🇷 번역 보기 ▾' : '🇰🇷 번역 접기 ▴';
        trBtn.setAttribute('aria-expanded', String(!ko.hidden));
      };
      trBtn.addEventListener('click', () => {
        ko.hidden = !ko.hidden;
        paintTr();
      });
      paintTr();
      const listenBtn = h(
        'button',
        {
          class: 'chip-btn',
          type: 'button',
          disabled: !tts.supported,
          onclick: () => tts.toggle(`para:${pi}`, () => sentenceSegments([paragraphs[pi]])),
        },
        '🔊 문단 듣기',
      );
      paraButtons.push({ pi, listenBtn });
      return h('div', { class: 'para', dataset: { p: pi } }, p, h('div', { class: 'para-tools' }, listenBtn, par.ko ? trBtn : null), ko);
    }),
  );

  // 단어 누르기 (이벤트 위임: 토큰마다 리스너를 달지 않는다)
  let sheet = null;
  const clearSelection = () => paras.querySelectorAll('.sel, .ph-sel').forEach((el) => el.classList.remove('sel', 'ph-sel'));
  paras.addEventListener('click', async (e) => {
    const el = e.target.closest?.('.w');
    if (!el || !paras.contains(el)) return;
    const pi = Number(el.dataset.p);
    const ti = Number(el.dataset.i);
    clearSelection();
    el.classList.add('sel');
    if (el.dataset.ph != null) {
      paras.querySelectorAll(`.w[data-p="${pi}"][data-ph="${el.dataset.ph}"]`).forEach((x) => x !== el && x.classList.add('ph-sel'));
    }
    sheet = await openWordSheet({ article, pi, ti, onClose: clearSelection });
  });

  // 단어장에 있는 단어는 점선 밑줄로 표시
  const paintSaved = async () => {
    const saved = new Map((await getAll('words').catch(() => [])).map((w) => [w.id, w]));
    paras.querySelectorAll('.w').forEach((el) => {
      el.classList.toggle('saved', saved.has(el.dataset.id) || (el.dataset.phid != null && saved.has(el.dataset.phid)));
    });
    return saved;
  };

  // ── 핵심 표현 ─────────────────────────────────────────────────────
  const keyList = h('ul', { class: 'key-list' });
  let keySignature = null;
  const paintKeys = (saved) => {
    // 저장 상태가 달라졌을 때만 다시 그린다. (방금 누른 ⭐ 버튼의 포커스를 잃지 않도록)
    const signature = (article.key_expressions ?? []).map((k) => (saved.has(wordId('phrase', k.en)) ? '1' : '0')).join('');
    if (signature === keySignature) return;
    keySignature = signature;
    const focused = [...keyList.querySelectorAll('.star-btn')].indexOf(document.activeElement);
    clear(keyList);
    for (const k of article.key_expressions ?? []) {
      const id = wordId('phrase', k.en);
      const entry = () => ({
        kind: 'phrase',
        text: k.en,
        lemma: k.en,
        pos: '',
        ko: k.ko,
        ex: k.ex ?? '',
        source: k.ex ? { date: article.date, sentence: k.ex, t: k.en, ko: k.ko } : undefined,
      });
      keyList.append(
        h(
          'li',
          { class: 'key-item' },
          h(
            'div',
            { class: 'key-head' },
            h('b', { class: 'key-en', lang: 'en' }, k.en),
            speakButton(k.en, { label: `${k.en} 발음 듣기`, id: 'key' }),
            starButton(entry, id, saved.get(id) ?? null),
          ),
          h('p', { class: 'key-ko' }, k.ko),
          k.ex ? h('p', { class: 'key-ex' }, h('span', { lang: 'en' }, k.ex), speakButton(k.ex, { label: '예문 듣기', id: 'key' })) : null,
        ),
      );
    }
    if (focused >= 0) keyList.querySelectorAll('.star-btn')[focused]?.focus();
  };
  const repaintSaved = () => paintSaved().then(paintKeys);
  repaintSaved();
  cleanups.push(on('vocab-changed', repaintSaved));
  const keySection = (article.key_expressions ?? []).length
    ? h('section', { class: 'card' }, h('h2', { class: 'card-title' }, `💡 핵심 표현 ${article.key_expressions.length}개`), keyList)
    : null;

  // ── 토익 Part 5 ───────────────────────────────────────────────────
  const part5Card = h('section', { class: 'card quiz-card' });
  const paintPart5 = async () => {
    const total = (article.toeic_part5 ?? []).length;
    if (!total) {
      part5Card.hidden = true;
      return;
    }
    const results = (await getAll('quizResults').catch(() => [])).filter((r) => r.kind === 'part5');
    const mine = results.filter((r) => r.date === article.date);
    const correct = mine.filter((r) => r.correct).length;
    const wrongAll = results.filter((r) => !r.correct).length;
    fill(
      part5Card,
      h(
        'div',
        { class: 'quiz-card-row' },
        h(
          'div',
          null,
          h('h2', { class: 'card-title' }, `📝 토익 Part 5 (${mine.length}/${total})`),
          h('p', { class: 'card-sub' }, mine.length ? `정답 ${correct}개 · 기사 문장으로 만든 빈칸 문제` : '기사 문장으로 만든 빈칸 문제 3개'),
        ),
        h('a', { class: 'btn btn-primary', href: `#/quiz/${article.date}` }, mine.length >= total ? '다시 풀기' : mine.length ? '이어 풀기' : '풀기'),
      ),
      wrongAll ? h('a', { class: 'link-btn', href: '#/quiz/wrong' }, `오답 노트 ${wrongAll}문제 →`) : null,
    );
  };
  paintPart5();

  // ── 주간 퀴즈 (오늘 화면에서만) ────────────────────────────────────
  const weeklyCard = h('section', { class: 'card quiz-card', hidden: true });
  if (isTodayView) {
    weeklyStatus()
      .then((st) => {
        if (!st.week.opensToday && (!st.available || st.done)) return;
        weeklyCard.hidden = false;
        const range = `${formatShortDate(st.week.start)}~${formatShortDate(st.week.end)}`;
        weeklyCard.append(
          h(
            'div',
            { class: 'quiz-card-row' },
            h(
              'div',
              null,
              h('h2', { class: 'card-title' }, st.week.opensToday ? '🗓 주간 퀴즈가 열렸어요' : '🗓 지난주 주간 퀴즈'),
              h(
                'p',
                { class: 'card-sub' },
                st.done ? `${range} · 완료 ✓ (${st.correct}/${st.answered})` : st.available ? `${range} · 이번 주 단어와 틀린 문제 복습` : `${range} · 이번 주에 저장한 단어가 없어요`,
              ),
            ),
            st.available ? h('a', { class: 'btn btn-primary', href: '#/quiz/weekly' }, st.done ? '다시 풀기' : '풀기') : null,
          ),
        );
      })
      .catch(() => {});
  }

  // ── 출처 ──────────────────────────────────────────────────────────
  const sources = h(
    'section',
    { class: 'card sources' },
    h('h2', { class: 'card-title' }, '🔗 출처'),
    h(
      'ul',
      null,
      (article.sources ?? []).map((s) =>
        h('li', null, typeof s.url === 'string' && s.url.startsWith('https://') ? h('a', { href: s.url, target: '_blank', rel: 'noopener noreferrer' }, s.name) : s.name),
      ),
    ),
    h('p', { class: 'hint' }, '이 글은 위 출처의 사실을 바탕으로 AI가 학습용으로 새로 쓴 글이에요. 정확한 내용은 원문을 확인하세요.'),
  );

  // ── 이전/다음 ─────────────────────────────────────────────────────
  const nav = h('nav', { class: 'art-nav', 'aria-label': '기사 이동' });
  neighbors(article.date)
    .then(({ older, newer }) => {
      const link = (it, label) =>
        it ? h('a', { class: 'btn', href: `#/article/${it.date}`, title: it.title_en }, label) : h('span', { class: 'btn disabled', 'aria-disabled': 'true' }, label);
      nav.append(link(older, '◀ 이전 글'), h('a', { class: 'btn', href: '#/archive' }, '지난 기사'), link(newer, '다음 글 ▶'));
    })
    .catch(() => nav.append(h('a', { class: 'btn', href: '#/archive' }, '지난 기사')));

  // ── 조립 ──────────────────────────────────────────────────────────
  const sentinel = h('div', { class: 'read-sentinel', 'aria-hidden': 'true' });
  const top = h('div', { class: 'notices' });
  if (notice) top.append(h('p', { class: 'notice' }, notice));
  if (!isTodayView && article.date !== today) {
    top.append(h('p', { class: 'notice notice-plain' }, h('a', { href: '#/today' }, '← 오늘의 기사로')));
  }
  const reminder = isTodayView ? await backupReminder() : null; // 그리기 전에 넣어야 화면이 밀리지 않는다
  if (reminder) top.append(reminder);

  clear(root).append(h('article', { class: 'article', dataset: { date: article.date } }, top, header, player, summary, paras, keySection, part5Card, weeklyCard, sources, sentinel, nav));
  document.title = `${article.title.en} — Daily English Reader`;

  // ── 듣기 상태 반영 ────────────────────────────────────────────────
  const paintPlayer = (s) => {
    const mine = s.id === 'article';
    playBtn.textContent = mine && s.status === 'playing' ? '⏸ 일시정지' : mine && s.status === 'paused' ? '▶ 이어 듣기' : '🔊 전체 듣기';
    stopBtn.hidden = !(s.status !== 'idle' && (mine || String(s.id).startsWith('para:')));
    for (const { pi, listenBtn } of paraButtons) {
      const me = s.id === `para:${pi}`;
      listenBtn.textContent = me && s.status === 'playing' ? '⏸ 멈춤' : me && s.status === 'paused' ? '▶ 이어 듣기' : '🔊 문단 듣기';
    }
  };
  paintPlayer(tts.state());
  cleanups.push(tts.subscribe(paintPlayer));

  // ── 읽음 처리: 끝까지 내려가면 기록하고 연속 학습일을 갱신한다 ──────
  let finished = false;
  let dwellTimer = null;
  const finish = async () => {
    if (finished) return;
    finished = true;
    observer?.disconnect();
    const isNew = await markFinished(article.date).catch(() => false);
    if (!isNew) return;
    await paintStreak();
    const n = await currentStreak().catch(() => 0);
    toast(n > 1 ? `다 읽었어요! 🔥 연속 ${n}일` : '다 읽었어요! 👏');
    emit('read-changed');
  };
  const observer =
    'IntersectionObserver' in window
      ? new IntersectionObserver((entries) => {
          if (!entries.some((en) => en.isIntersecting)) {
            clearTimeout(dwellTimer);
            return;
          }
          const wait = READ_DWELL_MS - (Date.now() - openedAt);
          clearTimeout(dwellTimer);
          if (wait <= 0) finish();
          else dwellTimer = setTimeout(finish, wait);
        })
      : null;
  observer?.observe(sentinel);
  cleanups.push(() => {
    observer?.disconnect();
    clearTimeout(dwellTimer);
    sheet?.close();
  });

  return cleanup;
}

/** 백업한 지 오래됐으면(14일) 오늘 화면 위에 안내를 띄운다. 단어장이 비어 있으면 띄우지 않는다. */
async function backupReminder() {
  try {
    const words = await count('words');
    if (!words) return null;
    const last = pref('lastBackupAt');
    const today = kstDate();
    let since;
    if (last) since = diffDays(kstDateOf(last), today);
    else {
      const first = (await getAll('words')).map((w) => w.createdAt).sort()[0];
      since = first ? diffDays(kstDateOf(first), today) : 0;
    }
    if (since < BACKUP_REMIND_DAYS) return null;
    return h(
      'p',
      { class: 'notice notice-warn' },
      last ? `마지막 백업이 ${since}일 전이에요. ` : `단어장을 아직 한 번도 백업하지 않았어요. `,
      h('a', { href: '#/settings' }, '설정에서 백업하기 →'),
    );
  } catch {
    return null;
  }
}
