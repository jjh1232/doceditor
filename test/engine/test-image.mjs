/*
 * 그림 넣기 왕복 검증.
 *
 *   열기 → 표의 빈 칸에 그림 끼우기 → 저장 → **저장한 파일을 다시 열기** → 확인
 *
 * 그림은 세 군데에 나뉘어 들어가고 셋이 서로를 가리킨다. 하나만 어긋나도
 * 그림이 안 보이거나 파일이 안 열린다. 그래서 셋을 따로 확인한다.
 *
 *   1. 통      BinData/BIN000N 스트림이 생겼고 바이트가 그대로인가
 *   2. DocInfo BIN_DATA 가 붙었고 ID_MAPPINGS 개수가 올라갔는가
 *   3. 본문    gso → SHAPE_COMPONENT → SHAPE_COMPONENT_PICTURE 가 붙었고
 *              BinItem ID 가 1번과 같은가, 문단 글자 수가 8 늘었는가
 *
 * 넣을 그림은 **다른 hwp 에서 꺼낸 진짜 PNG** 를 쓴다. 만들어 낸 바이트로 하면
 * 통과해도 실제 그림에서 되는지 모른다.
 *
 * 여기를 통과해도 "한글이 연다" 는 증명이 아니다 — 그건 사람이 한 번 열어봐야 안다.
 * 다만 구조가 깨졌으면 여기서 걸린다. parseRecords 가 레코드 합과 스트림 길이를
 * 정확히 맞춰 보기 때문에, 한 바이트라도 어긋나면 다시 열 때 던진다.
 *
 *   node test-image.mjs <그림이 든 hwp> <넣을 대상 hwp...>
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
import * as P from '../../src/scripts/engine.js';
const HWPUNIT_PER_MM = 7200 / 25.4;
const u16 = (d, o) => d[o] | (d[o + 1] << 8);
const u32be = (d, o) => (d[o] << 24 | d[o + 1] << 16 | d[o + 2] << 8 | d[o + 3]) >>> 0;
const ctrlId = (d, o = 0) => String.fromCharCode(d[o + 3], d[o + 2], d[o + 1], d[o]);
const ab = (b) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);

let fails = 0;
const ok = (c, msg) => { console.log(`      ${c ? '✓' : '✗'} ${msg}`); if (!c) fails++; };

/** 다른 hwp 에서 PNG 를 하나 꺼내 온다. 통 안에 무압축으로 들어 있어 그냥 읽힌다. */
function borrowPng(file) {
  const { streams } = P.readCFB(ab(fs.readFileSync(file)));
  for (const [k, v] of streams) {
    if (!k.startsWith('BinData') || v[0] !== 0x89 || v[1] !== 0x50) continue;
    // IHDR 은 시그니처 8B + 길이 4B + 'IHDR' 4B 다음. 폭·높이가 빅엔디언으로 온다.
    return { bytes: v, ext: 'png', pxW: u32be(v, 16), pxH: u32be(v, 20), from: k };
  }
  throw new Error('PNG 를 못 찾았다: ' + file);
}

/** 화면이 입력칸을 만드는 것과 같은 기준으로 셀 문단을 모은다. */
function cellParas(doc) {
  const out = [];
  const walk = (paras) => {
    for (const p of paras)
      for (const t of p.tables) {
        if (!t) continue;
        for (const c of t.cells)
          for (const para of c.paras) {
            if (para.tables.length) continue;      // 표를 품은 문단은 못 건드린다
            out.push({ para, cell: c });
            walk([para]);
          }
      }
  };
  walk(doc.blocks);
  return out;
}

