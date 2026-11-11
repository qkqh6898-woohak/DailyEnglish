// archive.js — 지난 기사 목록: 월별 묶음, 분야 필터, 읽음 표시

import { getIndex } from './articles.js';
import { getAll } from './db.js';
import { TOPIC_LABEL, TOPICS } from './schema.js';
import { clear, emptyState, go, h, spinner, toast } from './ui.js';
import { formatKoDate, formatKoMonth } from './util.js';

const view = { topic: 'all' };

export async function render(root) {
  clear(root).append(spinner('기사 목록을 불러오는 중…'));
  document.title = '지난 기사 — Daily English Reader';

  let index;
  let read = new Set();
  const listBox = h('div');
  const status = h('p', { class: 'view-sub' });

  const chips = h(
    'div',
    { class: 'chips', role: 'group', 'aria-label': '분야' },
    [['all', '전체'], ...TOPICS.map((t) => [t, TOPIC_LABEL[t]])].map(([id, label]) =>
      h(
        'button',
        {
          type: 'button',
          class: 'chip',
          dataset: { topic: id },
          onclick: () => {
            view.topic = id;
            paint();
          },
        },
        label,
      ),
    ),
  );

  function paint() {
    chips.querySelectorAll('.chip').forEach((c) => {
      const on = c.dataset.topic === view.topic;
      c.classList.toggle('on', on);
      c.setAttribute('aria-pressed', String(on));
    });
    const items = index.items.filter((it) => view.topic === 'all' || it.topic === view.topic);
    const readCount = items.filter((it) => read.has(it.date)).length;
    status.textContent = `기사 ${items.length}편 · 읽음 ${readCount}편` + (index.offline ? ' · 오프라인(저장된 목록)' : '');

    clear(listBox);
    if (!items.length) {
      listBox.append(emptyState({ icon: '📭', title: '기사가 없어요.', message: '다른 분야를 골라 보세요.' }));
      return;
    }
    const months = new Map();
    for (const it of items) {
      const ym = it.date.slice(0, 7);
      if (!months.has(ym)) months.set(ym, []);
      months.get(ym).push(it);
    }
    for (const [ym, list] of months) {
      listBox.append(
        h(
          'section',
          { class: 'month' },
          h('h2', { class: 'month-title' }, formatKoMonth(ym)),
          h(
            'ul',
            { class: 'archive-list' },
            list.map((it) =>
              h(
                'li',
                null,
                h(
                  'a',
                  { class: 'archive-item', href: `#/article/${it.date}` },
                  h(
                    'span',
                    { class: 'ai-meta' },
                    h('span', { class: 'ai-date' }, formatKoDate(it.date)),
                    h('span', { class: `badge topic-${it.topic}` }, TOPIC_LABEL[it.topic] ?? it.topic),
                    h('span', { class: 'ai-level' }, it.level),
                    read.has(it.date) ? h('span', { class: 'ai-read', title: '읽음' }, '✓ 읽음') : null,
                  ),
                  h('span', { class: 'ai-title', lang: 'en' }, it.title_en),
                  it.title_ko ? h('span', { class: 'ai-title-ko' }, it.title_ko) : null,
                ),
              ),
            ),
          ),
        ),
      );
    }
  }

  async function load(refresh) {
    try {
      [index, read] = await Promise.all([getIndex({ refresh }), getAll('readHistory').then((rows) => new Set(rows.filter((r) => r.finishedAt).map((r) => r.date)))]);
    } catch (e) {
      clear(root).append(
        emptyState({
          icon: '📡',
          title: e.message,
          action: h('button', { type: 'button', class: 'btn btn-primary', onclick: () => go('#/archive') }, '다시 시도'),
        }),
      );
      return false;
    }
    return true;
  }

  if (!(await load(true))) return () => {};

  clear(root).append(
    h(
      'div',
      { class: 'archive' },
      h(
        'header',
        { class: 'view-head' },
        h('a', { class: 'back-link', href: '#/today' }, '← 오늘의 기사로'),
        h(
          'div',
          { class: 'row between' },
          h('h1', { class: 'view-title' }, '🗂 지난 기사'),
          h(
            'button',
            {
              type: 'button',
              class: 'btn',
              onclick: async (e) => {
                e.target.disabled = true;
                if (await load(true)) {
                  paint();
                  toast(index.offline ? '오프라인이라 저장된 목록을 보여 드려요.' : '목록을 새로 받았어요.');
                }
                e.target.disabled = false;
              },
            },
            '새로고침',
          ),
        ),
        status,
      ),
      chips,
      listBox,
    ),
  );
  paint();
  return () => {};
}
