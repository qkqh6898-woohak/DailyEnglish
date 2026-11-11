// pwa.js — 설치(홈 화면에 추가)와 서비스 워커(오프라인·새 버전 알림)

import { emit } from './ui.js';

/** 홈 화면에서 앱으로 실행 중인지 */
export function isStandalone() {
  return globalThis.matchMedia?.('(display-mode: standalone)').matches || navigator.standalone === true;
}

/** iPhone·iPad인지 (iPadOS는 Mac으로 보이므로 터치 지원 여부로 구분) */
export function isIOS() {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

// ── 설치 버튼 (Android Chrome · PC Chrome/Edge) ───────────────────────

let deferredPrompt = null;

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault(); // 브라우저 기본 안내 대신 앱 안의 버튼으로 띄운다
  deferredPrompt = e;
  emit('install-available');
});

window.addEventListener('appinstalled', () => {
  deferredPrompt = null;
  emit('installed');
});

export function canInstall() {
  return Boolean(deferredPrompt);
}

/** 설치 창을 띄운다. @returns 사용자가 설치를 수락했는지 */
export async function promptInstall() {
  if (!deferredPrompt) return false;
  const p = deferredPrompt;
  deferredPrompt = null;
  p.prompt();
  const choice = await p.userChoice.catch(() => null);
  return choice?.outcome === 'accepted';
}

// ── 서비스 워커 ──────────────────────────────────────────────────────

let registration = null;
let reloadOnControllerChange = false;
let lastUpdateCheck = 0;

export function swSupported() {
  return 'serviceWorker' in navigator && (location.protocol === 'https:' || ['localhost', '127.0.0.1'].includes(location.hostname));
}

/**
 * 서비스 워커 등록. 새 버전이 받아져 대기 중이면 'update-available' 이벤트를 알린다.
 * (첫 설치 때는 알리지 않는다)
 */
export async function registerSW() {
  if (!swSupported()) return null;
  try {
    registration = (await navigator.serviceWorker.register('sw.js')) ?? null;
  } catch (e) {
    console.warn('서비스 워커 등록 실패:', e);
    registration = null;
  }
  if (!registration) return null; // 서비스 워커가 막힌 환경: 오프라인 기능 없이 그대로 쓴다
  const announce = () => {
    if (registration.waiting && navigator.serviceWorker.controller) emit('update-available');
  };
  announce();
  registration.addEventListener('updatefound', () => {
    const worker = registration.installing;
    worker?.addEventListener('statechange', () => {
      if (worker.state === 'installed') announce();
    });
  });
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!reloadOnControllerChange) return; // 첫 설치 때의 제어권 변경에는 새로고침하지 않는다
    reloadOnControllerChange = false;
    location.reload();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') checkForUpdate();
  });
  return registration;
}

/** 대기 중인 새 버전이 있는지 */
export function updateWaiting() {
  return Boolean(registration?.waiting && navigator.serviceWorker.controller);
}

/** 대기 중인 새 버전을 적용하고 새로고침한다. */
export function applyUpdate() {
  if (!registration?.waiting) {
    location.reload();
    return;
  }
  reloadOnControllerChange = true;
  registration.waiting.postMessage({ type: 'SKIP_WAITING' });
  // 혹시 제어권 변경 이벤트가 오지 않아도 화면이 멈추지 않게 한다.
  setTimeout(() => location.reload(), 4000);
}

/** 새 버전이 있는지 서버에 물어본다. (한 시간에 한 번까지만, force면 바로) */
export async function checkForUpdate({ force = false } = {}) {
  if (!registration) return false;
  if (!force && Date.now() - lastUpdateCheck < 3_600_000) return updateWaiting();
  lastUpdateCheck = Date.now();
  try {
    await registration.update();
    // 새 버전을 찾았다면 내려받아 설치를 마칠 때까지 기다린다. (그래야 "대기 중"으로 보인다)
    const worker = registration.installing;
    if (worker) {
      await new Promise((resolve) => {
        const check = () => ['installed', 'activated', 'redundant'].includes(worker.state) && resolve();
        worker.addEventListener('statechange', check);
        check();
        setTimeout(resolve, 15_000);
      });
    }
  } catch {
    /* 오프라인이면 실패한다 */
  }
  return updateWaiting();
}

/** 지금 동작 중인 서비스 워커의 캐시 버전 (없으면 null) */
export function swVersion() {
  return new Promise((resolve) => {
    const ctrl = navigator.serviceWorker?.controller;
    if (!ctrl) return resolve(null);
    const ch = new MessageChannel();
    const timer = setTimeout(() => resolve(null), 1500);
    ch.port1.onmessage = (e) => {
      clearTimeout(timer);
      resolve(e.data?.version ?? null);
    };
    ctrl.postMessage({ type: 'GET_VERSION' }, [ch.port2]);
  });
}