async function run(donor, target) {
  const png = borrowPng(donor);
  console.log(`\n${path.basename(target)}`);
  console.log(`  그림 ${png.from} · ${png.pxW}×${png.pxH} px · ${png.bytes.length.toLocaleString()} B`);

  const before = fs.readFileSync(target);
  const doc = await P.openDocument(ab(before));

  /* 제일 큰 빈 칸을 고른다 — 양식에서 사진 칸이 대개 그렇다. */
  const empty = cellParas(doc)
    .filter((x) => !x.para.text.trim() && x.cell.width && x.cell.height)
    .sort((a, b) => b.cell.width * b.cell.height - a.cell.width * a.cell.height)[0];
  if (!empty) { console.log('  빈 칸이 없다 — 건너뜀'); return; }

  // 원래 글자 수. 「빈 칸」 이라도 공백 한 자가 들어 있는 경우가 있다 —
  // 9 로 못 박으면 그런 파일에서 엔진이 맞는데도 검사가 틀렸다고 한다.
  const charsBefore =
    new DataView(ab(Buffer.from(doc.sections[empty.para.si].recs[empty.para.rec].data)))
      .getUint32(0, true) & 0x7fffffff;

  const mm = (v) => (v / HWPUNIT_PER_MM).toFixed(1);
  console.log(`  대상 칸 ${mm(empty.cell.width)}×${mm(empty.cell.height)} mm (rec ${empty.para.rec})`);

  /* 칸 안에 들어가게 비율을 지켜 줄인다. */
  const k = Math.min(empty.cell.width / png.pxW, empty.cell.height / png.pxH);
  const w = Math.round(png.pxW * k), h = Math.round(png.pxH * k);
  console.log(`  넣을 크기 ${mm(w)}×${mm(h)} mm`);

  const out = await P.saveDocument(doc, [], [
    { bytes: png.bytes, ext: png.ext, para: empty.para, pxW: png.pxW, pxH: png.pxH, w, h },
  ]);
  console.log(`  파일 ${before.length.toLocaleString()} → ${out.length.toLocaleString()} B` +
              ` (+${(out.length - before.length).toLocaleString()})`);

  /* ── 다시 열어서 셋을 따로 본다 ─────────────────────────────────── */
  const again = await P.openDocument(ab(Buffer.from(out)));       // 여기서 구조가 깨졌으면 던진다
  ok(again.nRecords >= doc.nRecords + 3, `레코드 ${doc.nRecords} → ${again.nRecords}`);

  /* 원래 그림이 들어 있던 파일도 있다. **새로 넣은 것만** 골라 봐야 한다 —
   * 아무거나 잡으면 원래 있던 그림을 검사하고 통과했다고 착각한다. */
  const { streams } = P.readCFB(ab(Buffer.from(out)));
  const di = P.parseRecords(await P.inflateRaw(streams.get('DocInfo')));
  const idmap = di.find((r) => r.tag === 17);
  const bins = di.filter((r) => r.tag === 18);
  const wasCount = doc.docInfo.recs.find((r) => r.tag === 17).data[0];
  ok(idmap.data[0] === wasCount + 1, `[2] ID_MAPPINGS BinData ${wasCount} → ${idmap.data[0]}`);

  const mine = bins.find((r) => u16(r.data, 2) === idmap.data[0]);
  ok(!!mine, `    BIN_DATA ${bins.length}개 중 새 것 ID ${idmap.data[0]}`);
  const binId = mine ? u16(mine.data, 2) : -1;
  ok(mine && u16(mine.data, 0) === 0x21, '    속성 0x21 (무압축)');

  const binKey = 'BinData/BIN' + String(binId).padStart(4, '0') + '.' + png.ext;
  const got = streams.get(binKey);
  ok(!!got, `[1] 통에 ${binKey}`);
  if (got) {
    ok(got.length === png.bytes.length, `    크기 ${got.length.toLocaleString()} B`);
    ok(got.every((b, i) => b === png.bytes[i]), '    바이트가 원본과 같다');
  }

  let shape = false, paraChars = -1, hit = false;
  const recs = again.sections[empty.para.si].recs;
  for (let i = 0; i < recs.length && !hit; i++) {
    if (recs[i].tag !== 71 || ctrlId(recs[i].data) !== 'gso ') continue;
    const lv = recs[i].level;
    let sc = false;
    for (let j = i + 1; j < recs.length && recs[j].level > lv; j++) {
      if (recs[j].tag === 76 && ctrlId(recs[j].data) === '$pic') sc = true;
      if (recs[j].tag === 85 && u16(recs[j].data, 71) === binId) hit = true;
    }
    if (!hit) continue;
    shape = sc;
    for (let p = i; p >= 0; p--)
      if (recs[p].tag === 66) {
        paraChars = new DataView(ab(Buffer.from(recs[p].data))).getUint32(0, true) & 0x7fffffff;
        break;
      }
  }
  ok(hit, `[3] BinItem ID ${binId} 을 가리키는 그림이 본문에 있다`);
  ok(shape, '    gso → SHAPE_COMPONENT $pic → PICTURE 3층');
  // 확장 제어문자가 8 WCHAR 를 먹는다. 딱 그만큼만 늘어야 한다.
  ok(paraChars === charsBefore + 8, `    품은 문단 글자수 ${charsBefore} → ${paraChars} (+8)`);

  const outPath = target.replace(/\.hwp$/i, '') + '_사진테스트.hwp';
  fs.writeFileSync(outPath, out);
  console.log(`  → ${path.basename(outPath)}  ★ 한글이나 네이버 뷰어로 열어봐야 한다`);

  /* ── 뺐다가 다시 보기 ────────────────────────────────────────────
   * 넣기만 되고 빼기가 안 되면 잘못 넣었을 때 파일을 버려야 한다.
   * 통과 DocInfo 는 그대로 두고 본문에서만 떼므로, 그림 수만 줄고 나머지는 그대로여야 한다. */
  const back = await P.openDocument(ab(Buffer.from(out)));
  const mineAgain = [];
  const walk = (ps) => { for (const q of ps) {
    for (const pic of q.pics || []) if (pic.binId === binId) mineAgain.push({ para: q, pic });
    for (const t of q.tables) if (t) for (const c of t.cells) walk(c.paras);
  } };
  walk(back.blocks);
  ok(mineAgain.length === 1, `[4] 다시 열었을 때 그 그림 ${mineAgain.length}개`);
  if (mineAgain.length !== 1) return;

  const out2 = await P.saveDocument(back, [], [], [], [{ para: mineAgain[0].para, binId }]);
  const gone = await P.openDocument(ab(Buffer.from(out2)));
  let left = 0;
  const walk2 = (ps) => { for (const q of ps) {
    for (const pic of q.pics || []) if (pic.binId === binId) left++;
    for (const t of q.tables) if (t) for (const c of t.cells) walk2(c.paras);
  } };
  walk2(gone.blocks);
  ok(left === 0, `    뺀 뒤 남은 그림 ${left}개`);

  const chars = new DataView(ab(Buffer.from(gone.sections[empty.para.si].recs[empty.para.rec].data)))
    .getUint32(0, true) & 0x7fffffff;
  ok(chars === charsBefore, `    글자수 ${charsBefore + 8} → ${chars} (원래대로)`);
  ok(gone.nRecords === doc.nRecords, `    레코드 ${gone.nRecords} (넣기 전 ${doc.nRecords})`);
}

const [donor, ...targets] = process.argv.slice(2);
if (!targets.length) { console.error('쓰기: node test-image.mjs <그림 든 hwp> <대상 hwp...>'); process.exit(1); }
for (const t of targets) {
  try { await run(donor, t); }
  catch (e) { console.log(`\n${path.basename(t)} — 실패: ${e.message}`); fails++; }
}
console.log(`\n${fails ? '✗ ' + fails + '곳 실패' : '✓ 전부 통과'}`);
process.exit(fails ? 1 : 0);
