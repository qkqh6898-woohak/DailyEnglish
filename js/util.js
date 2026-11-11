// util.js — 날짜(KST)·표시 형식 등 화면과 무관한 순수 함수. (Node 테스트에서도 그대로 쓴다)

const DAY_MS = 86_400_000;
const KST_OFFSET_MS = 9 * 3_600_000; // 한국은 서머타임이 없어 항상 UTC+9
const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];

/** Date → 한국 날짜 'YYYY-MM-DD' */
export function kstDate(d = new Date()) {
  return new Date(d.getTime() + KST_OFFSET_MS).toISOString().slice(0, 10);
}

/** Date → 한국 시각의 시(0~23) */
export function kstHour(d = new Date()) {
  return new Date(d.getTime() + KST_OFFSET_MS).getUTCHours();
}

/** ISO 문자열·Date → 한국 날짜. 값이 없거나 잘못되면 null */
export function kstDateOf(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : kstDate(d);
}

const toUtc = (dateStr) => {
  const [y, m, d] = dateStr.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
};

export function addDays(dateStr, n) {
  return new Date(toUtc(dateStr) + n * DAY_MS).toISOString().slice(0, 10);
}

/** b - a (일 단위) */
export function diffDays(a, b) {
  return Math.round((toUtc(b) - toUtc(a)) / DAY_MS);
}

/** 0=일 … 6=토 */
export function weekdayOf(dateStr) {
  return new Date(toUtc(dateStr)).getUTCDay();
}

/** '2026-11-28' → '11월 28일 (토)' */
export function formatKoDate(dateStr, { year = false } = {}) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return `${year ? y + '년 ' : ''}${m}월 ${d}일 (${WEEKDAYS[weekdayOf(dateStr)]})`;
}

/** '2026-11-28' → '11/28' */
export function formatShortDate(dateStr) {
  const [, m, d] = dateStr.split('-').map(Number);
  return `${m}/${d}`;
}

/** '2026-11' → '2026년 11월' */
export function formatKoMonth(ym) {
  const [y, m] = ym.split('-').map(Number);
  return `${y}년 ${m}월`;
}

/**
 * 주간 퀴즈가 다루는 주(월~일). 가장 최근 일요일(오늘이 일요일이면 오늘)로 끝나는 주다.
 * 일요일에 열리고 다음 토요일까지 풀 수 있다.
 */
export function quizWeek(today) {
  const end = addDays(today, -weekdayOf(today));
  return { id: end, start: addDays(end, -6), end, opensToday: weekdayOf(today) === 0 };
}

/** 다음 일요일까지 남은 날 수 (오늘이 일요일이면 0) */
export function daysUntilSunday(today) {
  return (7 - weekdayOf(today)) % 7;
}

/**
 * 연속 학습일. 오늘 읽었으면 오늘부터, 아직이면 어제부터 거슬러 센다.
 * @param {Iterable<string>} days 읽기를 마친 한국 날짜들
 */
export function computeStreak(days, today) {
  const set = days instanceof Set ? days : new Set(days);
  let cursor = set.has(today) ? today : addDays(today, -1);
  let n = 0;
  while (set.has(cursor)) {
    n++;
    cursor = addDays(cursor, -1);
  }
  return n;
}

/** 시간 간격(ms) → '1분', '10분', '3시간', '5일', '2개월', '1.5년' */
export function formatInterval(ms) {
  const min = Math.max(1, Math.round(ms / 60_000));
  if (min < 60) return `${min}분`;
  const hours = Math.round(min / 60);
  if (hours < 24) return `${hours}시간`;
  const days = Math.round(ms / DAY_MS);
  if (days < 31) return `${days}일`;
  if (days < 365) return `${Math.round(days / 30)}개월`;
  const years = days / 365;
  return `${years >= 10 ? Math.round(years) : Math.round(years * 10) / 10}년`;
}

/** 다음 복습일을 오늘 기준으로 표시: '오늘', '내일', '3일 뒤', '11/28' */
export function formatDueDay(dueDate, today) {
  if (!dueDate) return '-';
  const n = diffDays(today, dueDate);
  if (n <= 0) return '오늘';
  if (n === 1) return '내일';
  if (n < 7) return `${n}일 뒤`;
  return formatShortDate(dueDate) + (dueDate.slice(0, 4) !== today.slice(0, 4) ? ` (${dueDate.slice(0, 4)})` : '');
}

/** 읽는 데 걸리는 시간(분). 학습자 기준 분당 약 110단어 */
export function readingMinutes(wordCount) {
  return Math.max(1, Math.round((wordCount || 0) / 110));
}

/** 배열을 무작위로 섞은 새 배열 */
export function shuffle(arr, rnd = Math.random) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 문장에서 특정 표현을 찾아 [앞, 표현, 뒤]로 나눈다. (복습 카드의 강조·빈칸 처리용)
 * 못 찾으면 null.
 */
export function splitAround(sentence, surface) {
  if (!sentence || !surface) return null;
  const re = new RegExp(`(^|[^A-Za-z0-9])(${escapeRegExp(surface)})(?![A-Za-z0-9])`, 'i');
  const m = re.exec(sentence);
  if (!m) return null;
  const start = m.index + m[1].length;
  return [sentence.slice(0, start), m[2], sentence.slice(start + m[2].length)];
}

/** 바이트 수 → '12.3 MB' */
export function formatBytes(n) {
  if (!Number.isFinite(n)) return '-';
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(1)} GB`;
}
