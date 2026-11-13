// popup.js — 단어 뜻 바텀시트
// 기사에서 단어를 누르면 그 문장에서의 뜻, 원형, 예문, 기사 문장을 보여 주고 ⭐로 단어장에 저장한다.

import { deleteWord, get, restoreWord, saveWord, wordId } from './db.js';
import { POS_LABEL, splitSentences, tokensToText } from './schema.js';
import { newCard } from './srs.js';
import * as tts from './tts.js';
import { emit, h, openSheet, toast } from './ui.js';
import { formatShortDate, splitAround } from './util.js';

/** 🔊 버튼. 지원하지 않는 브라우저에서는 비활성화하고 이유를 알려 준다. */
export function speakButton(getText, { label = '발음 듣기', id = 'word', cls = '' } = {}) {
  return h(
    'button',
    {
      type: 'button',
      class: `icon-btn speak-btn ${cls}`.trim(),
      'aria-label': label,
      title: tts.supported ? label : '이 브라우저는 발음 듣기를 지원하지 않아요. Chrome 또는 Safari에서 사용하세요.',
      disabled: !tts.supported,
      onclick: (e) => {
        e.stopPropagation();
        tts.speak(typeof getText === 'function' ? getText() : getText, id);
      },
    },
    '🔊',
  );
}

/**
 * ⭐ 저장 버튼. 누르면 저장/해제를 오간다.
 * @param {() => object} makeEntry saveWord에 넘길 내용
 * @param {string} id 단어장 id
 * @param {object|null} saved 이미 저장된 단어(없으면 null)
 * @param {(word: object|null) => void} [onChange]
 */
export function starButton(makeEntry, id, saved, onChange) {
  let word = saved;
  const btn = h('button', { type: 'button', class: 'star-btn' });
  const paint = () => {
    btn.classList.toggle('on', Boolean(word));
    btn.setAttribute('aria-pressed', word ? 'true' : 'false');
    btn.setAttribute('aria-label', word ? '단어장에서 빼기' : '단어장에 저장');
    btn.textContent = word ? '★ 저장됨' : '☆ 저장';
  };
  paint();
  btn.addEventListener('click', async (e) => {
    e.stopPropagation();
    btn.disabled = true;
    try {
      if (word) {
        // 확인 창으로 한 번 더 묻는 대신, 복습 기록까지 그대로 되살리는 "되돌리기"를 준다.
        const removed = await deleteWord(id);
        word = null;
        toast('단어장에서 뺐어요.', {
          actionLabel: '되돌리기',
          onAction: async () => {
            if (!removed.word) return;
            await restoreWord(removed);
            word = removed.word;
            paint();
            emit('vocab-changed');
            onChange?.(word);
          },
        });
      } else {
        const res = await saveWord(makeEntry(), newCard());
        word = res.word;
        toast(res.created ? '단어장에 저장했어요. ⭐' : '이미 단어장에 있는 단어예요.');
      }
      paint();
      emit('vocab-changed');
      onChange?.(word);
    } catch (err) {
      toast('저장하지 못했어요: ' + err.message, { kind: 'warn' });
    } finally {
      btn.disabled = false;
    }
  });
  return btn;
}

/** 문장 안의 표현을 굵게 표시한 요소 */
export function highlightIn(sentence, surface) {
  const parts = splitAround(sentence, surface);
  if (!parts) return h('span', { lang: 'en' }, sentence);
  return h('span', { lang: 'en' }, parts[0], h('mark', null, parts[1]), parts[2]);
}

/** 이미 저장된 단어인데 지금 문장이 아직 기록되지 않았다면 "이 문장도 추가" 버튼을 보여 준다. */
function addSentenceButton(word, makeEntry, onDone) {
  const entry = makeEntry();
  if (!word || !entry.source) return null;
  if (word.sources.some((s) => s.date === entry.source.date && s.sentence === entry.source.sentence)) return null;
  const btn = h(
    'button',
    {
      type: 'button',
      class: 'link-btn',
      onclick: async () => {
        try {
          await saveWord(entry, newCard());
          btn.remove();
          toast('이 문장을 단어에 추가했어요.');
          emit('vocab-changed');
          onDone?.();
        } catch (err) {
          toast('추가하지 못했어요: ' + err.message, { kind: 'warn' });
        }
      },
    },
    '＋ 이 문장도 추가',
  );
  return btn;
}

/**
 * 기사 토큰의 뜻 창을 연다.
 * @param {{article: object, pi: number, ti: number, onClose?: () => void}} args
 */
