/*
 * 어느 기능이 파일을 깨뜨리는지 **한 번에** 가린다.
 *
 * 웨일 뷰어가 「문서를 불러오지 못했습니다」 를 띄웠는데, 우리 검사는 전부 통과한다.
 * 통도 성하고 글자 수도 맞고 등록부도 맞는다. 추리로는 더 못 좁힌다.
 *
 * 그래서 **기능을 하나씩만 쓴 파일**을 여러 개 만든다. 순서대로 열어 보면
 * 어디서부터 안 열리는지가 곧 범인이다. 안 열리는 파일 번호만 알려주면 된다.
 *
 *   node make-trials.mjs <원본 hwp> [그림 든 hwp]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as P from '../../src/scripts/engine.js';
const ab = (b) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
const u32be = (d, o) => (d[o] << 24 | d[o + 1] << 16 | d[o + 2] << 8 | d[o + 3]) >>> 0;

const target = process.argv[2];
const donor = process.argv[3];
if (!target) { console.error('쓰기: node make-trials.mjs <원본 hwp> [그림 든 hwp]'); process.exit(1); }

function borrowPng(file) {
  const { streams } = P.readCFB(ab(fs.readFileSync(file)));
  for (const [k, v] of streams)
    if (k.startsWith('BinData') && v[0] === 0x89 && v[1] === 0x50)
      return { bytes: P.padPng(v, 4096), ext: 'png', pxW: u32be(v, 16), pxH: u32be(v, 20) };
  return null;
}
const png = donor ? borrowPng(donor) : null;

const base = target.replace(/\.hwp$/i, '');
const fresh = async () => P.openDocument(ab(fs.readFileSync(target)));

/** 셀 문단을 모은다. 화면이 입력칸을 만드는 것과 같은 기준. */
function cells(doc) {
  const out = [];
  const walk = (ps) => {
    for (const p of ps) for (const t of p.tables) if (t) for (const c of t.cells) for (const q of c.paras) {
      if (!q.tables.length && !q.hasCtrl) out.push({ q, c });
      walk([q]);
    }
  };
  walk(doc.blocks);
  return out;
}

const trials = [];

/* 0. 아무것도 안 바꾸고 **다시 써 보기**.
 *    글자 하나를 원래 값 그대로 넣는다 — 레코드 직렬화·압축·제자리 쓰기 경로를
 *    전부 밟으면서 내용은 그대로다. 이게 깨지면 기능 문제가 아니라 뼈대 문제다. */
{
  const doc = await fresh();
  const c = cells(doc).find((x) => x.q.text.trim());
  trials.push({ n: 0, name: '다시쓰기', why: '내용은 그대로, 저장 경로만 밟는다',
                args: [[{ para: c.q, text: c.q.text.replace(/\n+$/, '') }], [], []], doc });
}

/* 1. 글자만 채우기 */
{
  const doc = await fresh();
  const es = cells(doc).filter((x) => !x.q.text.trim()).slice(0, 8)
    .map((x, i) => ({ para: x.q, text: '홍길동' + i }));
  trials.push({ n: 1, name: '글자', why: '빈 칸 여덟 군데 채우기', args: [es, [], []], doc });
}

/* 2. 사진 한 장만 */
if (png) {
  const doc = await fresh();
  const slot = cells(doc).filter((x) => !x.q.text.trim() && x.c.width)
    .sort((a, b) => b.c.width * b.c.height - a.c.width * a.c.height)[0];
  if (slot) trials.push({ n: 2, name: '사진', why: '빈 칸에 그림 한 장',
    args: [[], [{ ...png, para: slot.q, w: Math.min(slot.c.width, 20000), h: Math.min(slot.c.height, 14000) }], []], doc });
}

/* 3. 글자 크기·줄간격만 — 작성3 에서 처음 쓴 기능이다 */
{
  const doc = await fresh();
  const ls = doc.blocks.filter((b) => b.text.trim() && !b.tables.length && !b.hasCtrl).slice(0, 3);
  trials.push({ n: 3, name: '서식', why: '세 줄에 11pt · 150%',
                args: [[], [], ls.map((p) => ({ para: p, sizePt: 11, linePct: 150 }))], doc });
}

/* 4. 크기만 (줄간격 빼고) — 3번이 깨지면 둘 중 어느 쪽인지 갈라야 한다 */
{
  const doc = await fresh();
  const ls = doc.blocks.filter((b) => b.text.trim() && !b.tables.length && !b.hasCtrl).slice(0, 3);
  trials.push({ n: 4, name: '크기만', why: '세 줄에 11pt',
                args: [[], [], ls.map((p) => ({ para: p, sizePt: 11 }))], doc });
}

/* 5. 줄간격만 */
{
  const doc = await fresh();
  const ls = doc.blocks.filter((b) => b.text.trim() && !b.tables.length && !b.hasCtrl).slice(0, 3);
  trials.push({ n: 5, name: '줄간격만', why: '세 줄에 150%',
                args: [[], [], ls.map((p) => ({ para: p, linePct: 150 }))], doc });
}

/* 6. 전부 한꺼번에 */
if (png) {
  const doc = await fresh();
  const cs = cells(doc);
  const slot = cs.filter((x) => !x.q.text.trim() && x.c.width)
    .sort((a, b) => b.c.width * b.c.height - a.c.width * a.c.height)[0];
  const es = cs.filter((x) => !x.q.text.trim() && x !== slot).slice(0, 8)
    .map((x, i) => ({ para: x.q, text: '홍길동' + i }));
  const ls = doc.blocks.filter((b) => b.text.trim() && !b.tables.length && !b.hasCtrl).slice(0, 3);
  trials.push({ n: 6, name: '전부', why: '글자 + 사진 + 서식',
    args: [es, slot ? [{ ...png, para: slot.q, w: Math.min(slot.c.width, 20000), h: Math.min(slot.c.height, 14000) }] : [],
           ls.map((p) => ({ para: p, sizePt: 11, linePct: 150 }))], doc });
}

console.log(`원본 ${path.basename(target)}${png ? '' : '  (그림 원본이 없어 사진 시험은 뺀다)'}\n`);
for (const t of trials) {
  const out = await P.saveDocument(t.doc, ...t.args);
  const name = `${base}_시험${t.n}_${t.name}.hwp`;
  fs.writeFileSync(name, out);
  console.log(` ${t.n}. ${t.name.padEnd(6)} ${t.why.padEnd(24)} → ${path.basename(name)}`);
}

console.log('\n순서대로 웨일(또는 한글 뷰어)로 열어 보세요.');
console.log('  0번이 안 열리면  → 기능 문제가 아니라 저장 뼈대 문제다');
console.log('  0은 되고 1이 안 되면 → 글자 채우기');
console.log('  2만 안 되면      → 사진');
console.log('  3이 안 되면 4·5로 크기인지 줄간격인지 가른다');
console.log('\n안 열리는 번호만 알려 주시면 됩니다.');
