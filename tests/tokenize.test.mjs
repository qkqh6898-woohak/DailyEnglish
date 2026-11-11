// 토큰화(tools/tokenize.mjs)와 기사 조립(tools/build-article.mjs) 단위 테스트

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

import { tokensToText, validateArticle } from '../js/schema.js';
import { buildArticle, parseMarkup } from '../tools/build-article.mjs';
import { ROOT, stringifyArticle } from '../tools/lib.mjs';
import { skeleton, splitParagraphs, tokenize } from '../tools/tokenize.mjs';

const words = (text) => tokenize(text).map((t) => t.t);

test('기본 문장: 단어와 구두점을 나누고 공백을 sp로 기록한다', () => {
  assert.deepEqual(tokenize('The plant will ramp up.'), [
    { t: 'The', sp: true },
    { t: 'plant', sp: true },
    { t: 'will', sp: true },
    { t: 'ramp', sp: true },
    { t: 'up', sp: false },
    { t: '.', sp: false },
  ]);
});

test('숫자·기호·약어·하이픈 낱말', () => {
  assert.deepEqual(words('It cost $1.4 billion, up 70% from 1,000.'), ['It', 'cost', '$1.4', 'billion', ',', 'up', '70%', 'from', '1,000', '.']);
  assert.deepEqual(words('The U.S. firm voted 8–1.'), ['The', 'U.S.', 'firm', 'voted', '8–1', '.']);
  assert.deepEqual(words('a 5-year, state-of-the-art plan by mid-2027'), ['a', '5-year', ',', 'state-of-the-art', 'plan', 'by', 'mid-2027']);
  assert.deepEqual(words("Ford's F-150 won't stop"), ["Ford's", 'F-150', "won't", 'stop']);
  assert.deepEqual(words('rates of 3.75–4.00% and a 100,000-mile warranty'), ['rates', 'of', '3.75–4.00%', 'and', 'a', '100,000-mile', 'warranty']);
  assert.deepEqual(words('January–September'), ['January', '–', 'September']);
});

test('따옴표·괄호·줄표의 공백이 원문대로 복원된다', () => {
  const samples = [
    'The firm (founded in 1999) said: “We are on track.”',
    'Prices fell—sharply—in May; costs, however, did not.',
    'Why does this matter? Because the makers\' margins are thin!',
    'It rose 3.5 percentage points, from 3.75% to 4%.',
  ];
  for (const s of samples) assert.equal(tokensToText(tokenize(s)), s);
});

test('여러 공백과 줄바꿈은 공백 하나로 본다', () => {
  assert.equal(tokensToText(tokenize('one   two\nthree\t four')), 'one two three four');
});

test('문단 나누기와 뼈대 만들기', () => {
  const text = 'First paragraph here.\n\nSecond one,\nstill second.\n\n\nThird.';
  assert.deepEqual(splitParagraphs(text), ['First paragraph here.', 'Second one, still second.', 'Third.']);
  const sk = skeleton(text);
  assert.equal(sk.length, 3);
  assert.deepEqual(sk[2].tokens, [
    { t: 'Third', sp: false, l: '', p: '', ko: '' },
    { t: '.', sp: false },
  ]);
  assert.deepEqual(skeleton('Go 5.', { bare: true })[0].tokens, [
    { t: 'Go', sp: true },
    { t: '5', sp: false },
    { t: '.', sp: false },
  ]);
});

test('표시 읽기: [구], [보이는 글|구 이름], 단어~뜻표시', () => {
  const r = parseMarkup('It will [ramp up] and [ramped up~x|ramp up] the book~2 now.');
  assert.equal(r.text, 'It will ramp up and ramped up the book now.');
  assert.deepEqual(
    r.spans.map((s) => [r.text.slice(s.start, s.end), s.key]),
    [
      ['ramp up', 'ramp up'],
      ['ramped up', 'ramp up'],
    ],
  );
  assert.deepEqual(
    r.senses.map((s) => [r.text.slice(0, s.at).split(' ').pop(), s.tag]),
    [
      ['up', 'x'],
      ['book', '2'],
    ],
  );
});

