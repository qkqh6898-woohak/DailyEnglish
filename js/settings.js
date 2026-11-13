// settings.js — 설정 화면: 발음, 읽기, 복습, 데이터(백업·복원·삭제), 앱 정보

import { checkBackup, count, exportBackup, importBackup, storageInfo, wipeAll } from './db.js';
import { hapticsSupported } from './gesture.js';
import { loadPrefs, pref, PREF_KEYS, RATE_MAX, RATE_MIN, setPref } from './prefs.js';
import { applyUpdate, canInstall, checkForUpdate, isIOS, isStandalone, promptInstall, swSupported, swVersion } from './pwa.js';
import * as tts from './tts.js';
import { askDialog, clear, confirmDialog, downloadText, emit, go, h, on, pickTextFile, toast } from './ui.js';
import { diffDays, formatBytes, formatKoDate, kstDate, kstDateOf } from './util.js';
import { APP_NAME, APP_VERSION, REPO_URL } from './version.js';

const PREVIEW_TEXT = 'This is how your daily article will sound.';

/** 여러 값 중 하나를 고르는 버튼 묶음 */
function segmented(label, options, current, onPick) {
  const btns = options.map(([value, text]) =>
    h(
      'button',
      {
        type: 'button',
        class: 'seg',
        dataset: { value: String(value) },
        onclick: async () => {
          await onPick(value);
          paint(value);
        },
      },
      text,
    ),
  );
  const paint = (v) =>
    btns.forEach((b) => {
      const on = b.dataset.value === String(v);
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', String(on));
    });
  paint(current);
  return h('div', { class: 'segmented', role: 'group', 'aria-label': label }, btns);
}

const row = (label, control, hint) =>
  h('div', { class: 'set-row' }, h('div', { class: 'set-label' }, h('span', null, label), hint ? h('small', null, hint) : null), h('div', { class: 'set-control' }, control));

