/*
 * 통(CFB) 자체가 성한지 본다.
 *
 * 우리 파서는 스트림을 **읽을 수 있으면** 통과시킨다. 그런데 뷰어는 통 전체가
 * 앞뒤가 맞는지 본다. 그래서 우리 검사는 다 통과하는데 한글이나 웨일에서만
 * 「문서를 불러오지 못했습니다」 가 뜨는 일이 생긴다.
 *
 * 여기서 보는 것:
 *   1. 한 섹터를 두 스트림이 같이 쓰고 있지 않은가   ← 제일 위험하다
 *   2. 사슬 길이가 스트림 크기를 덮는가
 *   3. 사슬이 끊기거나 되돌아 돌지 않는가
 *   4. 디렉터리 항목이 전부 루트에서 닿는가
 *   5. 미니 스트림이 미니 섹터를 다 담을 만큼 긴가
 *   6. FAT·디렉터리·미니FAT 자기 섹터가 제대로 표시돼 있는가
 *
 *   node check-cfb.mjs <hwp파일...>
 */
import fs from 'node:fs';
import path from 'node:path';

const FREE = 0xffffffff, END = 0xfffffffe, FATSEC = 0xfffffffd, DIFSEC = 0xfffffffc;
const u16 = (d, o) => d[o] | (d[o + 1] << 8);
const u32 = (d, o) => (d[o] | (d[o + 1] << 8) | (d[o + 2] << 16) | (d[o + 3] << 24)) >>> 0;

