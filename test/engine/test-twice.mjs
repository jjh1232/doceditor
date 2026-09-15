/*
 * 두 번 저장해도 같은가, 그리고 글자 수가 실제 글자와 맞는가.
 *
 * 두 가지를 본다. 둘 다 **파일은 멀쩡히 열리는데 값만 틀린** 종류라
 * 다른 검사에서 안 잡힌다.
 *
 *   1. 글자 수 = 실제 WCHAR 수      PARA_HEADER 0번지 vs PARA_TEXT 길이/2
 *   2. 두 번째 저장도 첫 번째와 같은가
 *
 * 2번이 있는 이유: 레코드의 data 는 원본 스트림을 가리키는 **뷰**다.
 * 거기 직접 쓰면 화면이 들고 있는 문서 모델까지 같이 바뀌어서, 글자 수처럼
 * 더하고 빼는 값이 저장할 때마다 또 더해진다. 실제로 그렇게 깨졌다 (2026-09-13).
 * 사람은 저장을 두 번 누른다 — 이건 반드시 막혀 있어야 한다.
 *
 *   node test-twice.mjs <hwp파일...>
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
import * as P from '../../src/scripts/engine.js';
const ab = (b) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
const u32 = (d, o) => (d[o] | (d[o + 1] << 8) | (d[o + 2] << 16) | (d[o + 3] << 24)) >>> 0;
const u32be = (d, o) => (d[o] << 24 | d[o + 1] << 16 | d[o + 2] << 8 | d[o + 3]) >>> 0;

let fails = 0;
const ok = (c, msg) => { console.log(`      ${c ? '✓' : '✗'} ${msg}`); if (!c) fails++; };

/** 헤더가 말하는 글자 수와 PARA_TEXT 의 실제 길이가 맞는지. */
async function badCounts(bytes) {
  const { streams } = P.readCFB(ab(Buffer.from(bytes)));
  const flags = u32(streams.get('FileHeader'), 36);
  let n = 0;
  for (let si = 0; ; si++) {
    const raw = streams.get('BodyText/Section' + si);
    if (!raw) break;
    const recs = P.parseRecords((flags & 1) ? await P.inflateRaw(raw) : raw);
    for (let i = 0; i < recs.length; i++) {
      if (recs[i].tag !== 66) continue;
      const said = u32(recs[i].data, 0) & 0x7fffffff;
      let real = 1;                                   // PARA_TEXT 가 없으면 줄바꿈 하나
      for (let j = i + 1; j < recs.length && recs[j].level > recs[i].level; j++)
        if (recs[j].tag === 67 && recs[j].level === recs[i].level + 1) { real = recs[j].data.length / 2; break; }
      if (said !== real) n++;
    }
  }
  return n;
}

const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

/** 그림 하나 빌려 온다. 그림이 있어야 「더하는 값」 경로를 밟는다. */
function borrowPng(files) {
  for (const f of files) {
    const { streams } = P.readCFB(ab(fs.readFileSync(f)));
    for (const [k, v] of streams)
      if (k.startsWith('BinData') && v[0] === 0x89 && v[1] === 0x50)
        return { bytes: P.padPng(v, 4096), ext: 'png', pxW: u32be(v, 16), pxH: u32be(v, 20) };
  }
  return null;
}

async function run(file, png) {
  console.log(`\n${path.basename(file)}`);
  const doc = await P.openDocument(ab(fs.readFileSync(file)));
  if (doc.kind === 'hwpx') { console.log('  hwpx — 건너뜀'); return; }

  /* 화면이 하는 일을 그대로: 글자 몇 개 고치고, 빈 칸에 그림 하나 넣는다. */
  const cells = [];
  const walk = (ps) => {
    for (const p of ps) for (const t of p.tables) if (t) for (const c of t.cells) for (const q of c.paras) {
      if (!q.tables.length && !q.hasCtrl) cells.push({ q, c });
      walk([q]);
    }
  };
  walk(doc.blocks);

  // 그림 자리를 먼저 잡는다. 글자를 먼저 고르면 그 칸이 겹쳐서 그림 경로를 못 밟는다.
  const slot = cells.filter((x) => !x.q.text.trim() && x.c.width && x.c.height)
    .sort((a, b) => b.c.width * b.c.height - a.c.width * a.c.height)[0];
  const edits = cells.filter((x) => !x.q.text.trim() && x !== slot).slice(0, 5)
    .map((x, i) => ({ para: x.q, text: '값' + i }));
  const pics = (png && slot)
    ? [{ ...png, para: slot.q, w: Math.min(slot.c.width, 20000), h: Math.min(slot.c.height, 14000) }] : [];
  if (!edits.length && !pics.length) { console.log('  고칠 곳이 없다 — 건너뜀'); return; }
  console.log(`  글자 ${edits.length}곳 · 그림 ${pics.length}개`);

  const a = await P.saveDocument(doc, edits, pics, []);
  const b = await P.saveDocument(doc, edits, pics, []);   // 같은 화면에서 한 번 더
  const c = await P.saveDocument(doc, edits, pics, []);

  ok(await badCounts(a) === 0, '[1] 첫 저장 — 글자 수가 실제와 맞는다');
  ok(await badCounts(b) === 0, `    두 번째 저장 — 어긋남 ${await badCounts(b)}`);
  ok(same(a, b) && same(b, c), '[2] 두 번째·세 번째 저장이 첫 번째와 바이트가 같다');
  await P.openDocument(ab(Buffer.from(b)));               // 다시 열리는지
  ok(true, '    저장본을 다시 열 수 있다');
}

const files = process.argv.slice(2);
if (!files.length) { console.error('쓰기: node test-twice.mjs <hwp파일...>'); process.exit(1); }
const png = borrowPng(files);
for (const f of files) {
  try { await run(f, png); }
  catch (e) { console.log(`\n${path.basename(f)} — 실패: ${e.message}`); fails++; }
}
console.log(`\n${fails ? '✗ ' + fails + '곳 실패' : '✓ 전부 통과'}`);
process.exit(fails ? 1 : 0);
