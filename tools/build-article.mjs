#!/usr/bin/env node
// build-article.mjs — "초안(draft)" 파일을 기사 JSON(schema 1)으로 조립한다.
//
// 사용법
//   node tools/build-article.mjs draft.json            → articles/YYYY/MM/YYYY-MM-DD.json 으로 저장
//   node tools/build-article.mjs draft.json --out x.json
//   node tools/build-article.mjs draft.json --stdout   (저장하지 않고 출력만)
//
// 초안 형식 (기사 JSON과 같되 paragraphs·lexicon·phrases만 다르다)
//   {
//     "date": "2026-11-28", "topic": "battery", "level": "B2",
//     "title": { "en": "...", "ko": "..." }, "summary_ko": ["...", "...", "..."],
//     "sources": [{ "name": "...", "url": "https://..." }],
//     "paragraphs": [
//       { "en": "The plant will [ramp up] output. It will [ramped up|ramp up] ...", "ko": "..." }
//     ],
//     "lexicon": {                       // 단어 → [원형, 품사, 그 문장에서의 뜻, 예문(선택)]
//       "the": ["the", "det", "그"],
//       "plant": ["plant", "n", "공장", "The plant runs 24 hours a day."],
//       "book~2": ["book", "v", "(손실을) 장부에 기록하다"]   // 글에서 book~2 라고 쓴 자리에만 적용
//     },
//     "phrases": {                       // 구 → [뜻, 예문(선택)]
//       "ramp up": ["(생산·규모를) 늘리다", "We need to ramp up output."]
//     },
//     "key_expressions": [...], "toeic_part5": [...]
//   }
//
// 글 안에서 쓰는 표시
//   [ramp up]            이 단어들은 하나의 구. phrases["ramp up"]을 찾는다.
//   [ramped up|ramp up]  화면에는 ramped up, 구 이름은 ramp up.
//   book~2               같은 단어가 다른 뜻으로 쓰일 때. lexicon["book~2"]를 찾는다.
//
// 단어 찾는 순서: "단어~표시" → 글자 그대로 → 소문자 → 's 를 뗀 형태.
// lexicon에 없는 단어가 하나라도 있으면 목록을 보여 주고 실패한다.

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { articlePath, countWords, isWordToken, SCHEMA_VERSION, validateArticle } from '../js/schema.js';
import { readJson, relPath, ROOT, stringifyArticle } from './lib.mjs';
import { tokenizeWithOffsets } from './tokenize.mjs';

const MARKUP_RE = /\[([^\]|]+)(?:\|([^\]]+))?\]|~([A-Za-z0-9_]+)/g;

/** 표시가 섞인 글 → { text(깨끗한 글), spans(구 구간), senses(뜻 표시 위치) } */
export function parseMarkup(src) {
  let text = '';
  const spans = [];
  const senses = [];
  const appendPlain = (s) => {
    // 대괄호 안팎의 일반 글. ~표시만 처리한다.
    let last = 0;
    for (const m of s.matchAll(/~([A-Za-z0-9_]+)/g)) {
      text += s.slice(last, m.index);
      senses.push({ at: text.length, tag: m[1] });
      last = m.index + m[0].length;
    }
    text += s.slice(last);
  };
  let last = 0;
  for (const m of src.matchAll(MARKUP_RE)) {
    appendPlain(src.slice(last, m.index));
    if (m[3] !== undefined) {
      senses.push({ at: text.length, tag: m[3] });
    } else {
      const start = text.length;
      appendPlain(m[1]);
      const shown = text.slice(start);
      spans.push({ start, end: text.length, key: (m[2] ?? shown).trim() });
    }
    last = m.index + m[0].length;
  }
  appendPlain(src.slice(last));
  return { text, spans, senses };
}

function entryToFields(entry, where) {
  if (Array.isArray(entry)) {
    const [l, p, ko, ex] = entry;
    return { l, p, ko, ...(ex ? { ex } : {}) };
  }
  if (entry && typeof entry === 'object') {
    const { l, p, ko, ex } = entry;
    return { l, p, ko, ...(ex ? { ex } : {}) };
  }
  throw new Error(`lexicon["${where}"]: [원형, 품사, 뜻, 예문?] 배열이어야 합니다.`);
}

/**
 * 초안 → 기사 객체.
 * @returns {{article: object, problems: string[], notes: string[]}}
 *   problems가 있으면 조립 실패(누락 단어 등), notes는 참고 사항.
 */
