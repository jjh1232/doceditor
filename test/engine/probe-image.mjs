/*
 * hwp 안의 **그림이 어떻게 들어가 있는지** 재는 도구.
 *
 * 그림 넣기는 지금까지와 성격이 다르다. 있는 값을 고치는 게 아니라 없던 것을 짓는다.
 * 배치를 틀리면 한글이 파일을 아예 못 여는데 화면에는 아무 표시가 없다.
 * 그래서 짐작으로 쓰지 않고, **이미 그림이 든 파일을 뜯어 실측한다.**
 * 이 저장소의 다른 포맷 지식이 전부 이렇게 나왔다.
 *
 * index.html 안의 파서를 그대로 떼어 쓴다. 사본을 두면 조용히 어긋난다.
 *
 *   node probe-image.mjs <hwp파일...>
 *
 * 읽는 것 넷:
 *   [1] 통    BinData 스트림이 있나, 어디에 어떻게 담겼나
 *   [2] 색인  DocInfo 의 BIN_DATA · ID_MAPPINGS
 *   [3] 본문  gso → SHAPE_COMPONENT → SHAPE_COMPONENT_PICTURE 와 품은 문단
 *   [4] 여유  스트림을 새로 붙일 자리가 있나 (FAT 빈 칸 · 디렉터리 빈 슬롯)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as P from '../../src/scripts/engine.js';
const DOCINFO_TAG = {
  16: 'DOCUMENT_PROPERTIES', 17: 'ID_MAPPINGS', 18: 'BIN_DATA', 19: 'FACE_NAME',
  20: 'BORDER_FILL', 21: 'CHAR_SHAPE', 22: 'TAB_DEF', 23: 'NUMBERING', 24: 'BULLET',
  25: 'PARA_SHAPE', 26: 'STYLE', 27: 'DOC_DATA', 30: 'COMPATIBLE_DOCUMENT',
  31: 'LAYOUT_COMPATIBILITY', 32: 'TRACKCHANGE',
};
const BODY_TAG = {
  66: 'PARA_HEADER', 67: 'PARA_TEXT', 68: 'PARA_CHAR_SHAPE', 69: 'PARA_LINE_SEG',
  71: 'CTRL_HEADER', 72: 'LIST_HEADER', 73: 'PAGE_DEF', 76: 'SHAPE_COMPONENT',
  77: 'TABLE', 85: 'SHAPE_COMPONENT_PICTURE',
};

const hex = (u8, n = u8.length) => [...u8.subarray(0, n)].map((b) => b.toString(16).padStart(2, '0')).join(' ');
const u16 = (d, o) => d[o] | (d[o + 1] << 8);
const u32 = (d, o) => (d[o] | (d[o + 1] << 8) | (d[o + 2] << 16) | (d[o + 3] << 24)) >>> 0;
/** 제어 ID 는 리틀엔디언으로 들어 있어 뒤집어 읽는다. */
const ctrlId = (d, o = 0) => String.fromCharCode(d[o + 3], d[o + 2], d[o + 1], d[o]);

/** 자손 전부. 그림은 gso 의 **손자**라 직계만 보면 못 찾는다 — 실제로 한 번 놓쳤다. */
function descendants(recs, idx) {
  const lv = recs[idx].level, out = [];
  for (let i = idx + 1; i < recs.length && recs[i].level > lv; i++) out.push(i);
  return out;
}

