/*
 * 글자 크기 · 줄간격 왕복 검증.
 *
 *   열기 → 문단 하나에 크기·줄간격 지정 → 저장 → 다시 열기 → 확인
 *
 * 크기와 줄간격은 본문이 아니라 **DocInfo** 에 있다. 그래서 세 가지를 따로 본다.
 *
 *   1. DocInfo 에 CHAR_SHAPE · PARA_SHAPE 가 하나씩 늘었는가
 *   2. ID_MAPPINGS 의 해당 칸이 같이 올라갔는가 (안 올리면 한글이 못 찾는다)
 *   3. 문단이 **새 번호**를 가리키는가, 값이 맞는가
 *
 * 실측 자리 (자사양식.hwp, 2026-09-13):
 *   CHAR_SHAPE 42번지 INT32 = 1/100 pt · PARA_SHAPE 24·50번지 INT32 = %
 *
 *   node test-format.mjs <hwp파일...>
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
import * as P from '../../src/scripts/engine.js';
const SIZE_PT = 11, LINE_PCT = 150;
const ab = (b) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
const dv = (d) => new DataView(ab(Buffer.from(d)));
const u32 = (d, o) => dv(d).getUint32(o, true);
const i32 = (d, o) => dv(d).getInt32(o, true);

let fails = 0;
const ok = (c, msg) => { console.log(`      ${c ? '✓' : '✗'} ${msg}`); if (!c) fails++; };

async function run(file) {
  console.log(`\n${path.basename(file)}`);
  const doc = await P.openDocument(ab(fs.readFileSync(file)));

  // 글자가 있는 최상위 문단 하나. 개체 참조가 든 문단은 건드리면 안 된다.
  const target = doc.blocks.find((b) => b.text.trim() && !b.tables.length && !b.hasCtrl);
  if (!target) { console.log('  고칠 문단이 없다 — 건너뜀'); return; }
  console.log(`  대상 rec ${target.rec}  "${target.text.trim().slice(0, 30)}"`);

  const was = P.shapeIdsOf(doc.sections[target.si].recs, target);
  const di0 = doc.docInfo.recs;
  const nChar0 = di0.filter((r) => r.tag === 21).length;
  const nPara0 = di0.filter((r) => r.tag === 25).length;
  const map0 = di0.find((r) => r.tag === 17).data;
  console.log(`  지금 글자모양 ${was.charId} · 문단모양 ${was.paraId}` +
              `  (CHAR_SHAPE ${nChar0}개 · PARA_SHAPE ${nPara0}개)`);

  const out = await P.saveDocument(doc, [], [], [
    { para: target, sizePt: SIZE_PT, linePct: LINE_PCT },
  ]);

  const again = await P.openDocument(ab(Buffer.from(out)));   // 구조가 깨졌으면 여기서 던진다
  const { streams } = P.readCFB(ab(Buffer.from(out)));
  const di = P.parseRecords(await P.inflateRaw(streams.get('DocInfo')));
  const chars = di.filter((r) => r.tag === 21);
  const paras = di.filter((r) => r.tag === 25);
  const map = di.find((r) => r.tag === 17).data;

  ok(chars.length === nChar0 + 1, `[1] CHAR_SHAPE ${nChar0} → ${chars.length}`);
  ok(paras.length === nPara0 + 1, `    PARA_SHAPE ${nPara0} → ${paras.length}`);
  ok(u32(map, 9 * 4) === u32(map0, 9 * 4) + 1, `[2] ID_MAPPINGS[9] 글자모양 ${u32(map0, 9 * 4)} → ${u32(map, 9 * 4)}`);
  ok(u32(map, 13 * 4) === u32(map0, 13 * 4) + 1, `    ID_MAPPINGS[13] 문단모양 ${u32(map0, 13 * 4)} → ${u32(map, 13 * 4)}`);

  const newChar = chars[chars.length - 1], newPara = paras[paras.length - 1];
  ok(i32(newChar.data, 42) === SIZE_PT * 100, `    새 글자모양 크기 ${i32(newChar.data, 42) / 100}pt`);
  ok(i32(newPara.data, 24) === LINE_PCT, `    새 문단모양 줄간격 ${i32(newPara.data, 24)}%`);
  ok((u32(newPara.data, 0) & 3) === 0, '    줄간격을 % 로 읽는 설정');

  const now = P.shapeIdsOf(again.sections[target.si].recs, target);
  ok(now.charId === nChar0, `[3] 문단이 가리키는 글자모양 ${was.charId} → ${now.charId}`);
  ok(now.paraId === nPara0, `    문단이 가리키는 문단모양 ${was.paraId} → ${now.paraId}`);

  const outPath = file.replace(/\.hwp$/i, '') + '_서식테스트.hwp';
  fs.writeFileSync(outPath, out);
  console.log(`  → ${path.basename(outPath)}  ★ 한글로 열어봐야 한다`);
}

const files = process.argv.slice(2);
if (!files.length) { console.error('쓰기: node test-format.mjs <hwp파일...>'); process.exit(1); }
for (const f of files) {
  try { await run(f); }
  catch (e) { console.log(`\n${path.basename(f)} — 실패: ${e.message}`); fails++; }
}
console.log(`\n${fails ? '✗ ' + fails + '곳 실패' : '✓ 전부 통과'}`);
process.exit(fails ? 1 : 0);
