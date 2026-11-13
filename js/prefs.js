// prefs.js — 사용자 설정 값. 원본은 IndexedDB(settings)에 두고, 메모리에 올려 바로 읽는다.

import { get, getAll, put } from './db.js';
import { emit } from './ui.js';

/** 설정 이름과 기본값. 여기에 있는 이름만 백업·복원된다. */
export const DEFAULTS = Object.freeze({
  ttsVoice: '', // 고른 음성(voiceURI). 비어 있으면 억양(ttsAccent)에 맞는 음성을 자동 선택
  ttsAccent: 'en-US', // 'en-US' | 'en-GB'
  ttsRate: 0.9, // 0.7 ~ 1.3
  fontSize: 'm', // 's' | 'm' | 'l'
  showTranslation: false, // 번역을 처음부터 펼쳐 둘지
  theme: 'system', // 'system' | 'light' | 'dark'
  newPerDay: 20, // 하루에 새로 배우는 단어 수
  retention: 0.9, // 목표 기억률 (FSRS request_retention)
  reviewMode: 'en-ko', // 'en-ko'(영→한) | 'ko-en'(한→영)
  haptics: true, // 밀기·길게 누르기에 짧은 진동 (지원하는 기기에서만)
  lastBackupAt: null, // 마지막으로 백업을 내보낸 시각
  iosHintDismissedAt: null, // iPhone 설치 안내를 닫은 시각
  installHintDismissedAt: null, // Android/PC 설치 안내를 닫은 시각
});

export const PREF_KEYS = Object.keys(DEFAULTS);

export const RATE_MIN = 0.7;
export const RATE_MAX = 1.3;

const state = { ...DEFAULTS };

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** 저장된 값이 이상하면 기본값으로 되돌린다. (오래된 백업·손상 대비) */
function sanitize(key, value) {
  const d = DEFAULTS[key];
  switch (key) {
    case 'ttsAccent':
      return value === 'en-GB' ? 'en-GB' : 'en-US';
    case 'ttsRate':
      return Number.isFinite(value) ? clamp(Math.round(value * 100) / 100, RATE_MIN, RATE_MAX) : d;
    case 'fontSize':
      return ['s', 'm', 'l'].includes(value) ? value : d;
    case 'theme':
      return ['system', 'light', 'dark'].includes(value) ? value : d;
    case 'newPerDay':
      return Number.isFinite(value) ? clamp(Math.round(value), 0, 100) : d;
    case 'retention':
      return Number.isFinite(value) ? clamp(Math.round(value * 100) / 100, 0.75, 0.97) : d;
    case 'reviewMode':
      return value === 'ko-en' ? 'ko-en' : 'en-ko';
    case 'showTranslation':
      return Boolean(value);
    case 'haptics':
      return value !== false;
    case 'ttsVoice':
      return typeof value === 'string' ? value : d;
    default:
      return value ?? d;
  }
}

export async function loadPrefs() {
  for (const k of PREF_KEYS) state[k] = DEFAULTS[k];
  for (const { key, value } of await getAll('settings')) {
    if (key in DEFAULTS) state[key] = sanitize(key, value);
  }
  applyAppearance();
}

export function pref(key) {
  return state[key];
}

export async function setPref(key, value) {
  if (!(key in DEFAULTS)) throw new Error(`알 수 없는 설정: ${key}`);
  const clean = sanitize(key, value);
  state[key] = clean;
  if (key === 'theme' || key === 'fontSize') applyAppearance(); // 화면에는 바로 반영하고
  await put('settings', { key, value: clean }); // 그다음 기기에 저장한다
  emit('prefs-changed', { key, value: clean });
  return clean;
}

const darkQuery = globalThis.matchMedia?.('(prefers-color-scheme: dark)');

/** 테마와 글자 크기를 화면에 적용하고, 다음 실행 때 바로 쓰도록 localStorage에도 적어 둔다. */
export function applyAppearance() {
  const root = document.documentElement;
  const dark = state.theme === 'dark' || (state.theme === 'system' && darkQuery?.matches);
  root.dataset.theme = dark ? 'dark' : 'light';
  root.dataset.font = state.fontSize;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#111715' : '#0f766e');
  try {
    localStorage.setItem('de:theme', state.theme);
    localStorage.setItem('de:font', state.fontSize);
  } catch {
    /* localStorage를 못 쓰는 환경이면 다음 실행 때 잠깐 기본 테마가 보일 뿐이다 */
  }
}

darkQuery?.addEventListener?.('change', () => {
  if (state.theme === 'system') applyAppearance();
});

// ── 앱 내부 값 ('_'로 시작, 백업에 넣지 않음) ───────────────────────────

export async function getMeta(key) {
  return (await get('settings', `_${key}`))?.value ?? null;
}

export function setMeta(key, value) {
  return put('settings', { key: `_${key}`, value });
}
