// 날짜(KST)·표시 형식(js/util.js)과 서비스 워커 캐시 목록(tools/update-sw.mjs) 단위 테스트

import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  addDays,
  computeStreak,
  daysUntilSunday,
  diffDays,
  formatBytes,
  formatDueDay,
  formatInterval,
  formatKoDate,
  formatKoMonth,
  formatShortDate,
  kstDate,
  kstDateOf,
  kstHour,
  quizWeek,
  readingMinutes,
  shuffle,
  splitAround,
  weekdayOf,
} from '../js/util.js';
import { ROOT } from '../tools/lib.mjs';
import { shellFiles, syncServiceWorker } from '../tools/update-sw.mjs';

test('한국 날짜: 기기 시간대와 상관없이 UTC+9로 계산한다', () => {
  assert.equal(kstDate(new Date('2026-11-27T14:59:59Z')), '2026-11-27'); // 한국 23:59
  assert.equal(kstDate(new Date('2026-11-27T15:00:00Z')), '2026-11-28'); // 한국 00:00
  assert.equal(kstDate(new Date('2026-12-31T15:00:00Z')), '2027-01-01');
  assert.equal(kstHour(new Date('2026-11-27T21:47:00Z')), 6); // 예약 작업 실행 시각 06:47
  assert.equal(kstDateOf('2026-11-27T15:00:00.000Z'), '2026-11-28');
  assert.equal(kstDateOf(null), null);
  assert.equal(kstDateOf('not a date'), null);
});

test('날짜 더하기·빼기·요일', () => {
  assert.equal(addDays('2026-11-28', 1), '2026-11-29');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(addDays('2028-02-28', 1), '2028-02-29'); // 윤년
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
  assert.equal(diffDays('2026-11-28', '2026-12-05'), 7);
  assert.equal(diffDays('2026-12-05', '2026-11-28'), -7);
  assert.equal(weekdayOf('2026-11-28'), 6); // 토
  assert.equal(weekdayOf('2026-11-29'), 0); // 일
});

test('날짜 표시', () => {
  assert.equal(formatKoDate('2026-11-28'), '11월 28일 (토)');
  assert.equal(formatKoDate('2026-01-05', { year: true }), '2026년 1월 5일 (월)');
  assert.equal(formatShortDate('2026-11-07'), '11/7');
  assert.equal(formatKoMonth('2026-11'), '2026년 11월');
});

test('주간 퀴즈의 주: 가장 최근 일요일로 끝나는 월~일', () => {
  assert.deepEqual(quizWeek('2026-11-15'), { id: '2026-11-15', start: '2026-11-09', end: '2026-11-15', opensToday: true }); // 일요일 당일
  assert.deepEqual(quizWeek('2026-11-16'), { id: '2026-11-15', start: '2026-11-09', end: '2026-11-15', opensToday: false }); // 월요일 → 지난주
  assert.deepEqual(quizWeek('2026-11-21'), { id: '2026-11-15', start: '2026-11-09', end: '2026-11-15', opensToday: false }); // 토요일까지
  assert.equal(quizWeek('2026-11-22').id, '2026-11-22');
  assert.equal(daysUntilSunday('2026-11-15'), 0);
  assert.equal(daysUntilSunday('2026-11-11'), 4);
  assert.equal(daysUntilSunday('2026-11-21'), 1);
});

test('연속 학습일: 오늘 읽었으면 오늘부터, 아직이면 어제부터 센다', () => {
  const today = '2026-11-28';
  assert.equal(computeStreak([], today), 0);
  assert.equal(computeStreak(['2026-11-28'], today), 1);
  assert.equal(computeStreak(['2026-11-27'], today), 1, '오늘 아직 안 읽었어도 어제까지의 기록은 유지');
  assert.equal(computeStreak(['2026-11-26'], today), 0, '어제를 건너뛰면 끊긴다');
  assert.equal(computeStreak(['2026-11-28', '2026-11-27', '2026-11-26', '2026-11-24'], today), 3);
  assert.equal(computeStreak(new Set(['2026-11-27', '2026-11-26', '2026-11-25']), today), 3);
  assert.equal(computeStreak(['2026-11-28', '2026-11-28', '2026-11-27'], today), 2, '같은 날 여러 편을 읽어도 하루');
});

test('간격 표시: 분 / 시간 / 일 / 개월 / 년', () => {
  const MIN = 60_000;
  const DAY = 86_400_000;
  assert.equal(formatInterval(10_000), '1분');
  assert.equal(formatInterval(MIN), '1분');
  assert.equal(formatInterval(10 * MIN), '10분');
  assert.equal(formatInterval(59 * MIN), '59분');
  assert.equal(formatInterval(60 * MIN), '1시간');
  assert.equal(formatInterval(23 * 60 * MIN), '23시간');
  assert.equal(formatInterval(DAY), '1일');
  assert.equal(formatInterval(3 * DAY), '3일');
  assert.equal(formatInterval(30 * DAY), '30일');
  assert.equal(formatInterval(45 * DAY), '2개월');
  assert.equal(formatInterval(300 * DAY), '10개월');
  assert.equal(formatInterval(365 * DAY), '1년');
  assert.equal(formatInterval(550 * DAY), '1.5년');
  assert.equal(formatInterval(4000 * DAY), '11년');
});