export function buildArticle(draft) {
  const problems = [];
  const notes = [];
  const lexicon = draft.lexicon ?? {};
  const phraseDefs = draft.phrases ?? {};
  const usedLex = new Set();
  const usedPhrases = new Set();
  const missing = new Map(); // 단어 → 처음 나온 문단 번호

  const lookup = (t, tag) => {
    const candidates = [];
    if (tag) {
      // 뜻 표시를 붙였으면 그 항목만 찾는다. (표시 없는 항목으로 슬쩍 넘어가면 실수를 놓친다.)
      candidates.push(`${t}~${tag}`, `${t.toLowerCase()}~${tag}`);
    } else {
      candidates.push(t, t.toLowerCase());
      const base = t.replace(/['’]s$/u, '');
      if (base !== t) candidates.push(base, base.toLowerCase());
    }
    for (const key of candidates) {
      if (Object.hasOwn(lexicon, key)) {
        usedLex.add(key);
        return entryToFields(lexicon[key], key);
      }
    }
    return null;
  };

  const paragraphs = (draft.paragraphs ?? []).map((par, pi) => {
    if (typeof par?.en !== 'string') {
      problems.push(`paragraphs[${pi}].en: 영어 문단이 없습니다.`);
      return { ko: par?.ko ?? '', tokens: [], phrases: [] };
    }
    const { text, spans, senses } = parseMarkup(par.en.replace(/\s+/g, ' ').trim());
    const raw = tokenizeWithOffsets(text);
    const phrases = [];
    const spanIds = new Map();

    const tokens = raw.map((tok) => {
      const out = { t: tok.t, sp: tok.sp };
      const sense = senses.find((s) => s.at === tok.end);
      if (isWordToken(tok) || Object.hasOwn(lexicon, tok.t)) {
        const found = lookup(tok.t, sense?.tag);
        if (found) Object.assign(out, found);
        else if (isWordToken(tok)) {
          const key = sense ? `${tok.t}~${sense.tag}` : tok.t;
          if (!missing.has(key)) missing.set(key, pi);
        }
      }
      const span = spans.find((s) => tok.start >= s.start && tok.end <= s.end);
      if (span) {
        if (!spanIds.has(span)) {
          const defKey = Object.hasOwn(phraseDefs, span.key) ? span.key : span.key.toLowerCase();
          const def = phraseDefs[defKey];
          if (!def) {
            problems.push(`paragraphs[${pi}]: 구 "[${span.key}]"가 phrases에 없습니다.`);
            spanIds.set(span, null);
          } else {
            usedPhrases.add(defKey);
            const [ko, ex] = Array.isArray(def) ? def : [def.ko, def.ex];
            const id = phrases.length;
            phrases.push({ id, text: defKey, ko, ...(ex ? { ex } : {}) });
            spanIds.set(span, id);
          }
        }
        const id = spanIds.get(span);
        if (id != null) out.ph = id;
      }
      return out;
    });

    for (const s of senses) {
      if (!raw.some((tok) => tok.end === s.at)) problems.push(`paragraphs[${pi}]: "~${s.tag}" 표시가 단어 바로 뒤에 붙어 있지 않습니다.`);
    }
    return { ko: par.ko ?? '', tokens, phrases };
  });

  if (missing.size) {
    const list = [...missing.entries()].map(([w, pi]) => `${w} (문단 ${pi + 1})`).join(', ');
    problems.push(`lexicon에 없는 단어 ${missing.size}개: ${list}`);
  }
  const unusedLex = Object.keys(lexicon).filter((k) => !usedLex.has(k));
  if (unusedLex.length) notes.push(`lexicon에 있지만 글에 쓰이지 않은 항목 ${unusedLex.length}개: ${unusedLex.join(', ')}`);
  const unusedPh = Object.keys(phraseDefs).filter((k) => !usedPhrases.has(k));
  if (unusedPh.length) notes.push(`phrases에 있지만 글에 쓰이지 않은 항목 ${unusedPh.length}개: ${unusedPh.join(', ')}`);

  const { lexicon: _lex, phrases: _ph, paragraphs: _pars, schema: _schema, word_count: _wc, ...rest } = draft;
  const article = {
    schema: SCHEMA_VERSION,
    date: rest.date,
    topic: rest.topic,
    level: rest.level,
    word_count: 0,
    title: rest.title,
    summary_ko: rest.summary_ko,
    sources: rest.sources,
    paragraphs,
    key_expressions: rest.key_expressions,
    toeic_part5: rest.toeic_part5,
    speaking: rest.speaking ?? [],
  };
  // 초안에 있던 그 밖의 선택 필드는 그대로 옮긴다.
  for (const [k, v] of Object.entries(rest)) if (!(k in article)) article[k] = v;
  article.word_count = countWords(article);
  return { article, problems, notes };
}

async function main(argv) {
  const args = argv.slice(2);
  const toStdout = args.includes('--stdout');
  const outAt = args.indexOf('--out');
  const outArg = outAt !== -1 ? args[outAt + 1] : null;
  const draftPath = args.find((a, i) => !a.startsWith('--') && (outAt === -1 || i !== outAt + 1));
  if (!draftPath) {
    console.error('사용법: node tools/build-article.mjs <초안.json> [--out 경로] [--stdout]');
    process.exit(2);
  }
  const draft = await readJson(draftPath);
  const { article, problems, notes } = buildArticle(draft);
  for (const n of notes) console.error('참고: ' + n);
  if (problems.length) {
    console.error(`❌ 조립 실패 (${problems.length}건)`);
    for (const p of problems) console.error('  - ' + p);
    process.exit(1);
  }
  const outPath = outArg ?? join(ROOT, articlePath(String(article.date)));
  const { errors, warnings } = validateArticle(article, toStdout || outArg ? {} : { path: relPath(outPath) });
  for (const w of warnings) console.error('⚠️  ' + w);
  if (errors.length) {
    console.error(`❌ 검증 실패 (${errors.length}건)`);
    for (const e of errors) console.error('  - ' + e);
    process.exit(1);
  }
  const text = stringifyArticle(article);
  if (toStdout) {
    process.stdout.write(text);
  } else {
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, text);
    console.error(`✅ ${relPath(outPath)} 저장 (${article.word_count}단어, 문단 ${article.paragraphs.length}개)`);
    console.error('   다음: node tools/build-index.mjs && node tools/validate.mjs --all');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv).catch((e) => {
    console.error('오류: ' + e.message);
    process.exit(1);
  });
}