async function probe(file) {
  const buf = fs.readFileSync(file);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const dv = new DataView(ab);

  console.log('\n' + '═'.repeat(76));
  console.log(path.basename(file), `(${buf.length.toLocaleString()} B)`);
  console.log('═'.repeat(76));

  const { streams, chains } = P.readCFB(ab);
  const flags = u32(streams.get('FileHeader'), 36);

  /* ── [1] 통 ─────────────────────────────────────────────────────── */
  const bins = [...streams.keys()].filter((k) => k.startsWith('BinData'));
  console.log('\n[1] BinData 스트림' + (bins.length ? '' : ' — 없음'));
  for (const b of bins) {
    const c = chains.get(b), head = streams.get(b);
    // 앞 바이트로 압축 여부를 안다. PNG 시그니처가 보이면 그대로 담긴 것이다.
    const isPng = head[0] === 0x89 && head[1] === 0x50;
    const isJpg = head[0] === 0xff && head[1] === 0xd8;
    console.log(`    ${b}  ${c.size.toLocaleString()} B · ${c.isMini ? '미니' : '일반'} 섹터 ${c.sectors.length}개`);
    console.log(`      앞 8B ${hex(head, 8)}  → ${isPng || isJpg ? '원본 그대로' : 'deflate 압축됨'}`);
  }

  /* ── [2] 색인 ───────────────────────────────────────────────────── */
  const diRaw = streams.get('DocInfo');
  if (diRaw) {
    const di = (flags & 1) ? await P.inflateRaw(diRaw) : diRaw;
    const recs = P.parseRecords(di);
    console.log(`\n[2] DocInfo — 레코드 ${recs.length}개 · 스트림 ${chains.get('DocInfo').size.toLocaleString()} B`);

    const idmap = recs.find((r) => r.tag === 17);
    if (idmap) {
      const arr = Array.from({ length: idmap.data.length / 4 }, (_, i) => u32(idmap.data, i * 4));
      console.log(`    ID_MAPPINGS [0] BinData 개수 = ${arr[0]}   ← 그림을 넣으면 올려야 한다`);
    }
    for (const r of recs.filter((x) => x.tag === 18)) {
      const prop = u16(r.data, 0), id = u16(r.data, 2), extLen = u16(r.data, 4);
      let ext = ''; for (let i = 0; i < extLen; i++) ext += String.fromCharCode(u16(r.data, 6 + i * 2));
      console.log(`    BIN_DATA  속성 0x${prop.toString(16).padStart(2, '0')} · ID ${id} · 확장자 "${ext}"` +
                  `   (${(prop >> 4) & 3 ? '무압축' : '스토리지 따름'})`);
      console.log(`              ${hex(r.data)}`);
    }
  }

  /* ── [3] 본문 ───────────────────────────────────────────────────── */
  let found = 0;
  for (let si = 0; ; si++) {
    const raw = streams.get('BodyText/Section' + si);
    if (!raw) break;
    const recs = P.parseRecords((flags & 1) ? await P.inflateRaw(raw) : raw);

    for (let i = 0; i < recs.length; i++) {
      if (recs[i].tag !== 71 || ctrlId(recs[i].data) !== 'gso ') continue;
      const kids = descendants(recs, i);
      const pic = kids.find((k) => recs[k].tag === 85);
      if (pic === undefined) continue;

      found++;
      if (found > 2) continue;
      const c = recs[i].data, s = recs[kids.find((k) => recs[k].tag === 76)].data, p = recs[pic].data;
      console.log(`\n[3] 그림 #${found} — Section${si} 레코드 ${i} (수준 ${recs[i].level})`);
      console.log(`    CTRL_HEADER '${ctrlId(c)}' ${c.length} B`);
      console.log(`      offsetY ${u32(c, 8)} · offsetX ${u32(c, 12)} · 폭 ${u32(c, 16)} · 높이 ${u32(c, 20)} (HWPUNIT)`);
      console.log(`      설명문 ${u16(c, 44)} WCHAR`);
      console.log(`    └ SHAPE_COMPONENT '${ctrlId(s)}' ${s.length} B`);
      console.log(`        초기 ${u32(s, 20)}×${u32(s, 24)} · 현재 ${u32(s, 28)}×${u32(s, 32)}`);
      console.log(`      └ SHAPE_COMPONENT_PICTURE ${p.length} B`);
      console.log(`          네 점 (${u32(p,12)},${u32(p,16)}) (${u32(p,20)},${u32(p,24)}) (${u32(p,28)},${u32(p,32)}) (${u32(p,36)},${u32(p,40)})`);
      console.log(`          자르기 ${u32(p,44)},${u32(p,48)},${u32(p,52)},${u32(p,56)}`);
      console.log(`          밝기 ${p[68]} · 대비 ${p[69]} · 효과 ${p[70]} · BinItem ID ${u16(p, 71)}  ★`);

      // 그림을 품은 문단의 글자. 확장 제어문자가 8 WCHAR 를 먹는 걸 눈으로 본다.
      for (let q = i; q >= 0; q--) {
        if (recs[q].tag !== 66) continue;
        const t = descendants(recs, q).find((k) => recs[k].tag === 67);
        if (t !== undefined) {
          const d = recs[t].data, w = [];
          for (let k = 0; k + 1 < d.length; k += 2) w.push(u16(d, k));
          console.log(`    품은 문단 글자수 ${u32(recs[q].data, 0) & 0x7fffffff} · PARA_TEXT ${d.length} B`);
          for (let k = 0; k < w.length; ) {
            if (w[k] >= 1 && w[k] <= 23 && w[k] !== 10 && w[k] !== 13) {
              console.log(`      [${String(k).padStart(2)}] 확장제어 코드 ${w[k]} '${ctrlId(d, k * 2 + 2)}' → 8 WCHAR`);
              k += 8;
            } else k++;
          }
        }
        break;
      }
    }
  }
  if (!found) console.log('\n[3] 본문에 그림 없음');

  /* ── [4] 스트림을 새로 붙일 여유 ────────────────────────────────── */
  const SEC = 1 << dv.getUint16(0x1e, true);
  const nFat = dv.getUint32(0x2c, true), dirStart = dv.getUint32(0x30, true);
  const nDifat = dv.getUint32(0x48, true);
  const difat = [];
  for (let i = 0; i < 109 && i < nFat; i++) {
    const s = dv.getUint32(0x4c + i * 4, true);
    if (s < 0xfffffffa) difat.push(s);
  }
  const FAT = [];
  for (const s of difat) {
    const base = SEC + s * SEC;
    for (let i = 0; i < SEC / 4; i++) FAT.push(dv.getUint32(base + i * 4, true));
  }
  const freeFat = FAT.filter((x) => x === 0xffffffff).length;
  const inFile = Math.floor((buf.length - SEC) / SEC);

  const chain = (st) => { const o = []; let c = st; while (c < 0xfffffffa) { o.push(c); c = FAT[c]; } return o; };
  let slots = 0, freeSlots = 0, hasBinData = false;
  for (const s of chain(dirStart)) {
    for (let i = 0; i < SEC / 128; i++) {
      const o = SEC + s * SEC + i * 128;
      slots++;
      if (buf[o + 66] === 0) { freeSlots++; continue; }
      const nl = dv.getUint16(o + 64, true);
      let nm = ''; for (let k = 0; k + 1 < nl; k += 2) nm += String.fromCharCode(dv.getUint16(o + k, true));
      if (nm.replace(/\0/g, '') === 'BinData') hasBinData = true;
    }
  }
  console.log('\n[4] 스트림을 새로 붙일 여유');
  console.log(`    섹터 ${SEC} B · 파일 안 섹터 ${inFile}개 · FAT 항목 ${FAT.length}칸 (빈 칸 ${freeFat})`);
  console.log(`    FAT 을 안 늘리고 쓸 수 있는 최대 = ${((FAT.length - inFile) * SEC / 1024).toFixed(0)} KB 덧붙이기` +
              ` + 파일 안 빈 섹터 ${((freeFat - Math.max(0, FAT.length - inFile)) * SEC / 1024).toFixed(0)} KB`);
  console.log(`    DIFAT 추가 섹터 ${nDifat} · 109칸 중 ${nFat} 사용`);
  console.log(`    디렉터리 슬롯 ${slots}개 · 빈 슬롯 ${freeSlots}개` +
              `  (필요: BinData 스토리지 ${hasBinData ? '있음 0' : '없음 1'} + 그림 1 = ${hasBinData ? 1 : 2})`);
  console.log(`    → ${freeSlots >= (hasBinData ? 1 : 2) ? '슬롯 충분' : '★ 디렉터리 섹터를 늘려야 한다'}`);
}

const files = process.argv.slice(2);
if (!files.length) { console.error('쓰기: node probe-image.mjs <hwp파일...>'); process.exit(1); }
for (const f of files) {
  try { await probe(f); }
  catch (e) { console.log(`\n${path.basename(f)} — 실패: ${e.message}`); }
}