test('다음 복습일 표시', () => {
  const today = '2026-11-28';
  assert.equal(formatDueDay('2026-11-20', today), '오늘'); // 밀린 것도 오늘
  assert.equal(formatDueDay('2026-11-28', today), '오늘');
  assert.equal(formatDueDay('2026-11-29', today), '내일');
  assert.equal(formatDueDay('2026-12-01', today), '3일 뒤');
  assert.equal(formatDueDay('2026-12-20', today), '12/20');
  assert.equal(formatDueDay('2027-03-01', today), '3/1 (2027)');
  assert.equal(formatDueDay(null, today), '-');
});

test('문장에서 표현 찾기 (강조·빈칸용)', () => {
  assert.deepEqual(splitAround('The Bank raised its key rate.', 'raised'), ['The Bank ', 'raised', ' its key rate.']);
  assert.deepEqual(splitAround('Raised rates hurt.', 'raised'), ['', 'Raised', ' rates hurt.'], '대소문자 무시');
  assert.deepEqual(splitAround('They stay ahead of the curve.', 'ahead of the curve'), ['They stay ', 'ahead of the curve', '.']);
  assert.deepEqual(splitAround('The rate is 4% (up).', '4%'), ['The rate is ', '4%', ' (up).'], '기호가 들어간 표현');
  assert.equal(splitAround('The praised plan.', 'raised'), null, '다른 단어의 일부는 찾지 않는다');
  assert.equal(splitAround('Nothing here.', 'absent'), null);
  assert.equal(splitAround('', 'x'), null);
  assert.equal(splitAround('text', ''), null);
});

test('그 밖의 표시 함수', () => {
  assert.equal(readingMinutes(302), 3);
  assert.equal(readingMinutes(40), 1);
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(1536), '1.5 KB');
  assert.equal(formatBytes(5 * 1024 * 1024), '5.0 MB');
  assert.equal(formatBytes(NaN), '-');
  const arr = [1, 2, 3, 4, 5];
  const mixed = shuffle(arr, () => 0.5);
  assert.deepEqual([...mixed].sort(), arr);
  assert.deepEqual(arr, [1, 2, 3, 4, 5], '원래 배열은 그대로');
});

// ── 서비스 워커 ──────────────────────────────────────────────────────

test('sw.js 의 캐시 버전과 파일 목록이 앱 파일과 맞는다 (아니면 node tools/update-sw.mjs 실행)', async () => {
  const { upToDate, version } = await syncServiceWorker({ write: false });
  assert.ok(upToDate, '앱 파일이 바뀌었는데 sw.js 가 갱신되지 않았다. `node tools/update-sw.mjs` 를 실행한 뒤 함께 커밋하세요.');
  assert.match(version, /^\d+\.\d+\.\d+-[0-9a-f]{8}$/);
});

test('미리 저장할 파일 목록에 앱이 쓰는 파일이 모두 들어 있다', async () => {
  const files = await shellFiles();
  const html = await readFile(join(ROOT, 'index.html'), 'utf8');
  const linked = [...html.matchAll(/(?:href|src)="([^"#]+)"/g)].map((m) => m[1]).filter((u) => !/^https?:/.test(u));
  for (const u of linked) assert.ok(files.includes(u), `index.html 이 쓰는 ${u} 가 목록에 없다`);
  for (const name of await readdir(join(ROOT, 'js'))) assert.ok(files.includes(`js/${name}`), `js/${name} 가 목록에 없다`);
  const manifest = JSON.parse(await readFile(join(ROOT, 'manifest.webmanifest'), 'utf8'));
  for (const icon of manifest.icons) assert.ok(files.includes(icon.src), `아이콘 ${icon.src} 가 목록에 없다`);
  assert.ok(!files.some((f) => f.startsWith('articles/')), '기사는 미리 저장 목록에 넣지 않는다');
  assert.ok(!files.includes('sw.js'));
});

test('앱 코드는 절대 경로를 쓰지 않는다 (GitHub Pages 하위 경로 대응)', async () => {
  const sources = ['index.html', 'sw.js', 'manifest.webmanifest', 'css/app.css', ...(await readdir(join(ROOT, 'js'))).map((n) => `js/${n}`)];
  for (const f of sources) {
    const text = await readFile(join(ROOT, f), 'utf8');
    const bad = [...text.matchAll(/(?:href|src|url|fetch|register|import)\s*[=(:]\s*['"(]\/(?!\/)[^'")]*/g)].map((m) => m[0]);
    assert.deepEqual(bad, [], `${f} 에 /로 시작하는 절대 경로가 있다`);
  }
});

test('저장소에 개인 정보(메일 주소)가 들어 있지 않다', async () => {
  const walk = async (dir) => {
    const out = [];
    for (const ent of await readdir(join(ROOT, dir), { withFileTypes: true })) {
      if (ent.name === '.git' || ent.name === 'node_modules') continue;
      const rel = dir ? `${dir}/${ent.name}` : ent.name;
      if (ent.isDirectory()) out.push(...(await walk(rel)));
      else if (/\.(js|mjs|json|html|css|md|yml|yaml|txt|webmanifest|svg)$/.test(ent.name)) out.push(rel);
    }
    return out;
  };
  const allowed = /noreply@|@example\.com|@playwright|@param|@returns|@throws|@media|@keyframes|@@INLINE|@v\d/;
  for (const f of await walk('')) {
    if (f.startsWith('vendor/')) continue;
    const text = await readFile(join(ROOT, f), 'utf8');
    const hits = [...text.matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g)].map((m) => m[0]).filter((e) => !allowed.test(e));
    assert.deepEqual(hits, [], `${f} 에 메일 주소처럼 보이는 글이 있다`);
  }
});
