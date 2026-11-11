// tts.js — 발음 듣기 (브라우저 내장 Web Speech API)
//
// - 음성 이름을 고정하지 않는다: 설정에서 고른 음성 → en-US → en-GB → 아무 영어 음성 순.
// - 긴 글은 문장 단위로 나눠 차례로 읽는다. (Chrome이 긴 발화를 중간에 끊는 문제를 피한다)
// - 일시정지는 "지금 문장에서 멈췄다가 그 문장부터 다시"로 구현한다. (Android의 pause()가 불안정하다)
// - 한 번에 하나만 재생한다. 누가 재생 중인지는 id로 구분한다. ('article', 'para:2', 'word' …)

import { pref } from './prefs.js';
import { toast } from './ui.js';

const synth = globalThis.speechSynthesis ?? null;
const Utterance = globalThis.SpeechSynthesisUtterance ?? null;

export const supported = Boolean(synth && Utterance);

const VOICE_WAIT_MS = 2000;
const START_TIMEOUT_MS = 4000;
const MAX_CHUNK_CHARS = 180;

let voicesReady = null;
let current = null; // { id, segments, index, status, token }
let keepRef = null; // 재생 중인 발화가 메모리에서 사라지지 않게 잡아 둔다
let failNotified = false;
const listeners = new Set();

const normLang = (l) => String(l || '').replace('_', '-').toLowerCase();

/** 사용할 수 있는 영어 음성 목록 (없으면 빈 배열) */
export function englishVoices() {
  if (!supported) return [];
  return synth.getVoices().filter((v) => normLang(v.lang).startsWith('en'));
}

/** 음성 목록이 채워질 때까지 기다린다. (브라우저마다 늦게 채워진다 — 최대 2초) */
export function initVoices() {
  if (!supported) return Promise.resolve([]);
  if (voicesReady) return voicesReady;
  voicesReady = new Promise((resolve) => {
    if (synth.getVoices().length) return resolve(englishVoices());
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      synth.removeEventListener?.('voiceschanged', finish);
      resolve(englishVoices());
    };
    synth.addEventListener?.('voiceschanged', finish);
    setTimeout(finish, VOICE_WAIT_MS);
  });
  // 나중에 음성이 추가되면(Chrome의 온라인 음성 등) 다음 호출 때 다시 읽도록 한다.
  synth.addEventListener?.('voiceschanged', () => notify());
  return voicesReady;
}

/** 지금 설정에 맞는 음성. 고를 음성이 없으면 null (그래도 lang만 지정해 재생을 시도한다) */
export function pickVoice() {
  const voices = englishVoices();
  if (!voices.length) return null;
  const chosen = pref('ttsVoice');
  if (chosen) {
    const v = voices.find((x) => x.voiceURI === chosen);
    if (v) return v;
  }
  const accent = normLang(pref('ttsAccent'));
  const other = accent === 'en-us' ? 'en-gb' : 'en-us';
  const byLang = (lang) => voices.filter((v) => normLang(v.lang) === lang);
  const best = (list) => list.find((v) => v.default) ?? list.find((v) => v.localService) ?? list[0];
  return best(byLang(accent)) ?? best(byLang(other)) ?? best(voices);
}

/** 긴 문장을 쉼표·세미콜론 등에서 더 잘게 나눈다. */
export function chunkText(text, max = MAX_CHUNK_CHARS) {
  const clean = String(text).replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean ? [clean] : [];
  const parts = clean.split(/(?<=[,;:—–])\s+/);
  const out = [];
  let buf = '';
  for (const p of parts) {
    if (buf && (buf + ' ' + p).length > max) {
      out.push(buf);
      buf = p;
    } else {
      buf = buf ? buf + ' ' + p : p;
    }
  }
  if (buf) out.push(buf);
  return out;
}

/** 재생 상태. { id, status: 'idle'|'playing'|'paused', index } */
export function state() {
  return current ? { id: current.id, status: current.status, index: current.index } : { id: null, status: 'idle', index: -1 };
}

/** 상태가 바뀔 때마다 fn(state)를 부른다. 구독 해제 함수를 돌려준다. */
export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function notify() {
  const s = state();
  for (const fn of listeners) {
    try {
      fn(s);
    } catch (e) {
      console.error(e);
    }
  }
}

function highlight(seg, on) {
  seg?.el?.classList.toggle('speaking', on);
  if (on && seg?.el && seg.scroll) {
    const r = seg.el.getBoundingClientRect();
    const margin = 120;
    if (r.top < margin || r.bottom > window.innerHeight - margin) {
      const reduce = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
      seg.el.scrollIntoView({ block: 'center', behavior: reduce ? 'auto' : 'smooth' });
    }
  }
}

