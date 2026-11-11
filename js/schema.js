// schema.js — 기사 JSON 형식(schema 1)의 정의와 검증.
// 앱(브라우저)과 tools/(Node)가 함께 쓰므로 외부 의존성 없이 순수 함수로만 작성한다.

export const SCHEMA_VERSION = 1;

export const POS = ['n', 'v', 'adj', 'adv', 'prep', 'conj', 'det', 'pron', 'aux', 'num', 'propn', 'intj'];
export const POS_LABEL = {
  n: '명사', v: '동사', adj: '형용사', adv: '부사', prep: '전치사', conj: '접속사',
  det: '한정사', pron: '대명사', aux: '조동사', num: '수사', propn: '고유명사', intj: '감탄사',
};

export const TOPICS = ['battery', 'economy'];
export const TOPIC_LABEL = { battery: '배터리', economy: '경제' };

export const LEVELS = ['A2', 'B1', 'B2', 'C1', 'C2'];

export const TOEIC_TYPES = ['verb_form', 'part_of_speech', 'preposition', 'conjunction', 'vocabulary', 'pronoun'];
export const TOEIC_TYPE_LABEL = {
  verb_form: '동사 형태', part_of_speech: '품사', preposition: '전치사',
  conjunction: '접속사', vocabulary: '어휘', pronoun: '대명사',
};

export const LIMITS = {
  wordMin: 250,
  wordMax: 350,
  wordTolerance: 5,
  paragraphsMin: 3,
  paragraphsMax: 6,
  koMax: 30,
  phraseKoMax: 40,
  part5Count: 3,
  choiceCount: 4,
  keyExpressionsMax: 10,
};

/** 글자(A-Z)가 들어 있는 토큰 = 뜻(l, p, ko)이 반드시 있어야 하는 "단어 토큰" */
export function isWordToken(tok) {
  return typeof tok?.t === 'string' && /[A-Za-z]/.test(tok.t);
}

/** 단어 수를 셀 때 포함하는 토큰 (글자나 숫자가 있으면 1단어) */
export function isCountedToken(tok) {
  return typeof tok?.t === 'string' && /[A-Za-z0-9]/.test(tok.t);
}

export function countWords(article) {
  let n = 0;
  for (const par of article?.paragraphs ?? []) {
    for (const tok of par?.tokens ?? []) if (isCountedToken(tok)) n++;
  }
  return n;
}

/** 토큰 배열을 원래 글로 되돌린다. [start, end) 구간만 뽑을 수도 있다. */
export function tokensToText(tokens, start = 0, end = tokens.length) {
  let s = '';
  for (let i = start; i < end; i++) {
    s += tokens[i].t;
    if (tokens[i].sp && i < end - 1) s += ' ';
  }
  return s;
}

const SENTENCE_END = new Set(['.', '!', '?']);
const SENTENCE_CLOSERS = new Set(['"', '”', '’', "'", ')', ']']);

/** 문단의 토큰을 문장 단위 [start, end) 구간으로 나눈다. (발음 듣기·기사 문장 표시용) */
export function splitSentences(tokens) {
  const out = [];
  let start = 0;
  for (let i = 0; i < tokens.length; i++) {
    if (!SENTENCE_END.has(tokens[i].t)) continue;
    let j = i;
    while (j + 1 < tokens.length && !tokens[j].sp && SENTENCE_CLOSERS.has(tokens[j + 1].t)) j++;
    if (tokens[j].sp || j === tokens.length - 1) {
      out.push({ start, end: j + 1 });
      start = j + 1;
      i = j;
    }
  }
  if (start < tokens.length) out.push({ start, end: tokens.length });
  return out;
}

export function isValidDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/** 날짜 → 저장소 안의 기사 파일 경로 */
export function articlePath(date) {
  return `articles/${date.slice(0, 4)}/${date.slice(5, 7)}/${date}.json`;
}

const isStr = (v) => typeof v === 'string' && v.trim().length > 0;
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isInt = (v) => Number.isInteger(v);

