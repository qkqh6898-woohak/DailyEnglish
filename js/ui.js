// ui.js — 화면 공통 요소: DOM 만들기, 토스트, 확인 창, 바텀시트, 파일 내려받기

/**
 * DOM 요소를 만든다.
 *   h('button', { class: 'btn', onclick: fn, dataset: { id: 1 } }, '저장')
 * 값이 null/undefined/false인 속성과 자식은 건너뛴다. 문자열은 항상 텍스트로 넣는다(HTML로 해석하지 않음).
 */
export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (k in el && typeof v !== 'string') el[k] = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children) {
    if (c == null || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export function clear(el) {
  el.replaceChildren();
  return el;
}

/**
 * 요소의 내용을 비우고 새 자식들로 채운다. null·false인 자식은 건너뛴다.
 * (기본 append()는 null을 "null"이라는 글자로 넣어 버리므로, 없을 수도 있는 자식이 있으면 이 함수를 쓴다)
 */
export function fill(el, ...children) {
  el.replaceChildren();
  append(el, children);
  return el;
}

// ── 토스트 ───────────────────────────────────────────────────────────

/** 화면 아래에 잠깐 뜨는 안내. actionLabel을 주면 버튼이 함께 나온다. */
export function toast(message, { actionLabel, onAction, duration = 3200, kind = 'info' } = {}) {
  const host = document.getElementById('toasts');
  if (!host) return () => {};
  // 같은 안내가 이미 떠 있으면 겹쳐 쌓지 않고 새것으로 바꾼다.
  for (const old of [...host.children]) if (old.dataset.msg === message) old.remove();
  const el = h('div', { class: `toast toast-${kind}`, role: 'status', dataset: { msg: message } }, h('span', { class: 'toast-msg' }, message));
  let timer;
  const close = () => {
    clearTimeout(timer);
    el.remove();
  };
  if (actionLabel) {
    el.append(
      h(
        'button',
        {
          class: 'toast-action',
          type: 'button',
          onclick: () => {
            close();
            onAction?.();
          },
        },
        actionLabel,
      ),
    );
  }
  host.append(el);
  while (host.children.length > 2) host.firstElementChild.remove();
  timer = setTimeout(close, actionLabel ? Math.max(duration, 5000) : duration);
  return close;
}

// ── 겹쳐 뜨는 창과 뒤로 가기 ─────────────────────────────────────────
// 바텀시트·확인 창이 열릴 때 방문 기록을 한 칸 쌓아 둔다. 그러면 Android의 뒤로 가기 버튼이나
// iOS의 가장자리 밀기가 화면을 떠나지 않고 창만 닫는다. (창을 직접 닫으면 쌓은 칸을 되돌린다)

const overlays = [];
const hasWindow = typeof window !== 'undefined';
const historyDepth = () => history.state?.overlay ?? 0;
let rewinding = false; // 우리가 부른 "뒤로"가 끝나기를 기다리는 중
let rewindTimer = null;

/**
 * 방문 기록에 쌓인 칸 수를 열려 있는 창 수에 맞춘다.
 * "뒤로"는 바로 끝나지 않으므로, 끝나기 전에는 새 칸을 쌓지 않고 끝난 뒤에 다시 맞춘다.
 * (창을 닫자마자 다른 창을 여는 경우에 순서가 엇갈려 새 창이 닫히는 일을 막는다)
 */
function syncHistory() {
  if (!hasWindow || rewinding) return;
  const have = historyDepth();
  const want = overlays.length;
  try {
    if (have > want) {
      rewinding = true;
      rewindTimer = setTimeout(() => {
        rewinding = false;
        syncHistory();
      }, 700);
      history.go(want - have);
    } else {
      for (let d = have + 1; d <= want; d++) history.pushState({ ...(history.state ?? {}), overlay: d }, '');
    }
  } catch {
    /* 방문 기록을 쓸 수 없는 환경이면 뒤로 가기 연동만 빠진다 */
  }
}

function pushOverlay(close) {
  const entry = { close };
  overlays.push(entry);
  syncHistory();
  /** 창을 직접 닫았을 때 부른다. */
  return () => {
    const i = overlays.indexOf(entry);
    if (i < 0) return;
    overlays.splice(i, 1);
    syncHistory();
  };
}

if (hasWindow) {
  window.addEventListener('popstate', () => {
    if (rewinding) {
      // 우리가 부른 "뒤로"가 끝났다. 그 사이에 열린 창이 있으면 이제 칸을 쌓는다.
      rewinding = false;
      clearTimeout(rewindTimer);
      syncHistory();
      return;
    }
    // 사용자가 뒤로 가기를 눌렀다 → 그만큼 창을 닫는다.
    const depth = historyDepth();
    while (overlays.length > depth) overlays.pop().close();
  });

  // 창 안의 앱 링크(#/…)를 누르면: 창을 닫아 방문 기록을 되돌린 "다음에" 이동한다.
  // (순서가 바뀌면 되돌리기가 새 화면을 다시 이전 화면으로 돌려 버린다)
  document.addEventListener(
    'click',
    (e) => {
      if ((!overlays.length && !rewinding) || e.defaultPrevented || e.button > 0 || e.metaKey || e.ctrlKey || e.shiftKey) return;
      const a = e.target.closest?.('a[href^="#/"]');
      if (!a || a.target === '_blank') return;
      e.preventDefault();
      closeOverlaysThen(() => go(a.getAttribute('href')));
    },
    true,
  );
}

/** 방문 기록 정리("뒤로")가 진행 중이면 끝난 뒤에, 아니면 바로 fn을 부른다. */
function whenSettled(fn) {
  if (!rewinding) return fn();
  let done = false;
  const run = () => {
    if (done) return;
    done = true;
    window.removeEventListener('popstate', check);
    fn();
  };
  const check = () => !rewinding && run();
  window.addEventListener('popstate', check);
  setTimeout(run, 800);
}

/**
 * 열려 있는 창을 모두 닫고, 방문 기록 정리가 끝난 뒤 fn을 부른다.
 * 닫은 자리에 곧바로 다른 창을 띄울 때는 instant를 주어, 내려가는 창과 올라오는 창이 겹쳐 보이지 않게 한다.
 */
export function closeOverlaysThen(fn, { instant = false } = {}) {
  for (const o of [...overlays].reverse()) o.close({ instant });
  whenSettled(fn);
}

/** 겹쳐 뜬 창이 있는가 (제스처가 창 뒤의 화면을 움직이지 않도록 확인할 때 쓴다) */
export const overlayOpen = () => overlays.length > 0;

const reducedMotion = () => hasWindow && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

// ── 확인 창 ──────────────────────────────────────────────────────────

let overlayDepth = 0;
const lockScroll = () => {
  if (overlayDepth++ === 0) document.body.classList.add('no-scroll');
};
const unlockScroll = () => {
  if (--overlayDepth <= 0) {
    overlayDepth = 0;
    document.body.classList.remove('no-scroll');
  }
};

/**
 * 버튼을 고르는 창. 고른 버튼의 value를 돌려준다. 바깥을 누르거나 Esc를 누르면 null.
 * @param {{title: string, message?: string|Node, buttons: {label: string, value: any, kind?: 'primary'|'danger'|'plain'}[]}} opts
 */
export function askDialog({ title, message, buttons }) {
  return new Promise((resolve) => {
    const previous = document.activeElement;
    let finished = false;
    const finish = (value) => {
      if (finished) return;
      finished = true;
      document.removeEventListener('keydown', onKey, true);
      backdrop.remove();
      unlockScroll();
      release();
      previous?.focus?.();
      resolve(value);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        finish(null);
      }
    };
    const box = h(
      'div',
      { class: 'dialog', role: 'alertdialog', 'aria-modal': 'true', 'aria-label': title },
      h('h2', { class: 'dialog-title' }, title),
      message ? h('div', { class: 'dialog-msg' }, message) : null,
      h(
        'div',
        { class: 'dialog-actions' },
        buttons.map((b) => h('button', { type: 'button', class: `btn btn-${b.kind ?? 'plain'}`, onclick: () => finish(b.value) }, b.label)),
      ),
    );
    const backdrop = h(
      'div',
      {
        class: 'dialog-backdrop',
        onclick: (e) => {
          if (e.target === backdrop) finish(null);
        },
      },
      box,
    );
    document.body.append(backdrop);
    lockScroll();
    const release = pushOverlay(() => finish(null));
    document.addEventListener('keydown', onKey, true);
    box.querySelector('.btn-primary, .btn-danger, .btn')?.focus();
  });
}

/** 예/아니오 확인 창 */
export async function confirmDialog({ title, message, confirmLabel = '확인', cancelLabel = '취소', danger = false }) {
  const v = await askDialog({
    title,
    message,
    buttons: [
      { label: cancelLabel, value: false, kind: 'plain' },
      { label: confirmLabel, value: true, kind: danger ? 'danger' : 'primary' },
    ],
  });
  return v === true;
}

// ── 바텀시트 ─────────────────────────────────────────────────────────

let currentSheet = null;

/**
 * 화면 아래에서 올라오는 창. 바깥을 누르거나, 아래로 밀거나, Esc·뒤로 가기를 누르면 닫힌다.
 * @returns {{close: (opts?: {instant?: boolean}) => boolean, el: HTMLElement}} close는 이번에 닫았으면 true
 */
export function openSheet(content, { label = '상세 정보', onClose } = {}) {
  currentSheet?.close({ instant: true });
  // 아직 내려가는 중인 이전 창이 있으면 바로 치운다. (두 창이 겹쳐 보이지 않게)
  document.querySelectorAll('.sheet-backdrop.closing').forEach((el) => el.remove());
  const previous = document.activeElement;
  let closed = false;

  const close = ({ instant = false } = {}) => {
    if (closed) return false;
    closed = true;
    document.removeEventListener('keydown', onKey);
    unlockScroll();
    if (currentSheet === api) currentSheet = null;
    release();
    // 내려가는 동작이 끝난 뒤에 지운다. (다른 창으로 바로 바뀔 때와 동작 줄이기 설정에서는 즉시)
    if (instant || reducedMotion()) backdrop.remove();
    else {
      let removed = false;
      const remove = () => {
        if (removed) return;
        removed = true;
        backdrop.remove();
      };
      backdrop.classList.add('closing');
      sheet.addEventListener('transitionend', (e) => e.target === sheet && remove());
      setTimeout(remove, 320);
    }
    previous?.focus?.({ preventScroll: true });
    onClose?.();
    return true;
  };
  const onKey = (e) => {
    if (e.key === 'Escape' && !document.querySelector('.dialog-backdrop')) close();
  };

  const handle = h('div', { class: 'sheet-handle', 'aria-hidden': 'true' });
  const closeBtn = h('button', { class: 'sheet-close', type: 'button', 'aria-label': '닫기', onclick: () => close() }, '✕');
  const sheet = h('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': label, tabindex: '-1' }, handle, closeBtn, content);
  const backdrop = h(
    'div',
    {
      class: 'sheet-backdrop',
      onclick: (e) => {
        if (e.target === backdrop) close();
      },
    },
    sheet,
  );

  // 아래로 밀어서 닫기: 손가락을 따라 내려오고, 충분히 내리거나 빠르게 튕기면 닫힌다.
  // 내용을 맨 위까지 올린 상태에서만 시작한다. (그 밖에는 창 안의 스크롤이 우선)
  let drag = null;
  sheet.addEventListener(
    'touchstart',
    (e) => {
      const ok = e.touches.length === 1 && sheet.scrollTop <= 0 && !e.target.closest?.('input, textarea, select');
      drag = ok ? { y: e.touches[0].clientY, x: e.touches[0].clientX, lastY: e.touches[0].clientY, lastT: e.timeStamp, v: 0, on: false } : null;
    },
    { passive: true },
  );
  sheet.addEventListener(
    'touchmove',
    (e) => {
      if (!drag) return;
      const p = e.touches[0];
      const dy = p.clientY - drag.y;
      if (!drag.on) {
        if (Math.abs(dy) < 8 && Math.abs(p.clientX - drag.x) < 8) return;
        if (dy <= 0 || Math.abs(p.clientX - drag.x) > dy) {
          drag = null; // 위로 올리거나 옆으로 미는 동작은 창을 움직이지 않는다
          return;
        }
        drag.on = true;
        sheet.classList.add('dragging');
      }
      const dt = e.timeStamp - drag.lastT;
      if (dt > 0) drag.v = (p.clientY - drag.lastY) / dt;
      drag.lastY = p.clientY;
      drag.lastT = e.timeStamp;
      sheet.style.transform = dy > 0 ? `translateY(${dy}px)` : '';
    },
    { passive: true },
  );
  const endDrag = (e) => {
    if (!drag) return;
    const d = drag;
    drag = null;
    if (!d.on) return;
    sheet.classList.remove('dragging');
    const dy = (e.changedTouches?.[0]?.clientY ?? d.lastY) - d.y;
    if (e.type === 'touchend' && (dy > 90 || (dy > 30 && d.v > 0.5))) close();
    else sheet.style.transform = '';
  };
  sheet.addEventListener('touchend', endDrag);
  sheet.addEventListener('touchcancel', endDrag);

  document.body.append(backdrop);
  lockScroll();
  const release = pushOverlay((opts) => close(opts));
  document.addEventListener('keydown', onKey);
  sheet.focus({ preventScroll: true });

  const api = { close, el: sheet };
  currentSheet = api;
  return api;
}

