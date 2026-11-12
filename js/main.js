// main.js — 앱 시작, 해시 라우터(#/today 등), 하단 탭, 안내 띠(새 버전·설치·오프라인)

import * as archive from './archive.js';
import { warmIndex } from './articles.js';
import { getAll, openDB, requestPersist } from './db.js';
import { loadPrefs, pref, setPref } from './prefs.js';
import { applyUpdate, canInstall, isIOS, isStandalone, promptInstall, registerSW, updateWaiting } from './pwa.js';
import * as quiz from './quiz.js';
import * as reader from './reader.js';
import * as review from './review.js';
import * as settings from './settings.js';
import { dueCount } from './srs.js';
import { initVoices, stop as stopSpeaking } from './tts.js';
import { clear, closeSheet, emptyState, h, on, toast } from './ui.js';
import { diffDays, kstDate, kstDateOf } from './util.js';
import * as vocab from './vocab.js';

const DATE = String.raw`(\d{4}-\d{2}-\d{2})`;
const ROUTES = [
  { re: /^#\/today$/, tab: 'today', render: (root) => reader.render(root, {}) },
  { re: new RegExp(`^#/article/${DATE}$`), tab: 'today', render: (root, m) => reader.render(root, { date: m[1] }) },
  { re: /^#\/archive$/, tab: 'today', render: (root) => archive.render(root) },
  { re: /^#\/quiz\/weekly$/, tab: 'today', render: (root) => quiz.renderWeekly(root) },
  { re: /^#\/quiz\/wrong$/, tab: 'today', render: (root) => quiz.renderWrong(root) },
  { re: new RegExp(`^#/quiz/${DATE}$`), tab: 'today', render: (root, m) => quiz.renderPart5(root, m[1]) },
  { re: /^#\/vocab$/, tab: 'vocab', render: (root) => vocab.render(root) },
  { re: /^#\/review$/, tab: 'review', render: (root) => review.render(root) },
  { re: /^#\/settings$/, tab: 'settings', render: (root) => settings.render(root) },
];

const view = document.getElementById('view');
const banners = document.getElementById('banners');
let cleanup = null;
let navId = 0;

async function route() {
  const hash = location.hash || '#/today';
  let match = null;
  const found = ROUTES.find((r) => (match = r.re.exec(hash)));
  if (!found) {
    history.replaceState(null, '', '#/today');
    return route();
  }
  const id = ++navId;
  closeSheet();
  stopSpeaking();
  try {
    cleanup?.();
  } catch (e) {
    console.error(e);
  }
  cleanup = null;

  document.querySelectorAll('#tabs a').forEach((a) => {
    if (a.dataset.tab === found.tab) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
  window.scrollTo(0, 0);

  try {
    const fn = await found.render(view, match);
    if (id !== navId) {
      // 그리는 동안 다른 화면으로 넘어갔다면, 방금 것은 바로 정리한다.
      fn?.();
      return;
    }
    cleanup = typeof fn === 'function' ? fn : null;
    view.focus({ preventScroll: true });
  } catch (e) {
    console.error(e);
    if (id !== navId) return;
    clear(view).append(
      emptyState({
        icon: '⚠️',
        title: '화면을 여는 중 문제가 생겼어요.',
        message: e?.message ?? String(e),
        action: h('button', { type: 'button', class: 'btn btn-primary', onclick: () => location.reload() }, '새로고침'),
      }),
    );
  }
}

// ── 복습 탭 배지 ─────────────────────────────────────────────────────

async function updateBadge() {
  const badge = document.getElementById('review-badge');
  if (!badge) return;
  let n = 0;
  try {
    const [words, logs] = await Promise.all([getAll('words'), getAll('reviewLogs')]);
    n = dueCount(words, logs, new Date(), pref('newPerDay'));
  } catch {
    n = 0;
  }
  badge.hidden = n === 0;
  badge.textContent = n > 99 ? '99+' : String(n);
  badge.setAttribute('aria-label', `오늘 복습할 단어 ${n}개`);
  try {
    if (n > 0) navigator.setAppBadge?.(n);
    else navigator.clearAppBadge?.();
  } catch {
    /* 앱 아이콘 배지를 지원하지 않는 기기 */
  }
}

// ── 안내 띠 ──────────────────────────────────────────────────────────

function banner(id, content, actions = []) {
  document.getElementById(id)?.remove();
  const el = h('div', { class: 'banner', id }, h('span', { class: 'banner-msg' }, content), h('span', { class: 'banner-actions' }, actions));
  banners.append(el);
  return el;
}

function showUpdateBanner() {
  const el = banner('banner-update', '새 버전이 있어요.', [
    h('button', { type: 'button', class: 'btn btn-small btn-primary', onclick: () => applyUpdate() }, '새로고침'),
    h('button', { type: 'button', class: 'btn btn-small', onclick: () => el.remove() }, '나중에'),
  ]);
}

const dismissedRecently = (key, days) => {
  const at = pref(key);
  return Boolean(at) && diffDays(kstDateOf(at), kstDate()) < days;
};

function showInstallBanners() {
  if (isStandalone()) return;
  if (isIOS() && !dismissedRecently('iosHintDismissedAt', 7)) {
    const el = banner(
      'banner-ios',
      'iPhone에서는 공유 버튼 → “홈 화면에 추가”로 설치해 주세요. 설치하지 않으면 오래 안 쓸 때 저장한 단어가 지워질 수 있어요.',
      [
        h(
          'button',
          {
            type: 'button',
            class: 'btn btn-small',
            onclick: () => {
              el.remove();
              setPref('iosHintDismissedAt', new Date().toISOString());
            },
          },
          '닫기',
        ),
      ],
    );
  }
}

function showInstallPromptBanner() {
  if (isStandalone() || !canInstall() || dismissedRecently('installHintDismissedAt', 14)) return;
  const el = banner('banner-install', '홈 화면에 추가하면 앱처럼 쓸 수 있어요.', [
    h(
      'button',
      {
        type: 'button',
        class: 'btn btn-small btn-primary',
        onclick: async () => {
          el.remove();
          if (await promptInstall()) toast('설치했어요. 홈 화면에서 열어 보세요.');
        },
      },
      '설치',
    ),
    h(
      'button',
      {
        type: 'button',
        class: 'btn btn-small',
        onclick: () => {
          el.remove();
          setPref('installHintDismissedAt', new Date().toISOString());
        },
      },
      '닫기',
    ),
  ]);
}

function paintOnline() {
  document.body.classList.toggle('offline', !navigator.onLine);
  const chip = document.getElementById('offline-chip');
  if (chip) chip.hidden = navigator.onLine;
}

// ── 시작 ─────────────────────────────────────────────────────────────

async function init() {
  warmIndex(); // 기사 목록은 저장소를 여는 동안 미리 받기 시작한다
  try {
    await openDB();
    await loadPrefs();
  } catch (e) {
    console.error(e);
    clear(view).append(
      emptyState({
        icon: '🔒',
        title: '저장소를 열 수 없어요.',
        message: `${e?.message ?? ''} 사생활 보호(시크릿) 모드에서는 단어장을 저장할 수 없어요. 일반 창에서 열어 주세요.`,
        action: h('button', { type: 'button', class: 'btn btn-primary', onclick: () => location.reload() }, '다시 시도'),
      }),
    );
    return;
  }

  requestPersist();
  initVoices();
  paintOnline();
  window.addEventListener('online', paintOnline);
  window.addEventListener('offline', paintOnline);

  on('update-available', showUpdateBanner);
  on('install-available', showInstallPromptBanner);
  on('installed', () => document.getElementById('banner-install')?.remove());
  for (const name of ['vocab-changed', 'review-changed']) on(name, updateBadge);
  on('prefs-changed', (d) => d?.key === 'newPerDay' && updateBadge());
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && updateBadge());
  setInterval(updateBadge, 5 * 60_000);

  window.addEventListener('hashchange', route);
  if (!location.hash) history.replaceState(null, '', '#/today');
  await route();

  updateBadge();
  showInstallBanners();
  showInstallPromptBanner();
  registerSW().then(() => updateWaiting() && showUpdateBanner());
}

window.addEventListener('unhandledrejection', (e) => console.error('처리되지 않은 오류:', e.reason));

init();
