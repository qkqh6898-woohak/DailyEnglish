// vocab.js — 단어장 화면: 검색·정렬·필터, 상세(예문·기사 문장·복습 정보), 뜻 수정, 삭제, 직접 추가

import { deleteWord, get, getAll, saveWord, updateWord, wordId } from './db.js';
import { highlightIn, speakButton } from './popup.js';
import { POS, POS_LABEL } from './schema.js';
import { cardStatus, isHard, newCard, State, STATUS_LABEL } from './srs.js';
import { clear, confirmDialog, emit, emptyState, h, on, openSheet, toast } from './ui.js';
import { formatDueDay, formatKoDate, formatShortDate, kstDate, kstDateOf } from './util.js';

const PAGE = 100;

// 화면을 오가도 검색어·정렬·필터를 기억한다. (앱을 닫으면 초기화)
const view = { query: '', sort: 'recent', filter: 'all', shown: PAGE };

const FILTERS = [
  { id: 'all', label: '전체', test: () => true },
  { id: 'word', label: '단어', test: (w) => w.kind === 'word' },
  { id: 'phrase', label: '구', test: (w) => w.kind === 'phrase' },
  { id: 'hard', label: '어려운 단어', test: (w) => isHard(w.card) },
];

const SORTS = {
  recent: { label: '최근 저장순', fn: (a, b) => String(b.createdAt).localeCompare(String(a.createdAt)) },
  due: {
    label: '복습 임박순',
    fn: (a, b) => {
      const an = a.card.state === State.New;
      const bn = b.card.state === State.New;
      if (an !== bn) return an ? 1 : -1; // 아직 시작하지 않은 새 단어는 뒤로
      return an ? String(a.createdAt).localeCompare(String(b.createdAt)) : Date.parse(a.card.due) - Date.parse(b.card.due);
    },
  },
  alpha: { label: '알파벳순', fn: (a, b) => a.text.localeCompare(b.text, 'en', { sensitivity: 'base' }) },
};

function matches(w, q) {
  if (!q) return true;
  return (
    w.text.toLowerCase().includes(q) ||
    String(w.lemma ?? '').toLowerCase().includes(q) ||
    w.ko.toLowerCase().includes(q) ||
    (w.sources ?? []).some((s) => String(s.t ?? '').toLowerCase().includes(q))
  );
}

function dueText(w, today) {
  if (w.card.state === State.New) return '아직 복습 전';
  return `다음 복습 ${formatDueDay(kstDateOf(w.card.due), today)}`;
}