/**
 * 고를 수 있는 동작 목록 창 (길게 누르기 메뉴).
 * @param {{title: string, sub?: string, actions: {label: string, onPick: () => void, danger?: boolean, keepOpen?: boolean}[]}} opts
 *   keepOpen: 창을 닫지 않고 바로 실행한다. (발음 듣기처럼 누른 즉시 실행해야 하는 동작)
 */
export function actionSheet({ title, sub, actions }) {
  const sheet = openSheet(
    h(
      'div',
      { class: 'action-sheet' },
      h('h2', { class: 'sheet-title', lang: 'en' }, title),
      sub ? h('p', { class: 'action-sub' }, sub) : null,
      h(
        'ul',
        { class: 'action-list' },
        actions.map((a) =>
          h(
            'li',
            null,
            h(
              'button',
              {
                type: 'button',
                class: a.danger ? 'action-item danger' : 'action-item',
                onclick: () => (a.keepOpen ? a.onPick() : closeOverlaysThen(a.onPick, { instant: true })),
              },
              a.label,
            ),
          ),
        ),
      ),
    ),
    { label: `${title} 메뉴` },
  );
  return sheet;
}

export function closeSheet() {
  currentSheet?.close();
}

// ── 그 밖 ────────────────────────────────────────────────────────────

