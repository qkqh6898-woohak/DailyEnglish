// gesture.js — 터치 제스처: 좌우 밀기, 당겨서 새로고침, 길게 누르기, 진동 피드백
//
// 원칙
//   · 세로 스크롤이 항상 우선이다. 손가락이 10px쯤 움직였을 때 방향을 한 번 정하고(가로/세로),
//     세로로 정해지면 그 터치가 끝날 때까지 제스처는 아무것도 하지 않는다.
//   · 화면 양쪽 끝(24px)에서 시작한 터치는 건드리지 않는다. (iOS·Android의 "뒤로 가기" 밀기와 겹치지 않게)
//   · 입력 칸·선택 상자 위에서 시작한 터치, 글자를 선택하는 중인 터치, 창이 떠 있을 때는 무시한다.
//   · 모든 제스처에는 같은 일을 하는 버튼이 따로 있다. (마우스·키보드·보조 기기용)

import { pref } from './prefs.js';
import { overlayOpen } from './ui.js';

const EDGE = 24; // 화면 끝에서 이 안쪽으로 시작한 터치는 시스템 제스처에 양보한다
const SLOP = 10; // 방향을 정하기 전까지 무시하는 움직임
const NO_GESTURE = 'input, textarea, select, [contenteditable], .no-swipe';

/** 짧은 진동. 지원하는 기기(주로 Android)에서만, 설정에서 켜 둔 경우에만 울린다. */
export function haptic(ms = 10) {
  try {
    if (pref('haptics') && typeof navigator.vibrate === 'function') navigator.vibrate(ms);
  } catch {
    /* 진동을 막아 둔 환경 */
  }
}

export const hapticsSupported = () => typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function';

const selecting = () => {
  const sel = window.getSelection?.();
  return Boolean(sel && !sel.isCollapsed);
};

/**
 * 좌우로 끄는 동작을 따라간다.
 * @param {HTMLElement} el 터치를 받을 요소 (CSS에서 touch-action: pan-y 를 주어야 세로 스크롤과 다투지 않는다)
 * @param {object} handlers
 * @param {(e: TouchEvent) => any} [handlers.start] 시작할 때. false를 돌려주면 이번 터치는 무시한다. 그 밖의 값은 ctx로 전달된다.
 * @param {(dx: number, ctx: any) => void} handlers.move 가로로 정해진 뒤 손가락이 움직일 때마다
 * @param {(r: {dx: number, vx: number, cancelled: boolean}, ctx: any) => void} handlers.end 손을 뗐을 때 (vx: px/ms)
 * @returns {() => void} 해제 함수
 */
export function dragX(el, { start, move, end }) {
  let t = null;

  const onStart = (e) => {
    if (t) {
      // 두 번째 손가락이 닿으면(확대 등) 진행 중이던 끌기를 취소한다.
      finish(e, true);
      return;
    }
    if (e.touches.length !== 1 || overlayOpen() || selecting()) return;
    const p = e.touches[0];
    if (p.clientX < EDGE || p.clientX > window.innerWidth - EDGE) return;
    if (e.target.closest?.(NO_GESTURE)) return;
    const ctx = start ? start(e) : undefined;
    if (ctx === false) return;
    t = { x: p.clientX, y: p.clientY, lastX: p.clientX, lastT: e.timeStamp, vx: 0, dx: 0, lock: null, ctx };
  };

  const onMove = (e) => {
    if (!t) return;
    const p = e.touches[0];
    const dx = p.clientX - t.x;
    const dy = p.clientY - t.y;
    if (!t.lock) {
      if (Math.abs(dx) < SLOP && Math.abs(dy) < SLOP) return;
      if (Math.abs(dx) <= Math.abs(dy) * 1.2 || selecting()) {
        t = null; // 세로로 움직였다 → 스크롤에 맡긴다
        return;
      }
      t.lock = 'x';
    }
    if (e.cancelable) e.preventDefault();
    const dt = e.timeStamp - t.lastT;
    if (dt > 0) t.vx = 0.6 * ((p.clientX - t.lastX) / dt) + 0.4 * t.vx;
    t.lastX = p.clientX;
    t.lastT = e.timeStamp;
    t.dx = dx;
    move(dx, t.ctx);
  };

  function finish(e, cancelled) {
    if (!t) return;
    const cur = t;
    t = null;
    if (cur.lock !== 'x') return;
    // 손을 뗀 뒤 한참 멈춰 있었다면 "튕기기"로 보지 않는다.
    const vx = e.timeStamp - cur.lastT > 120 ? 0 : cur.vx;
    end({ dx: cancelled ? 0 : cur.dx, vx: cancelled ? 0 : vx, cancelled }, cur.ctx);
  }
  const onEnd = (e) => finish(e, false);
  const onCancel = (e) => finish(e, true);

  el.addEventListener('touchstart', onStart, { passive: true });
  el.addEventListener('touchmove', onMove, { passive: false });
  el.addEventListener('touchend', onEnd);
  el.addEventListener('touchcancel', onCancel);
  return () => {
    el.removeEventListener('touchstart', onStart);
    el.removeEventListener('touchmove', onMove);
    el.removeEventListener('touchend', onEnd);
    el.removeEventListener('touchcancel', onCancel);
  };
}