function fail(message) {
  stop();
  if (!failNotified) {
    failNotified = true;
    toast(message ?? '이 기기에서 음성을 재생하지 못했어요. Chrome 또는 Safari에서 열고, 기기의 음성(TTS) 설정을 확인해 주세요.', { kind: 'warn', duration: 6000 });
    setTimeout(() => (failNotified = false), 8000);
  }
}

function speakCurrent() {
  const job = current;
  if (!job || job.status !== 'playing') return;
  const seg = job.segments[job.index];
  if (!seg) {
    finish(job);
    return;
  }
  const chunks = chunkText(seg.text);
  let ci = 0;
  highlight(seg, true);

  const speakChunk = () => {
    if (current !== job || job.status !== 'playing') return;
    if (ci >= chunks.length) {
      highlight(seg, false);
      job.index++;
      notify();
      speakCurrent();
      return;
    }
    const u = new Utterance(chunks[ci]);
    const voice = pickVoice();
    if (voice) {
      u.voice = voice;
      u.lang = voice.lang.replace('_', '-');
    } else {
      u.lang = pref('ttsAccent');
    }
    u.rate = pref('ttsRate');
    u.pitch = 1;
    let started = false;
    const watchdog = setTimeout(() => {
      if (!started && current === job && job.status === 'playing' && !synth.speaking) fail();
    }, START_TIMEOUT_MS);
    u.onstart = () => {
      started = true;
      clearTimeout(watchdog);
    };
    u.onend = () => {
      clearTimeout(watchdog);
      if (current !== job || job.token !== u.__token) return;
      ci++;
      speakChunk();
    };
    u.onerror = (e) => {
      clearTimeout(watchdog);
      if (current !== job || job.token !== u.__token) return;
      if (e.error === 'interrupted' || e.error === 'canceled') return;
      fail(e.error === 'not-allowed' ? '소리를 내려면 화면의 🔊 버튼을 직접 눌러 주세요.' : undefined);
    };
    u.__token = job.token;
    keepRef = u;
    synth.speak(u);
  };
  speakChunk();
}

function finish(job) {
  if (current !== job) return;
  current = null;
  keepRef = null;
  notify();
  job.onDone?.();
}

/**
 * 문장 목록을 차례로 읽는다.
 * @param {string} id 재생 주체 ('article', 'para:0', 'word' …)
 * @param {{text: string, el?: Element, scroll?: boolean}[]} segments
 * @param {{startIndex?: number, onDone?: () => void}} [opts]
 */
export function play(id, segments, { startIndex = 0, onDone } = {}) {
  if (!supported) {
    toast('이 브라우저는 발음 듣기를 지원하지 않아요. Chrome 또는 Safari에서 사용하세요.', { kind: 'warn' });
    return;
  }
  const list = segments.filter((s) => s && s.text && s.text.trim());
  if (!list.length) return;
  hardStop();
  const job = { id, segments: list, index: Math.min(startIndex, list.length - 1), status: 'playing', token: Symbol('tts'), onDone };
  current = job;
  notify();
  // cancel() 직후 바로 speak()하면 Chrome이 새 발화를 버리는 경우가 있어 잠깐 쉰다.
  setTimeout(() => {
    if (current === job) speakCurrent();
  }, 60);
}

/** 짧은 글 하나 읽기 (단어·예문) */
export function speak(text, id = 'word') {
  play(id, [{ text }]);
}

function hardStop() {
  if (current) {
    highlight(current.segments[current.index], false);
    current.token = Symbol('stopped');
  }
  current = null;
  keepRef = null;
  if (supported) {
    try {
      synth.cancel();
    } catch {
      /* 무시 */
    }
  }
}

export function stop() {
  const had = current;
  hardStop();
  if (had) notify();
}

/** 지금 문장에서 멈춘다. resume()하면 그 문장부터 다시 읽는다. */
export function pause() {
  if (!current || current.status !== 'playing') return;
  current.status = 'paused';
  current.token = Symbol('paused');
  try {
    synth.cancel();
  } catch {
    /* 무시 */
  }
  notify();
}

export function resume() {
  if (!current || current.status !== 'paused') return;
  const job = current;
  job.status = 'playing';
  job.token = Symbol('tts');
  notify();
  setTimeout(() => {
    if (current === job) speakCurrent();
  }, 60);
}

/**
 * 버튼 하나로 재생 ↔ 일시정지를 오간다.
 * 같은 id가 재생 중이면 일시정지, 멈춰 있으면 이어서, 아니면 새로 시작.
 */
export function toggle(id, makeSegments, opts) {
  if (current?.id === id) {
    if (current.status === 'playing') pause();
    else resume();
    return;
  }
  play(id, makeSegments(), opts);
}

if (supported) {
  // 화면을 떠나면 읽기를 멈춘다. (다른 탭·앱으로 가도 계속 읽는 것을 막는다)
  globalThis.addEventListener?.('pagehide', () => hardStop());
}