/** 글을 파일로 내려받는다. */
export function downloadText(filename, text, type = 'application/json') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = h('a', { href: url, download: filename, hidden: true });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** 사용자가 고른 파일의 글 내용을 읽는다. 고르지 않으면 null. */
export function pickTextFile(accept = 'application/json,.json') {
  return new Promise((resolve) => {
    const input = h('input', { type: 'file', accept, hidden: true });
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      input.remove();
      if (!file) return resolve(null);
      try {
        resolve({ name: file.name, text: await file.text() });
      } catch {
        resolve(null);
      }
    });
    input.addEventListener('cancel', () => {
      input.remove();
      resolve(null);
    });
    document.body.append(input);
    input.click();
  });
}

/** 화면 전체를 대신하는 안내(빈 상태·오류) */
export function emptyState({ icon = '📭', title, message, action }) {
  return h(
    'div',
    { class: 'empty' },
    h('div', { class: 'empty-icon', 'aria-hidden': 'true' }, icon),
    h('p', { class: 'empty-title' }, title),
    message ? h('p', { class: 'empty-msg' }, message) : null,
    action ?? null,
  );
}

export function spinner(label = '불러오는 중…') {
  return h('div', { class: 'loading', role: 'status' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), label);
}

let nextEnter = null;

/** 다음 화면이 들어오는 방향을 한 번 꺼내 간다. (라우터가 쓴다) */
export function takeEnter() {
  const v = nextEnter;
  nextEnter = null;
  return v;
}

/**
 * 앱 안의 다른 화면으로 이동
 * @param {string} hash
 * @param {{enter?: 'left'|'right'|'fade'}} [opts] enter: 새 화면이 들어오는 쪽 (밀어서 넘길 때)
 */
export function go(hash, { enter } = {}) {
  // 창을 닫으며 방문 기록을 되돌리는 중이면, 그것이 끝난 뒤에 이동한다.
  whenSettled(() => {
    nextEnter = enter ?? null;
    if (location.hash === hash) window.dispatchEvent(new HashChangeEvent('hashchange'));
    else location.hash = hash;
  });
}

/** 데이터가 바뀌었음을 다른 화면 요소에 알린다. (탭 배지, 저장 표시 등) */
export function emit(name, detail) {
  document.dispatchEvent(new CustomEvent(`de:${name}`, { detail }));
}

export function on(name, fn) {
  const handler = (e) => fn(e.detail);
  document.addEventListener(`de:${name}`, handler);
  return () => document.removeEventListener(`de:${name}`, handler);
}