function isHttpsUrl(v) {
  if (typeof v !== 'string' || !v.startsWith('https://')) return false;
  try {
    return new URL(v).protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * 기사 JSON 전체 검증.
 * @param {object} a 기사 객체
 * @param {{path?: string}} [opts] path를 주면 파일 경로와 날짜가 맞는지도 확인한다.
 * @returns {{errors: string[], warnings: string[]}} errors가 비어 있으면 통과
 */
export function validateArticle(a, opts = {}) {
  const errors = [];
  const warnings = [];
  const err = (m) => errors.push(m);
  const warn = (m) => warnings.push(m);

  if (!isObj(a)) return { errors: ['기사 JSON의 최상위는 객체({ ... })여야 합니다.'], warnings };

  if (a.schema !== SCHEMA_VERSION) err(`schema: ${SCHEMA_VERSION}이어야 합니다. (현재: ${JSON.stringify(a.schema)})`);

  // 날짜와 경로
  if (!isValidDate(a.date)) {
    err(`date: "YYYY-MM-DD" 형식의 실제 날짜여야 합니다. (현재: ${JSON.stringify(a.date)})`);
  } else if (opts.path != null) {
    const norm = String(opts.path).replace(/\\/g, '/');
    const expected = articlePath(a.date);
    if (!(norm === expected || norm.endsWith('/' + expected))) {
      err(`파일 경로와 date가 맞지 않습니다. date가 ${a.date}이면 경로는 ${expected} 여야 합니다. (현재: ${norm})`);
    }
  }

  if (!TOPICS.includes(a.topic)) err(`topic: ${TOPICS.join(' 또는 ')} 중 하나여야 합니다. (현재: ${JSON.stringify(a.topic)})`);
  if (!LEVELS.includes(a.level)) err(`level: ${LEVELS.join(', ')} 중 하나여야 합니다. (현재: ${JSON.stringify(a.level)})`);

  if (!isObj(a.title) || !isStr(a.title.en) || !isStr(a.title.ko)) err('title: { "en": "...", "ko": "..." } 두 값이 모두 있어야 합니다.');

  if (!Array.isArray(a.summary_ko) || a.summary_ko.length === 0 || !a.summary_ko.every(isStr)) {
    err('summary_ko: 한글 요약 문장 배열이어야 합니다. (빈 배열·빈 문장 불가)');
  } else if (a.summary_ko.length !== 3) {
    warn(`summary_ko: 요약은 3줄을 권장합니다. (현재 ${a.summary_ko.length}줄)`);
  }

  // 출처
  if (!Array.isArray(a.sources) || a.sources.length < 1) {
    err('sources: 출처가 1개 이상 있어야 합니다.');
  } else {
    a.sources.forEach((s, i) => {
      if (!isObj(s) || !isStr(s.name)) err(`sources[${i}].name: 출처 이름이 없습니다.`);
      if (!isObj(s) || !isHttpsUrl(s.url)) err(`sources[${i}].url: https:// 로 시작하는 올바른 주소여야 합니다. (현재: ${JSON.stringify(s?.url)})`);
    });
  }

  // 문단과 토큰
  let actualWords = 0;
  if (!Array.isArray(a.paragraphs)) {
    err('paragraphs: 문단 배열이 없습니다.');
  } else {
    if (a.paragraphs.length < LIMITS.paragraphsMin || a.paragraphs.length > LIMITS.paragraphsMax) {
      err(`paragraphs: 문단은 ${LIMITS.paragraphsMin}~${LIMITS.paragraphsMax}개여야 합니다. (현재 ${a.paragraphs.length}개)`);
    }
    a.paragraphs.forEach((par, pi) => {
      const where = `paragraphs[${pi}]`;
      if (!isObj(par)) {
        err(`${where}: 문단은 객체여야 합니다.`);
        return;
      }
      if (!isStr(par.ko)) err(`${where}.ko: 문단의 한글 번역이 없습니다.`);

      // 구(phrase) 정의
      const phraseIds = new Set();
      if (par.phrases != null && !Array.isArray(par.phrases)) {
        err(`${where}.phrases: 배열이어야 합니다.`);
      } else {
        (par.phrases ?? []).forEach((ph, k) => {
          const w = `${where}.phrases[${k}]`;
          if (!isObj(ph)) {
            err(`${w}: 객체여야 합니다.`);
            return;
          }
          if (!isInt(ph.id) || ph.id < 0) err(`${w}.id: 0 이상의 정수여야 합니다.`);
          else if (phraseIds.has(ph.id)) err(`${w}.id: 같은 문단 안에서 id ${ph.id}가 중복됩니다.`);
          else phraseIds.add(ph.id);
          if (!isStr(ph.text)) err(`${w}.text: 구의 영어 표현이 없습니다.`);
          if (!isStr(ph.ko)) err(`${w}.ko: 구의 한글 뜻이 없습니다.`);
          else if ([...ph.ko].length > LIMITS.phraseKoMax) err(`${w}.ko: ${LIMITS.phraseKoMax}자 이내여야 합니다. (현재 ${[...ph.ko].length}자)`);
          if (ph.ex != null && !isStr(ph.ex)) err(`${w}.ex: 예문이 비어 있습니다.`);
        });
      }

      if (!Array.isArray(par.tokens) || par.tokens.length === 0) {
        err(`${where}.tokens: 토큰 배열이 없거나 비어 있습니다.`);
        return;
      }

      const phUse = new Map(); // phrase id → 토큰 위치 목록
      par.tokens.forEach((tok, ti) => {
        const label = `${where}.tokens[${ti}]` + (typeof tok?.t === 'string' ? ` ("${tok.t}")` : '');
        if (!isObj(tok) || typeof tok.t !== 'string' || tok.t.length === 0) {
          err(`${where}.tokens[${ti}]: t(화면에 보이는 글자)가 없습니다.`);
          return;
        }
        if (/\s/.test(tok.t)) err(`${label}: t 안에 공백이 있습니다. 공백은 sp로 표시합니다.`);
        if (typeof tok.sp !== 'boolean') err(`${label}: sp는 true 또는 false여야 합니다.`);
        if (isCountedToken(tok)) actualWords++;

        const hasAny = tok.l != null || tok.p != null || tok.ko != null;
        if (isWordToken(tok) || hasAny) {
          if (!isStr(tok.l)) err(`${label}: 단어 토큰에 l(원형)이 없습니다.`);
          if (!POS.includes(tok.p)) err(`${label}: p(품사)는 ${POS.join(', ')} 중 하나여야 합니다. (현재: ${JSON.stringify(tok.p)})`);
          if (!isStr(tok.ko)) err(`${label}: 단어 토큰에 ko(뜻)가 없습니다.`);
          else if ([...tok.ko].length > LIMITS.koMax) err(`${label}: ko는 ${LIMITS.koMax}자 이내여야 합니다. (현재 ${[...tok.ko].length}자: "${tok.ko}")`);
        }
        if (tok.ex != null && !isStr(tok.ex)) err(`${label}: ex(예문)가 비어 있습니다.`);

        if (tok.ph != null) {
          if (!isInt(tok.ph) || !phraseIds.has(tok.ph)) {
            err(`${label}: ph ${JSON.stringify(tok.ph)}에 해당하는 phrases[].id가 이 문단에 없습니다.`);
          } else {
            if (!phUse.has(tok.ph)) phUse.set(tok.ph, []);
            phUse.get(tok.ph).push(ti);
          }
        }
      });

      for (const id of phraseIds) {
        const idxs = phUse.get(id);
        if (!idxs) {
          err(`${where}.phrases (id ${id}): 이 구를 가리키는 토큰(ph)이 없습니다.`);
          continue;
        }
        if (idxs.length < 2) err(`${where}.phrases (id ${id}): 구는 토큰 2개 이상으로 이루어져야 합니다.`);
        for (let k = 1; k < idxs.length; k++) {
          if (idxs[k] !== idxs[k - 1] + 1) {
            err(`${where}.phrases (id ${id}): 구에 속한 토큰들이 연속되어 있지 않습니다. (토큰 위치 ${idxs.join(', ')})`);
            break;
          }
        }
      }
    });
  }

  // 단어 수
  if (!isInt(a.word_count)) {
    err(`word_count: 정수여야 합니다. (현재: ${JSON.stringify(a.word_count)})`);
  } else {
    if (a.word_count < LIMITS.wordMin || a.word_count > LIMITS.wordMax) {
      err(`word_count: ${LIMITS.wordMin}~${LIMITS.wordMax} 범위여야 합니다. (현재 ${a.word_count})`);
    }
    if (Array.isArray(a.paragraphs) && Math.abs(a.word_count - actualWords) > LIMITS.wordTolerance) {
      err(`word_count: 실제 단어 수(${actualWords})와 ${LIMITS.wordTolerance} 넘게 차이 납니다. (적힌 값 ${a.word_count})`);
    }
  }

  // 핵심 표현
  if (!Array.isArray(a.key_expressions) || a.key_expressions.length < 1 || a.key_expressions.length > LIMITS.keyExpressionsMax) {
    err(`key_expressions: 핵심 표현이 1~${LIMITS.keyExpressionsMax}개 있어야 합니다.`);
  } else {
    a.key_expressions.forEach((k, i) => {
      if (!isObj(k) || !isStr(k.en) || !isStr(k.ko)) err(`key_expressions[${i}]: en과 ko가 모두 있어야 합니다.`);
      else if (k.ex != null && !isStr(k.ex)) err(`key_expressions[${i}].ex: 예문이 비어 있습니다.`);
    });
    if (a.key_expressions.length !== 5) warn(`key_expressions: 5개를 권장합니다. (현재 ${a.key_expressions.length}개)`);
  }

  // 토익 Part 5
  if (!Array.isArray(a.toeic_part5) || a.toeic_part5.length !== LIMITS.part5Count) {
    err(`toeic_part5: 문제는 정확히 ${LIMITS.part5Count}개여야 합니다. (현재 ${Array.isArray(a.toeic_part5) ? a.toeic_part5.length + '개' : '없음'})`);
  } else {
    const types = [];
    a.toeic_part5.forEach((q, i) => {
      const w = `toeic_part5[${i}]`;
      if (!isObj(q)) {
        err(`${w}: 객체여야 합니다.`);
        return;
      }
      if (!isStr(q.q)) err(`${w}.q: 문제 문장이 없습니다.`);
      else if (!/_{3,}/.test(q.q)) err(`${w}.q: 빈칸(______)이 없습니다.`);
      if (!Array.isArray(q.choices) || q.choices.length !== LIMITS.choiceCount || !q.choices.every(isStr)) {
        err(`${w}.choices: 보기는 정확히 ${LIMITS.choiceCount}개여야 합니다. (현재 ${Array.isArray(q.choices) ? q.choices.length + '개' : '없음'})`);
      } else if (new Set(q.choices.map((c) => c.trim())).size !== q.choices.length) {
        err(`${w}.choices: 같은 보기가 중복되어 있습니다.`);
      }
      if (!isInt(q.answer) || q.answer < 0 || q.answer > LIMITS.choiceCount - 1) {
        err(`${w}.answer: 0~${LIMITS.choiceCount - 1} 사이의 정수여야 합니다. (현재: ${JSON.stringify(q.answer)})`);
      }
      if (!TOEIC_TYPES.includes(q.type)) err(`${w}.type: ${TOEIC_TYPES.join(', ')} 중 하나여야 합니다. (현재: ${JSON.stringify(q.type)})`);
      else types.push(q.type);
      if (!isStr(q.explain_ko)) err(`${w}.explain_ko: 한글 해설이 없습니다.`);
    });
    if (new Set(types).size !== types.length) warn('toeic_part5: 세 문제의 type은 서로 다르게 하는 것을 권장합니다.');
  }

  if (!Array.isArray(a.speaking)) err('speaking: 배열이어야 합니다. (1단계는 빈 배열 [])');

  return { errors, warnings };
}

/**
 * 앱에서 쓰는 최소 확인. 화면을 그릴 수 있는 형태인지 본다.
 * (세부 규칙은 예약 작업과 CI가 validateArticle로 이미 검사한다.)
 */
export function isRenderable(a) {
  if (!isObj(a) || !isValidDate(a.date)) return false;
  if (!isObj(a.title) || typeof a.title.en !== 'string') return false;
  if (!Array.isArray(a.paragraphs) || a.paragraphs.length === 0) return false;
  return a.paragraphs.every(
    (p) => isObj(p) && Array.isArray(p.tokens) && p.tokens.length > 0 && p.tokens.every((t) => isObj(t) && typeof t.t === 'string'),
  );
}

/** 기사 → articles/index.json 의 한 항목 */
export function indexItemOf(a) {
  return {
    date: a.date,
    topic: a.topic,
    level: a.level,
    title_en: a.title.en,
    title_ko: a.title.ko,
    path: articlePath(a.date),
  };
}

/** articles/index.json 검증 */
export function validateIndex(idx) {
  const errors = [];
  if (!isObj(idx)) return { errors: ['index.json의 최상위는 객체여야 합니다.'], warnings: [] };
  if (!isStr(idx.updated) || Number.isNaN(Date.parse(idx.updated))) errors.push('updated: 날짜·시간 문자열이어야 합니다.');
  if (!Array.isArray(idx.items)) {
    errors.push('items: 기사 목록 배열이 없습니다.');
    return { errors, warnings: [] };
  }
  const seen = new Set();
  idx.items.forEach((it, i) => {
    const w = `items[${i}]`;
    if (!isObj(it) || !isValidDate(it.date)) {
      errors.push(`${w}.date: "YYYY-MM-DD" 형식이어야 합니다.`);
      return;
    }
    if (seen.has(it.date)) errors.push(`${w}: 날짜 ${it.date}가 중복됩니다.`);
    seen.add(it.date);
    if (i > 0 && isValidDate(idx.items[i - 1]?.date) && idx.items[i - 1].date < it.date) errors.push(`${w}: 목록은 최신 날짜가 먼저 오도록 정렬되어야 합니다.`);
    if (!TOPICS.includes(it.topic)) errors.push(`${w}.topic: ${TOPICS.join(' 또는 ')}이어야 합니다.`);
    if (!LEVELS.includes(it.level)) errors.push(`${w}.level: ${LEVELS.join(', ')} 중 하나여야 합니다.`);
    if (!isStr(it.title_en) || !isStr(it.title_ko)) errors.push(`${w}: title_en과 title_ko가 모두 있어야 합니다.`);
    if (it.path !== articlePath(it.date)) errors.push(`${w}.path: ${articlePath(it.date)} 여야 합니다. (현재: ${JSON.stringify(it.path)})`);
  });
  return { errors, warnings: [] };
}