export async function openWordSheet({ article, pi, ti, onClose }) {
  const par = article.paragraphs[pi];
  const tok = par.tokens[ti];
  if (!tok?.ko) return null;

  const range = splitSentences(par.tokens).find((s) => ti >= s.start && ti < s.end) ?? { start: 0, end: par.tokens.length };
  const sentence = tokensToText(par.tokens, range.start, range.end);

  const phrase = tok.ph != null ? (par.phrases ?? []).find((p) => p.id === tok.ph) : null;
  let phraseSurface = null;
  if (phrase) {
    const idxs = par.tokens.map((t, i) => (t.ph === tok.ph ? i : -1)).filter((i) => i >= 0);
    phraseSurface = tokensToText(par.tokens, idxs[0], idxs[idxs.length - 1] + 1);
  }

  const lemma = tok.l ?? tok.t;
  const wId = wordId('word', lemma);
  const pId = phrase ? wordId('phrase', phrase.text) : null;
  const [savedWord, savedPhrase] = await Promise.all([get('words', wId).catch(() => null), pId ? get('words', pId).catch(() => null) : null]);

  const wordEntry = () => ({
    kind: 'word',
    text: lemma,
    lemma,
    pos: tok.p ?? '',
    ko: tok.ko,
    ex: tok.ex ?? '',
    source: { date: article.date, sentence, t: tok.t, ko: tok.ko },
  });
  const phraseEntry = () => ({
    kind: 'phrase',
    text: phrase.text,
    lemma: phrase.text,
    pos: '',
    ko: phrase.ko,
    ex: phrase.ex ?? '',
    source: { date: article.date, sentence, t: phraseSurface, ko: phrase.ko },
  });

  const content = h('div', { class: 'word-sheet' });

  if (phrase) {
    const extra = h('div', { class: 'ws-extra' });
    const addBtn = addSentenceButton(savedPhrase, phraseEntry);
    if (addBtn) extra.append(addBtn);
    content.append(
      h(
        'section',
        { class: 'ws-card ws-phrase' },
        h('div', { class: 'ws-label' }, '표현'),
        h(
          'div',
          { class: 'ws-head' },
          h('h2', { class: 'ws-word', lang: 'en' }, phrase.text),
          speakButton(phrase.text, { label: `${phrase.text} 발음 듣기` }),
          starButton(phraseEntry, pId, savedPhrase),
        ),
        h('p', { class: 'ws-ko' }, phrase.ko),
        phrase.ex ? h('p', { class: 'ws-ex' }, h('span', { class: 'ws-ex-label' }, '예문'), h('span', { lang: 'en' }, phrase.ex), speakButton(phrase.ex, { label: '예문 듣기', id: 'ex' })) : null,
        extra,
      ),
    );
  }

  const showLemma = lemma.toLowerCase() !== tok.t.toLowerCase();
  const extra = h('div', { class: 'ws-extra' });
  if (savedWord) {
    extra.append(h('span', { class: 'ws-saved-note' }, `단어장에 있음 · ${formatShortDate(savedWord.createdAt.slice(0, 10))} 저장`));
    const add = addSentenceButton(savedWord, wordEntry);
    if (add) extra.append(add);
  }
  content.append(
    h(
      'section',
      { class: 'ws-card ws-main' },
      phrase ? h('div', { class: 'ws-label' }, '단어') : null,
      h(
        'div',
        { class: 'ws-head' },
        h('h2', { class: 'ws-word', lang: 'en' }, tok.t),
        tok.p ? h('span', { class: 'ws-pos' }, POS_LABEL[tok.p] ?? tok.p) : null,
        speakButton(tok.t, { label: `${tok.t} 발음 듣기` }),
        starButton(wordEntry, wId, savedWord),
      ),
      h('p', { class: 'ws-ko' }, tok.ko),
      showLemma ? h('p', { class: 'ws-lemma' }, '원형: ', h('b', { lang: 'en' }, lemma), speakButton(lemma, { label: `원형 ${lemma} 발음 듣기`, cls: 'icon-btn-small' })) : null,
      tok.ex ? h('p', { class: 'ws-ex' }, h('span', { class: 'ws-ex-label' }, '예문'), h('span', { lang: 'en' }, tok.ex), speakButton(tok.ex, { label: '예문 듣기', id: 'ex' })) : null,
      extra,
    ),
    h(
      'section',
      { class: 'ws-card ws-sentence' },
      h('div', { class: 'ws-label' }, '기사 문장'),
      h('p', { class: 'ws-sent' }, highlightIn(sentence, phraseSurface ?? tok.t), speakButton(sentence, { label: '기사 문장 듣기', id: 'sentence' })),
    ),
  );

  return openSheet(content, {
    label: `${tok.t}의 뜻`,
    onClose: () => {
      if (['word', 'ex', 'sentence'].includes(tts.state().id)) tts.stop();
      onClose?.();
    },
  });
}