function check(file) {
  const b = fs.readFileSync(file);
  const bad = [];
  const say = (m) => bad.push(m);

  const SEC = 1 << u16(b, 0x1e), MINI = 1 << u16(b, 0x20), CUT = u32(b, 0x38);
  const at = (s) => SEC + s * SEC;
  const inFile = Math.floor((b.length - SEC) / SEC);

  /* FAT */
  const nFat = u32(b, 0x2c), fatSecs = [];
  for (let i = 0; i < 109 && fatSecs.length < nFat; i++) {
    const s = u32(b, 0x4c + i * 4);
    if (s <= 0xfffffffa) fatSecs.push(s);
  }
  let ds = u32(b, 0x44), nDs = u32(b, 0x48);
  while (nDs-- > 0 && ds <= 0xfffffffa) {
    for (let i = 0; i < SEC / 4 - 1; i++) {
      const s = u32(b, at(ds) + i * 4);
      if (s <= 0xfffffffa) fatSecs.push(s);
    }
    ds = u32(b, at(ds) + SEC - 4);
  }
  if (fatSecs.length !== nFat) say(`FAT 섹터 ${fatSecs.length}개 ≠ 헤더가 말하는 ${nFat}개`);

  const FAT = [];
  for (const s of fatSecs) {
    if (s >= inFile) say(`FAT 섹터 ${s} 가 파일 밖 (총 ${inFile})`);
    for (let i = 0; i < SEC / 4; i++) FAT.push(u32(b, at(s) + i * 4));
  }
  for (const s of fatSecs)
    if (FAT[s] !== FATSEC) say(`FAT 섹터 ${s} 가 FAT 에 FATSECT 로 안 적혀 있다 (0x${(FAT[s] >>> 0).toString(16)})`);

  /* 사슬 하나를 따라가며 섹터를 찜한다. 이미 찜한 섹터면 겹친 것이다. */
  const owner = new Map();
  const chain = (start, who, want) => {
    const out = [];
    let s = start, guard = 0;
    while (s <= 0xfffffffa) {
      if (s >= inFile) { say(`${who}: 섹터 ${s} 가 파일 밖`); break; }
      if (owner.has(s)) { say(`${who}: 섹터 ${s} 를 "${owner.get(s)}" 와 같이 쓴다 ★`); break; }
      owner.set(s, who);
      out.push(s);
      if (++guard > 200000) { say(`${who}: 사슬이 안 끝난다`); break; }
      s = FAT[s];
      if (s === undefined) { say(`${who}: FAT 범위를 벗어났다`); break; }
    }
    if (s !== END && s <= 0xfffffffa) { /* 위에서 이미 말했다 */ }
    else if (s !== END && s !== FREE) say(`${who}: 끝 표시가 0x${(s >>> 0).toString(16)}`);
    if (want !== undefined && out.length * SEC < want)
      say(`${who}: 사슬 ${out.length}섹터(${out.length * SEC}B)로는 ${want}B 를 못 담는다`);
    return out;
  };

  for (const s of fatSecs) owner.set(s, 'FAT');

  /* 디렉터리 */
  const dirSecs = chain(u32(b, 0x30), '디렉터리');
  const SLOTS = SEC / 128;
  const slotAt = (id) => at(dirSecs[Math.floor(id / SLOTS)]) + (id % SLOTS) * 128;
  const total = dirSecs.length * SLOTS;
  const ent = [];
  for (let id = 0; id < total; id++) {
    const o = slotAt(id), nl = u16(b, o + 64);
    let name = '';
    for (let k = 0; k + 1 < Math.max(0, nl - 1); k += 2) name += String.fromCharCode(u16(b, o + k));
    ent.push({ id, name, type: b[o + 66], color: b[o + 67],
               left: u32(b, o + 68), right: u32(b, o + 72), child: u32(b, o + 76),
               start: u32(b, o + 116), size: u32(b, o + 120) });
  }

  /* 루트에서 닿는 항목만 세어 본다. 안 닿으면 뷰어가 그 스트림을 못 찾는다. */
  const seen = new Set();
  (function walk(id) {
    if (id > 0xfffffffa || id >= total || seen.has(id)) return;
    const e = ent[id];
    if (!e || e.type === 0) { say(`디렉터리: ${id}번 빈 슬롯을 가리키는 링크가 있다`); return; }
    seen.add(id);
    walk(e.left); walk(e.right);
    if (e.type === 1 || e.type === 5) walk(e.child);
  })(0);
  for (const e of ent)
    if (e.type !== 0 && !seen.has(e.id)) say(`디렉터리: "${e.name}" (${e.id}번) 이 루트에서 안 닿는다 ★`);

  /* 미니 스트림 */
  const root = ent[0];
  const rootChain = chain(root.start, 'Root(미니스트림)', root.size);
  const MFAT = [];
  for (const s of chain(u32(b, 0x3c), 'miniFAT'))
    for (let i = 0; i < SEC / 4; i++) MFAT.push(u32(b, at(s) + i * 4));

  const miniOwner = new Map();
  const miniChain = (start, who, want) => {
    let s = start, n = 0, guard = 0;
    while (s <= 0xfffffffa) {
      if (miniOwner.has(s)) { say(`${who}: 미니섹터 ${s} 를 "${miniOwner.get(s)}" 와 같이 쓴다 ★`); break; }
      miniOwner.set(s, who);
      if ((s + 1) * MINI > root.size) say(`${who}: 미니섹터 ${s} 가 미니스트림(${root.size}B) 밖`);
      n++;
      if (++guard > 200000) { say(`${who}: 미니 사슬이 안 끝난다`); break; }
      s = MFAT[s];
      if (s === undefined) { say(`${who}: miniFAT 범위를 벗어났다`); break; }
    }
    if (want !== undefined && n * MINI < want) say(`${who}: 미니 사슬 ${n}개로는 ${want}B 를 못 담는다`);
  };

  for (const e of ent) {
    if (e.type !== 2 || e.id === 0) continue;
    if (e.size < CUT) miniChain(e.start, e.name, e.size);
    else chain(e.start, e.name, e.size);
  }

  const names = ent.filter((e) => e.type !== 0).map((e) => e.name);
  return { bad, names, inFile, freeFat: FAT.filter((x) => x === FREE).length,
           freeSlots: ent.filter((e) => e.type === 0).length };
}

let fails = 0;
for (const f of process.argv.slice(2)) {
  let r;
  try { r = check(f); }
  catch (e) { console.log(`✗  ${path.basename(f)} — ${e.message}`); fails++; continue; }
  const head = `${r.bad.length ? '✗' : 'ok'}  ${path.basename(f).slice(0, 46).padEnd(48)}`;
  console.log(`${head} 섹터 ${r.inFile} · 빈 FAT ${r.freeFat} · 빈 슬롯 ${r.freeSlots}`);
  for (const m of r.bad) console.log(`       ${m}`);
  if (r.bad.length) fails++;
}
console.log(`\n${fails ? '✗ ' + fails + '개 파일에 문제' : '✓ 전부 성함'}`);
process.exit(fails ? 1 : 0);
