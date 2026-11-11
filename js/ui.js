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
  const el = h('div', { class: `toast toast-${kind}`, role: 'status' }, h('span', { class: 'toast-msg' }, message));
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
  while (host.children.length > 3) host.firstElementChild.remove();
  timer = setTimeout(close, actionLabel ? Math.max(duration, 5000) : duration);
  return close;
}

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
    const finish = (value) => {
      document.removeEventListener('keydown', onKey, true);
      backdrop.remove();
      unlockScroll();
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
 * 화면 아래에서 올라오는 창. 바깥을 누르거나, 아래로 밀거나, Esc를 누르면 닫힌다.
 * @returns {{close: () => void, el: HTMLElement}}
 */
export function openSheet(content, { label = '상세 정보', onClose } = {}) {
  currentSheet?.close();
  const previous = document.activeElement;
  let closed = false;

  const close = () => {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onKey);
    backdrop.remove();
    unlockScroll();
    if (currentSheet === api) currentSheet = null;
    previous?.focus?.({ preventScroll: true });
    onClose?.();
  };
  const onKey = (e) => {
    if (e.key === 'Escape' && !document.querySelector('.dialog-backdrop')) close();
  };

  const handle = h('div', { class: 'sheet-handle', 'aria-hidden': 'true' });
  const closeBtn = h('button', { class: 'sheet-close', type: 'button', 'aria-label': '닫기', onclick: close }, '✕');
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

  // 아래로 밀어서 닫기 (내용을 맨 위까지 올린 상태에서만)
  let startY = null;
  sheet.addEventListener(
    'touchstart',
    (e) => {
      startY = sheet.scrollTop <= 0 ? e.touches[0].clientY : null;
    },
    { passive: true },
  );
  sheet.addEventListener(
    'touchmove',
    (e) => {
      if (startY == null) return;
      const dy = e.touches[0].clientY - startY;
      sheet.style.transform = dy > 0 ? `translateY(${dy}px)` : '';
    },
    { passive: true },
  );
  sheet.addEventListener('touchend', (e) => {
    if (startY == null) return;
    const dy = e.changedTouches[0].clientY - startY;
    startY = null;
    if (dy > 90) close();
    else sheet.style.transform = '';
  });

  document.body.append(backdrop);
  lockScroll();
  document.addEventListener('keydown', onKey);
  sheet.focus({ preventScroll: true });

  const api = { close, el: sheet };
  currentSheet = api;
  return api;
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

/** 앱 안의 다른 화면으로 이동 */
export function go(hash) {
  if (location.hash === hash) window.dispatchEvent(new HashChangeEvent('hashchange'));
  else location.hash = hash;
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