export async function render(root) {
  document.title = '설정 — Daily English Reader';
  const cleanups = [];

  // ── 발음 ──────────────────────────────────────────────────────────
  const voiceSel = h('select', { class: 'select', 'aria-label': '음성 선택', disabled: !tts.supported });
  const voiceHint = h('p', { class: 'hint' });
  const fillVoices = () => {
    const voices = tts.englishVoices();
    clear(voiceSel).append(h('option', { value: '' }, '자동 (억양에 맞게)'));
    for (const v of voices) {
      voiceSel.append(h('option', { value: v.voiceURI, selected: v.voiceURI === pref('ttsVoice') }, `${v.name} (${v.lang.replace('_', '-')})`));
    }
    if (!tts.supported) voiceHint.textContent = '이 브라우저는 발음 듣기를 지원하지 않아요. Chrome 또는 Safari에서 사용하세요.';
    else if (!voices.length) voiceHint.textContent = '이 기기에서 영어 음성 목록을 찾지 못했어요. 기기 설정의 “텍스트 음성 변환(TTS)”에서 영어 음성을 설치하면 좋아져요.';
    else voiceHint.textContent = `사용할 수 있는 영어 음성 ${voices.length}개`;
  };
  voiceSel.addEventListener('change', () => setPref('ttsVoice', voiceSel.value));
  tts.initVoices().then(fillVoices);
  cleanups.push(tts.subscribe(() => voiceSel.options.length <= 1 && fillVoices()));

  const rateOut = h('output', { class: 'range-value' }, `${pref('ttsRate').toFixed(1)}x`);
  const rateInput = h('input', {
    type: 'range',
    min: String(RATE_MIN),
    max: String(RATE_MAX),
    step: '0.1',
    value: String(pref('ttsRate')),
    'aria-label': '기본 읽기 속도',
    disabled: !tts.supported,
    oninput: (e) => (rateOut.textContent = `${Number(e.target.value).toFixed(1)}x`),
    onchange: (e) => setPref('ttsRate', Number(e.target.value)),
  });

  const speech = h(
    'section',
    { class: 'card set-card' },
    h('h2', { class: 'card-title' }, '🔊 발음'),
    row(
      '억양',
      segmented(
        '억양',
        [
          ['en-US', '미국식'],
          ['en-GB', '영국식'],
        ],
        pref('ttsAccent'),
        (v) => setPref('ttsAccent', v),
      ),
    ),
    row('음성', voiceSel),
    voiceHint,
    row('기본 속도', h('div', { class: 'range' }, rateInput, rateOut)),
    h('button', { type: 'button', class: 'btn', disabled: !tts.supported, onclick: () => tts.speak(PREVIEW_TEXT, 'preview') }, '▶ 미리 듣기'),
  );

  // ── 읽기 ──────────────────────────────────────────────────────────
  const reading = h(
    'section',
    { class: 'card set-card' },
    h('h2', { class: 'card-title' }, '📖 읽기'),
    row(
      '글자 크기',
      segmented(
        '글자 크기',
        [
          ['s', '작게'],
          ['m', '보통'],
          ['l', '크게'],
        ],
        pref('fontSize'),
        (v) => setPref('fontSize', v),
      ),
    ),
    row(
      '번역 펼쳐 두기',
      h('input', { type: 'checkbox', class: 'switch', role: 'switch', checked: pref('showTranslation'), 'aria-label': '문단 번역을 처음부터 펼쳐 두기', onchange: (e) => setPref('showTranslation', e.target.checked) }),
      '끄면 문단마다 “번역 보기”를 눌러야 보여요.',
    ),
    hapticsSupported()
      ? row(
          '진동 피드백',
          h('input', { type: 'checkbox', class: 'switch', role: 'switch', checked: pref('haptics'), 'aria-label': '밀기·길게 누르기에 짧은 진동', onchange: (e) => setPref('haptics', e.target.checked) }),
          '카드를 밀어 넘기거나 길게 누를 때 짧게 울려요.',
        )
      : null,
    row(
      '화면 테마',
      segmented(
        '화면 테마',
        [
          ['system', '시스템'],
          ['light', '라이트'],
          ['dark', '다크'],
        ],
        pref('theme'),
        (v) => setPref('theme', v),
      ),
    ),
  );

  // ── 복습 ──────────────────────────────────────────────────────────
  const review = h(
    'section',
    { class: 'card set-card' },
    h('h2', { class: 'card-title' }, '🔁 복습'),
    row(
      '하루 새 단어 수',
      h('input', {
        type: 'number',
        class: 'input input-num',
        min: '0',
        max: '100',
        step: '1',
        inputmode: 'numeric',
        value: String(pref('newPerDay')),
        'aria-label': '하루 새 단어 수',
        onchange: async (e) => {
          e.target.value = String(await setPref('newPerDay', Number(e.target.value)));
        },
      }),
      '저장한 단어를 하루에 몇 개씩 새로 시작할지 정해요.',
    ),
    row(
      '목표 기억률',
      h(
        'select',
        { class: 'select', 'aria-label': '목표 기억률', onchange: (e) => setPref('retention', Number(e.target.value)) },
        [0.8, 0.85, 0.9, 0.93, 0.95].map((r) => h('option', { value: String(r), selected: Math.abs(r - pref('retention')) < 0.001 }, `${Math.round(r * 100)}%${r === 0.9 ? ' (기본)' : ''}`)),
      ),
      '높을수록 더 자주 복습해요.',
    ),
  );

  // ── 데이터 ────────────────────────────────────────────────────────
  const stats = h('p', { class: 'set-stats' });
  const backupInfo = h('p', { class: 'hint' });
  const storage = h('p', { class: 'hint' });
  const paintData = async () => {
    const [words, logs, quizzes, reads, info] = await Promise.all([count('words'), count('reviewLogs'), count('quizResults'), count('readHistory'), storageInfo()]);
    stats.textContent = `단어 ${words}개 · 복습 기록 ${logs}건 · 퀴즈 기록 ${quizzes}건 · 열어 본 기사 ${reads}편`;
    const last = pref('lastBackupAt');
    backupInfo.textContent = last ? `마지막 백업: ${formatKoDate(kstDateOf(last), { year: true })} (${diffDays(kstDateOf(last), kstDate())}일 전)` : '마지막 백업: 아직 없음';
    const parts = [];
    if (info.usage != null) parts.push(`사용 중인 저장 공간 ${formatBytes(info.usage)}`);
    if (info.persisted === true) parts.push('브라우저가 데이터를 지우지 않도록 보호 중');
    else if (info.persisted === false) parts.push('데이터 보호가 아직 켜지지 않았어요(홈 화면에 설치하면 켜지기 쉬워요)');
    storage.textContent = parts.join(' · ');
  };

  const doExport = async () => {
    try {
      const nowIso = new Date().toISOString();
      const data = await exportBackup(PREF_KEYS, nowIso);
      downloadText(`DEReader-backup-${kstDate()}.json`, JSON.stringify(data, null, 2));
      await setPref('lastBackupAt', nowIso);
      toast(`백업 파일을 내려받았어요. (단어 ${data.words.length}개)`);
      paintData();
    } catch (e) {
      toast('백업하지 못했어요: ' + e.message, { kind: 'warn' });
    }
  };

  const doImport = async () => {
    const file = await pickTextFile();
    if (!file) return;
    let data;
    try {
      data = checkBackup(JSON.parse(file.text));
    } catch (e) {
      toast(e instanceof SyntaxError ? '백업 파일을 읽지 못했어요. JSON 형식이 아니에요.' : e.message, { kind: 'warn', duration: 5000 });
      return;
    }
    const mode = await askDialog({
      title: '백업을 어떻게 가져올까요?',
      message: h(
        'div',
        null,
        h('p', null, `${file.name} — 단어 ${data.words.length}개, 복습 기록 ${data.reviewLogs.length}건` + (data.exported_at ? ` (${formatKoDate(kstDateOf(data.exported_at), { year: true })} 백업)` : '')),
        h('p', null, h('b', null, '합치기'), ': 지금 데이터에 더해요. 같은 단어는 더 최근에 바뀐 쪽을 남겨요.'),
        h('p', null, h('b', null, '덮어쓰기'), ': 지금 데이터를 지우고 백업으로 바꿔요.'),
      ),
      buttons: [
        { label: '취소', value: null, kind: 'plain' },
        { label: '덮어쓰기', value: 'replace', kind: 'danger' },
        { label: '합치기', value: 'merge', kind: 'primary' },
      ],
    });
    if (!mode) return;
    try {
      const result = await importBackup(data, mode, PREF_KEYS);
      await loadPrefs();
      emit('vocab-changed');
      emit('review-changed');
      emit('quiz-changed');
      toast(`가져왔어요. 지금 단어 ${result.words}개, 복습 기록 ${result.reviewLogs}건이에요.`, { duration: 5000 });
      go('#/settings'); // 바뀐 설정으로 화면을 다시 그린다
    } catch (e) {
      toast('가져오지 못했어요: ' + e.message, { kind: 'warn', duration: 5000 });
    }
  };

  const doWipe = async () => {
    const first = await confirmDialog({
      title: '모든 데이터를 지울까요?',
      message: '이 기기의 단어장, 복습·퀴즈 기록, 설정이 모두 지워져요. 먼저 백업을 내보내는 것을 권해요.',
      confirmLabel: '계속',
      danger: true,
    });
    if (!first) return;
    const second = await confirmDialog({ title: '정말 지울까요?', message: '되돌릴 수 없어요.', confirmLabel: '모두 지우기', danger: true });
    if (!second) return;
    try {
      await wipeAll();
      try {
        localStorage.removeItem('de:theme');
        localStorage.removeItem('de:font');
      } catch {
        /* 무시 */
      }
      location.hash = '#/today';
      location.reload();
    } catch (e) {
      toast('지우지 못했어요: ' + e.message, { kind: 'warn' });
    }
  };

  const data = h(
    'section',
    { class: 'card set-card' },
    h('h2', { class: 'card-title' }, '💾 데이터'),
    stats,
    backupInfo,
    h('p', { class: 'hint' }, '단어장은 이 기기에만 저장돼요. 폰과 노트북 사이에서 옮기거나 만일에 대비하려면 백업 파일을 내보내 두세요.'),
    h(
      'div',
      { class: 'col-actions' },
      h('button', { type: 'button', class: 'btn btn-primary', onclick: doExport }, '백업 내보내기 (JSON 내려받기)'),
      h('button', { type: 'button', class: 'btn', onclick: doImport }, '백업 가져오기'),
      h('button', { type: 'button', class: 'btn btn-danger-outline', onclick: doWipe }, '전체 삭제'),
    ),
    storage,
  );

  // ── 앱 정보 ───────────────────────────────────────────────────────
  const versionLine = h('p', { class: 'set-stats' }, `${APP_NAME} ${APP_VERSION}`);
  swVersion().then((v) => v && (versionLine.textContent = `${APP_NAME} ${APP_VERSION} · 캐시 ${v}`));

  const installBox = h('div');
  const paintInstall = () => {
    clear(installBox);
    if (isStandalone()) installBox.append(h('p', { class: 'hint' }, '✓ 홈 화면에 설치된 앱으로 실행 중이에요.'));
    else if (canInstall()) {
      installBox.append(
        h(
          'button',
          {
            type: 'button',
            class: 'btn btn-primary',
            onclick: async () => {
              if (await promptInstall()) toast('설치했어요. 홈 화면에서 열어 보세요.');
              paintInstall();
            },
          },
          '📲 이 기기에 앱 설치',
        ),
      );
    } else if (isIOS()) installBox.append(h('p', { class: 'hint' }, '아직 설치 전이에요. 아래 “iPhone” 방법대로 홈 화면에 추가해 주세요.'));
  };
  paintInstall();
  cleanups.push(on('install-available', paintInstall), on('installed', paintInstall));

  const about = h(
    'section',
    { class: 'card set-card' },
    h('h2', { class: 'card-title' }, 'ℹ️ 앱 정보'),
    versionLine,
    installBox,
    h(
      'details',
      { class: 'howto' },
      h('summary', null, '홈 화면에 추가하는 방법'),
      h('h3', null, 'Android (Chrome)'),
      h('ol', null, h('li', null, '오른쪽 위 ⋮ 메뉴를 눌러요.'), h('li', null, '“홈 화면에 추가” 또는 “앱 설치”를 눌러요.'), h('li', null, '홈 화면의 DE Reader 아이콘으로 실행해요.')),
      h('h3', null, 'iPhone (Safari)'),
      h('ol', null, h('li', null, '아래쪽 공유 버튼(네모에서 화살표가 나오는 모양)을 눌러요.'), h('li', null, '“홈 화면에 추가”를 눌러요.'), h('li', null, '반드시 홈 화면 아이콘으로 실행해요. 설치하지 않으면 오래 안 쓸 때 단어장이 지워질 수 있어요.')),
      h('h3', null, '노트북 (Chrome · Edge)'),
      h('ol', null, h('li', null, '주소창 오른쪽의 설치 아이콘(모니터에 화살표)을 눌러요.'), h('li', null, '“설치”를 눌러요.')),
    ),
    swSupported()
      ? h(
          'button',
          {
            type: 'button',
            class: 'btn',
            onclick: async (e) => {
              e.target.disabled = true;
              const has = await checkForUpdate({ force: true });
              e.target.disabled = false;
              if (!has) {
                toast('최신 버전이에요.');
                return;
              }
              const ok = await confirmDialog({ title: '새 버전이 있어요', message: '지금 새로고침해서 적용할까요?', confirmLabel: '새로고침' });
              if (ok) applyUpdate();
            },
          },
          '업데이트 확인',
        )
      : null,
    h('p', { class: 'hint' }, h('a', { href: REPO_URL, target: '_blank', rel: 'noopener noreferrer' }, 'GitHub 저장소'), ' · 앱 코드는 MIT 라이선스, 간격 반복은 ts-fsrs(MIT)를 사용해요.'),
  );

  clear(root).append(h('div', { class: 'settings' }, h('header', { class: 'view-head' }, h('h1', { class: 'view-title' }, '⚙️ 설정')), speech, reading, review, data, about));
  paintData();

  return () => {
    for (const fn of cleanups) fn();
    if (tts.state().id === 'preview') tts.stop();
  };
}