/** 충분히 밀었는가: 거리가 기준을 넘었거나, 짧게라도 빠르게 튕겼을 때 */
export function swipeCommitted(dx, vx, threshold) {
  const dir = Math.sign(dx);
  if (!dir) return 0;
  if (Math.abs(dx) >= threshold) return dir;
  if (Math.abs(dx) >= 36 && Math.sign(vx) === dir && Math.abs(vx) > 0.45) return dir;
  return 0;
}

/** 요소를 옮긴 뒤 끝나면 알려 준다. (동작 줄이기 설정이면 바로 끝난다) */
export function animateTo(el, transform, { ms = 180, opacity } = {}) {
  return new Promise((resolve) => {
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches || !el.isConnected) {
      el.style.transform = transform;
      if (opacity != null) el.style.opacity = String(opacity);
      resolve();
      return;
    }
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      el.removeEventListener('transitionend', onEnd);
      el.style.transition = '';
      resolve();
    };
    const onEnd = (e) => e.target === el && finish();
    el.addEventListener('transitionend', onEnd);
    el.style.transition = `transform ${ms}ms cubic-bezier(0.2, 0.8, 0.2, 1), opacity ${ms}ms linear`;
    // 다음 프레임에 목표 값을 넣어야 전환이 시작된다.
    requestAnimationFrame(() => {
      el.style.transform = transform;
      if (opacity != null) el.style.opacity = String(opacity);
    });
    setTimeout(finish, ms + 120);
  });
}

// ── 당겨서 새로고침 ───────────────────────────────────────────────────

const PULL_ARM = 64; // 이만큼 당기면 손을 뗄 때 새로고침한다
const PULL_MAX = 96;

/**
 * 화면 맨 위에서 아래로 당기면 onRefresh를 부른다. 끝날 때까지 표시가 돌아간다.
 * (브라우저의 기본 당겨서 새로고침은 CSS overscroll-behavior 로 꺼 두었다)
 * @returns {() => void} 해제 함수
 */
export function pullToRefresh(el, onRefresh) {
  const icon = document.createElement('span');
  icon.className = 'ptr-icon';
  icon.textContent = '↓';
  const ind = document.createElement('div');
  ind.className = 'ptr';
  ind.setAttribute('aria-hidden', 'true');
  ind.append(icon);
  document.body.append(ind);

  let t = null;
  let busy = false;

  const place = (dist, animate) => {
    ind.classList.toggle('settling', animate);
    ind.style.transform = `translate(-50%, ${dist}px)`;
    ind.style.opacity = String(Math.min(1, dist / 40));
    icon.style.transform = `rotate(${Math.min(180, (dist / PULL_ARM) * 180)}deg)`;
  };

  const onStart = (e) => {
    t = null;
    if (busy || e.touches.length !== 1 || window.scrollY > 0 || overlayOpen() || selecting()) return;
    if (e.target.closest?.(NO_GESTURE)) return;
    t = { x: e.touches[0].clientX, y: e.touches[0].clientY, on: false, dist: 0 };
  };

  const onMove = (e) => {
    if (!t) return;
    const dx = e.touches[0].clientX - t.x;
    const dy = e.touches[0].clientY - t.y;
    if (!t.on) {
      if (Math.abs(dx) < SLOP && Math.abs(dy) < SLOP) return;
      if (dy <= 0 || Math.abs(dx) > dy || window.scrollY > 0) {
        t = null;
        return;
      }
      t.on = true;
    }
    if (e.cancelable) e.preventDefault(); // 화면이 따라 내려오거나 튕기지 않게 한다
    t.dist = Math.min(PULL_MAX, Math.max(0, dy - SLOP) * 0.5);
    const armed = t.dist >= PULL_ARM;
    if (armed !== ind.classList.contains('armed')) {
      ind.classList.toggle('armed', armed);
      if (armed) haptic(8);
    }
    place(t.dist, false);
  };

  const onEnd = async (e) => {
    if (!t) return;
    const cur = t;
    t = null;
    if (!cur.on) return;
    const armed = e.type === 'touchend' && cur.dist >= PULL_ARM;
    ind.classList.remove('armed');
    if (!armed) {
      place(0, true);
      return;
    }
    busy = true;
    ind.classList.add('busy');
    icon.textContent = '';
    icon.style.transform = '';
    place(48, true);
    ind.style.opacity = '1';
    try {
      // 너무 빨리 끝나도 표시가 깜빡이지 않도록 잠깐은 보여 준다.
      await Promise.all([onRefresh(), new Promise((r) => setTimeout(r, 450))]);
    } catch (err) {
      console.error(err);
    }
    busy = false;
    ind.classList.remove('busy');
    icon.textContent = '↓';
    place(0, true);
  };

  el.addEventListener('touchstart', onStart, { passive: true });
  el.addEventListener('touchmove', onMove, { passive: false });
  el.addEventListener('touchend', onEnd);
  el.addEventListener('touchcancel', onEnd);
  return () => {
    el.removeEventListener('touchstart', onStart);
    el.removeEventListener('touchmove', onMove);
    el.removeEventListener('touchend', onEnd);
    el.removeEventListener('touchcancel', onEnd);
    ind.remove();
  };
}