const tinyDraft = () => ({
  date: '2026-11-28',
  topic: 'battery',
  level: 'B2',
  title: { en: 'Tiny', ko: '작은 글' },
  summary_ko: ['하나', '둘', '셋'],
  sources: [{ name: 'Example', url: 'https://example.com/' }],
  paragraphs: [{ en: 'The plant will [ramp up] output. Banks book~2 the loss, and Ford\'s book sold 70% more.', ko: '번역' }],
  lexicon: {
    the: ['the', 'det', '그'],
    plant: ['plant', 'n', '공장', 'The plant runs 24 hours a day.'],
    will: ['will', 'aux', '~할 것이다'],
    ramp: ['ramp', 'v', '(ramp up) 늘리다'],
    up: ['up', 'adv', '(ramp up의 일부) 위로'],
    output: ['output', 'n', '생산량'],
    banks: ['bank', 'n', '은행'],
    'book~2': ['book', 'v', '장부에 기록하다'],
    book: ['book', 'n', '책'],
    loss: ['loss', 'n', '손실'],
    and: ['and', 'conj', '그리고'],
    Ford: ['Ford', 'propn', '포드'],
    sold: ['sell', 'v', '팔리다'],
    more: ['more', 'adv', '더'],
    '70%': ['70%', 'num', '70퍼센트'],
  },
  phrases: { 'ramp up': ['(생산을) 늘리다', 'We need to ramp up output.'] },
  key_expressions: [{ en: 'ramp up', ko: '늘리다' }],
  toeic_part5: [],
});

test('초안 조립: 단어 찾기 순서, 뜻 표시, 구, 숫자 토큰', () => {
  const { article, problems, notes } = buildArticle(tinyDraft());
  assert.deepEqual(problems, []);
  assert.deepEqual(notes, []);
  const toks = article.paragraphs[0].tokens;
  const by = (t, nth = 0) => toks.filter((x) => x.t === t)[nth];

  assert.deepEqual(by('The'), { t: 'The', sp: true, l: 'the', p: 'det', ko: '그' }); // 소문자로 찾기
  assert.equal(by('plant').ex, 'The plant runs 24 hours a day.');
  assert.equal(by('ramp').ph, 0);
  assert.equal(by('up').ph, 0);
  assert.deepEqual(article.paragraphs[0].phrases, [{ id: 0, text: 'ramp up', ko: '(생산을) 늘리다', ex: 'We need to ramp up output.' }]);
  assert.equal(by('book', 0).p, 'v'); // book~2
  assert.equal(by('book', 1).p, 'n');
  assert.equal(by("Ford's").l, 'Ford'); // 's 를 떼고 찾기
  assert.equal(by('70%').ko, '70퍼센트'); // lexicon에 있으면 숫자도 뜻을 단다
  assert.equal(article.word_count, 16);
  assert.equal(article.schema, 1);
  assert.deepEqual(article.speaking, []);
  assert.ok(!('lexicon' in article) && !('phrases' in article));
  assert.equal(tokensToText(toks), "The plant will ramp up output. Banks book the loss, and Ford's book sold 70% more.");
});

test('초안 조립: 빠진 단어·구는 목록으로 알려 준다', () => {
  const d = tinyDraft();
  delete d.lexicon.output;
  delete d.lexicon['book~2'];
  delete d.phrases['ramp up'];
  d.lexicon.unused = ['unused', 'n', '안 쓰임'];
  const { problems, notes } = buildArticle(d);
  assert.ok(problems.some((p) => /구 "\[ramp up\]"가 phrases에 없습니다/.test(p)));
  assert.ok(problems.some((p) => /lexicon에 없는 단어 2개: output \(문단 1\), book~2 \(문단 1\)/.test(p)));
  assert.ok(notes.some((n) => /쓰이지 않은 항목 1개: unused/.test(n)));
});

test('prompts/draft-example.json 을 조립하면 저장된 샘플 기사와 똑같다', async () => {
  const draft = JSON.parse(await readFile(join(ROOT, 'prompts/draft-example.json'), 'utf8'));
  const { article, problems, notes } = buildArticle(draft);
  assert.deepEqual(problems, []);
  assert.deepEqual(notes, []);
  assert.deepEqual(validateArticle(article).errors, []);
  const saved = await readFile(join(ROOT, 'articles/2026/11/2026-11-09.json'), 'utf8');
  assert.equal(stringifyArticle(article), saved);
});