export async function render(root) {
  let words = [];
  const today = kstDate();

  const sub = h('p', { class: 'view-sub' });
  const list = h('ul', { class: 'vocab-list' });
  const more = h('button', { type: 'button', class: 'btn btn-wide', hidden: true }, '더 보기');
  const empty = h('div');

  const search = h('input', {
    type: 'search',
    class: 'input',
    placeholder: '단어·뜻 검색',
    'aria-label': '단어장 검색',
    value: view.query,
    autocomplete: 'off',
    autocapitalize: 'off',
    spellcheck: false,
    oninput: (e) => {
      view.query = e.target.value;
      view.shown = PAGE;
      paint();
    },
  });

  const chips = h(
    'div',
    { class: 'chips', role: 'group', 'aria-label': '필터' },
    FILTERS.map((f) =>
      h(
        'button',
        {
          type: 'button',
          class: 'chip',
          dataset: { filter: f.id },
          onclick: () => {
            view.filter = f.id;
            view.shown = PAGE;
            paint();
          },
        },
        f.label,
      ),
    ),
  );

  const sortSel = h(
    'select',
    {
      class: 'select',
      'aria-label': '정렬',
      onchange: (e) => {
        view.sort = e.target.value;
        paint();
      },
    },
    Object.entries(SORTS).map(([id, s]) => h('option', { value: id, selected: id === view.sort }, s.label)),
  );

  function paint() {
    const nWords = words.filter((w) => w.kind === 'word').length;
    sub.textContent = words.length ? `단어 ${nWords}개 · 구 ${words.length - nWords}개` : '';
    chips.querySelectorAll('.chip').forEach((c) => {
      const on = c.dataset.filter === view.filter;
      c.classList.toggle('on', on);
      c.setAttribute('aria-pressed', String(on));
    });

    const q = view.query.trim().toLowerCase();
    const filter = FILTERS.find((f) => f.id === view.filter) ?? FILTERS[0];
    const rows = words.filter((w) => filter.test(w) && matches(w, q)).sort(SORTS[view.sort].fn);

    clear(list);
    clear(empty);
    if (!words.length) {
      empty.append(
        emptyState({
          icon: '⭐',
          title: '아직 저장한 단어가 없어요.',
          message: '기사에서 모르는 단어를 누르고 ⭐ 저장을 눌러 보세요.',
          action: h('a', { class: 'btn btn-primary', href: '#/today' }, '오늘의 기사 읽기'),
        }),
      );
    } else if (!rows.length) {
      empty.append(emptyState({ icon: '🔍', title: '조건에 맞는 단어가 없어요.', message: '검색어나 필터를 바꿔 보세요.' }));
    }

    for (const w of rows.slice(0, view.shown)) {
      const status = cardStatus(w.card);
      list.append(
        h(
          'li',
          null,
          h(
            'button',
            { type: 'button', class: 'vocab-item', dataset: { id: w.id }, onclick: () => openDetail(w.id) },
            h(
              'span',
              { class: 'vi-main' },
              h('span', { class: 'vi-word', lang: 'en' }, w.text),
              w.kind === 'phrase' ? h('span', { class: 'vi-pos' }, '구') : w.pos ? h('span', { class: 'vi-pos' }, POS_LABEL[w.pos] ?? w.pos) : null,
              h('span', { class: `vi-status st-${status}` }, STATUS_LABEL[status]),
            ),
            h('span', { class: 'vi-ko' }, w.ko),
            h('span', { class: 'vi-meta' }, `저장 ${formatShortDate(kstDateOf(w.createdAt) ?? today)} · ${dueText(w, today)}`),
          ),
        ),
      );
    }
    more.hidden = rows.length <= view.shown;
    more.textContent = `더 보기 (${rows.length - view.shown}개 남음)`;
  }

  more.addEventListener('click', () => {
    view.shown += PAGE;
    paint();
  });

  async function reload() {
    words = await getAll('words');
    paint();
  }

  // ── 상세 ──────────────────────────────────────────────────────────
  async function openDetail(id) {
    const w = await get('words', id);
    if (!w) return;
    const status = cardStatus(w.card);
    const body = h('div', { class: 'word-sheet' });

    const koView = h('p', { class: 'ws-ko' }, w.ko);
    const exView = w.ex ? h('p', { class: 'ws-ex' }, h('span', { class: 'ws-ex-label' }, '예문'), h('span', { lang: 'en' }, w.ex), speakButton(w.ex, { label: '예문 듣기', id: 'ex' })) : null;

    const editBtn = h('button', { type: 'button', class: 'link-btn' }, '✏️ 뜻·예문 수정');
    const editBox = h('form', { class: 'form', hidden: true, novalidate: true });
    const koInput = h('input', { class: 'input', type: 'text', value: w.ko, maxlength: 60, required: true, 'aria-label': '뜻' });
    const exInput = h('input', { class: 'input', type: 'text', value: w.ex ?? '', maxlength: 200, lang: 'en', 'aria-label': '예문', placeholder: '예문 (선택)' });
    editBox.append(
      h('label', { class: 'field' }, h('span', null, '뜻'), koInput),
      h('label', { class: 'field' }, h('span', null, '예문'), exInput),
      h(
        'div',
        { class: 'row' },
        h('button', { type: 'submit', class: 'btn btn-primary' }, '저장'),
        h('button', { type: 'button', class: 'btn', onclick: () => ((editBox.hidden = true), (editBtn.hidden = false)) }, '취소'),
      ),
    );
    editBtn.addEventListener('click', () => {
      editBox.hidden = false;
      editBtn.hidden = true;
      koInput.focus();
    });
    editBox.addEventListener('submit', async (e) => {
      e.preventDefault();
      const ko = koInput.value.trim();
      if (!ko) {
        toast('뜻을 입력해 주세요.', { kind: 'warn' });
        return;
      }
      await updateWord(id, { ko, ex: exInput.value.trim() });
      toast('수정했어요.');
      emit('vocab-changed');
      sheet.close();
      openDetail(id);
    });

    body.append(
      h(
        'section',
        { class: 'ws-card ws-main' },
        h(
          'div',
          { class: 'ws-head' },
          h('h2', { class: 'ws-word', lang: 'en' }, w.text),
          w.kind === 'phrase' ? h('span', { class: 'ws-pos' }, '구') : w.pos ? h('span', { class: 'ws-pos' }, POS_LABEL[w.pos] ?? w.pos) : null,
          speakButton(w.text, { label: `${w.text} 발음 듣기` }),
        ),
        koView,
        exView,
        editBtn,
        editBox,
      ),
    );

    if (w.sources?.length) {
      body.append(
        h(
          'section',
          { class: 'ws-card' },
          h('div', { class: 'ws-label' }, `기사 문장 ${w.sources.length}개`),
          w.sources.map((s) =>
            h(
              'div',
              { class: 'ws-source' },
              h('p', { class: 'ws-sent' }, highlightIn(s.sentence, s.t), speakButton(s.sentence, { label: '기사 문장 듣기', id: 'sentence' })),
              h(
                'p',
                { class: 'ws-source-meta' },
                s.ko && s.ko !== w.ko ? h('span', null, `이 문장에서의 뜻: ${s.ko} · `) : null,
                h('a', { href: `#/article/${s.date}`, onclick: () => sheet.close() }, `${formatKoDate(s.date)} 기사 보기 →`),
              ),
            ),
          ),
        ),
      );
    }

    body.append(
      h(
        'section',
        { class: 'ws-card' },
        h('div', { class: 'ws-label' }, '복습 정보'),
        h(
          'dl',
          { class: 'facts' },
          h('dt', null, '상태'),
          h('dd', null, h('span', { class: `vi-status st-${status}` }, STATUS_LABEL[status])),
          h('dt', null, '다음 복습'),
          h('dd', null, w.card.state === State.New ? '복습 탭에서 시작해요' : formatDueDay(kstDateOf(w.card.due), today)),
          h('dt', null, '복습 횟수'),
          h('dd', null, `${w.card.reps}회 (틀림 ${w.card.lapses}회)`),
          h('dt', null, '저장한 날'),
          h('dd', null, formatKoDate(kstDateOf(w.createdAt) ?? today, { year: true }) + (w.custom ? ' · 직접 추가' : '')),
        ),
      ),
      h(
        'button',
        {
          type: 'button',
          class: 'btn btn-danger-outline btn-wide',
          onclick: async () => {
            const ok = await confirmDialog({
              title: '단어를 지울까요?',
              message: `“${w.text}”와 복습 기록이 함께 지워져요.`,
              confirmLabel: '지우기',
              danger: true,
            });
            if (!ok) return;
            await deleteWord(id);
            toast('단어를 지웠어요.');
            emit('vocab-changed');
            sheet.close();
          },
        },
        '단어장에서 지우기',
      ),
    );

    const sheet = openSheet(body, { label: `${w.text} 상세` });
  }

  // ── 직접 추가 ─────────────────────────────────────────────────────
  function openAdd() {
    const textInput = h('input', { class: 'input', type: 'text', maxlength: 80, required: true, lang: 'en', autocapitalize: 'off', autocomplete: 'off', spellcheck: false, placeholder: '예: bottleneck, ramp up' });
    const koInput = h('input', { class: 'input', type: 'text', maxlength: 60, required: true, placeholder: '예: 병목, 걸림돌' });
    const posSel = h('select', { class: 'select' }, h('option', { value: '' }, '선택 안 함'), POS.map((p) => h('option', { value: p }, POS_LABEL[p])));
    const exInput = h('input', { class: 'input', type: 'text', maxlength: 200, lang: 'en', placeholder: '예문 (선택)' });
    const form = h(
      'form',
      { class: 'form', novalidate: true },
      h('h2', { class: 'sheet-title' }, '단어 직접 추가'),
      h('label', { class: 'field' }, h('span', null, '단어 또는 표현'), textInput),
      h('label', { class: 'field' }, h('span', null, '뜻'), koInput),
      h('label', { class: 'field' }, h('span', null, '품사'), posSel),
      h('label', { class: 'field' }, h('span', null, '예문'), exInput),
      h('p', { class: 'hint' }, '띄어쓰기가 있으면 “구”로 저장돼요.'),
      h('button', { type: 'submit', class: 'btn btn-primary btn-wide' }, '저장'),
    );
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const text = textInput.value.trim().replace(/\s+/g, ' ');
      const ko = koInput.value.trim();
      if (!text || !ko) {
        toast('단어와 뜻을 모두 입력해 주세요.', { kind: 'warn' });
        (text ? koInput : textInput).focus();
        return;
      }
      const kind = text.includes(' ') ? 'phrase' : 'word';
      const id = wordId(kind, text);
      try {
        const res = await saveWord({ kind, text, lemma: text, pos: kind === 'word' ? posSel.value : '', ko, ex: exInput.value.trim(), custom: true }, newCard());
        sheet.close();
        emit('vocab-changed');
        if (res.created) toast('단어장에 추가했어요. ⭐');
        else {
          toast('이미 단어장에 있는 단어예요.');
          openDetail(id);
        }
      } catch (err) {
        toast('저장하지 못했어요: ' + err.message, { kind: 'warn' });
      }
    });
    const sheet = openSheet(form, { label: '단어 직접 추가' });
    textInput.focus();
  }

  clear(root).append(
    h(
      'div',
      { class: 'vocab' },
      h('header', { class: 'view-head' }, h('h1', { class: 'view-title' }, '📚 단어장'), sub),
      h('div', { class: 'vocab-tools' }, search, h('button', { type: 'button', class: 'btn btn-primary', onclick: openAdd }, '＋ 직접 추가')),
      h('div', { class: 'vocab-filters' }, chips, sortSel),
      empty,
      list,
      more,
    ),
  );
  document.title = '단어장 — Daily English Reader';

  await reload();
  return on('vocab-changed', reload);
}