// ── 길게 누르기 ───────────────────────────────────────────────────────

const LONG_MS = 480;

/**
 * selector에 맞는 항목을 길게 누르면 fn(항목)을 부른다. 마우스 오른쪽 버튼(컨텍스트 메뉴)도 같은 일을 한다.
 * 길게 누른 뒤 손을 뗄 때 따라오는 "누르기"는 한 번 삼킨다. (메뉴가 뜨자마자 항목이 열리지 않게)
 * @returns {() => void} 해제 함수
 */
export function longPress(el, selector, fn) {
  let timer = null;
  let origin = null;
  let firedAt = 0;
  let swallow = false; // 길게 누른 손가락을 뗄 때 오는 click을 버릴지

  const fire = (item) => {
    if (Date.now() - firedAt < 700) return; // 타이머와 contextmenu가 함께 올 때 한 번만
    firedAt = Date.now();
    haptic(12);
    fn(item);
  };
  const cancel = () => {
    clearTimeout(timer);
    timer = null;
    origin = null;
  };

  const onStart = (e) => {
    cancel();
    swallow = false;
    if (e.touches.length !== 1 || overlayOpen()) return;
    const item = e.target.closest?.(selector);
    if (!item || !el.contains(item)) return;
    origin = { x: e.touches[0].clientX, y: e.touches[0].clientY };
    timer = setTimeout(() => {
      timer = null;
      swallow = true;
      fire(item);
    }, LONG_MS);
  };
  const onMove = (e) => {
    if (!origin) return;
    if (Math.abs(e.touches[0].clientX - origin.x) > SLOP || Math.abs(e.touches[0].clientY - origin.y) > SLOP) cancel();
  };
  const onContext = (e) => {
    const item = e.target.closest?.(selector);
    if (!item || !el.contains(item)) return;
    e.preventDefault();
    cancel();
    if (!overlayOpen()) fire(item);
  };
  const onClick = (e) => {
    if (!swallow) return;
    swallow = false;
    e.preventDefault();
    e.stopPropagation();
  };

  el.addEventListener('touchstart', onStart, { passive: true });
  el.addEventListener('touchmove', onMove, { passive: true });
  el.addEventListener('touchend', cancel);
  el.addEventListener('touchcancel', cancel);
  el.addEventListener('contextmenu', onContext);
  // 메뉴가 손가락 아래에 뜨면 손을 뗄 때의 click은 목록이 아니라 메뉴(바깥 영역)로 간다.
  // 그래서 목록이 아니라 문서 전체에서 한 번 삼킨다. (안 그러면 메뉴가 뜨자마자 닫힌다)
  document.addEventListener('click', onClick, true);
  return () => {
    cancel();
    el.removeEventListener('touchstart', onStart);
    el.removeEventListener('touchmove', onMove);
    el.removeEventListener('touchend', cancel);
    el.removeEventListener('touchcancel', cancel);
    el.removeEventListener('contextmenu', onContext);
    document.removeEventListener('click', onClick, true);
  };
}
