/*
 * 「글 앞으로」 배치 값을 **실험으로** 알아낸다.
 *
 * 지금 그림은 「글자처럼 취급」 이라 줄 안에 끼어 들어가 옆 글자를 밀어낸다.
 * 서명은 그러면 안 되고 줄 위에 떠서 글자를 덮어야 한다.
 *
 * 그런데 가진 표본 파일의 그림이 **전부 같은 배치**라 「글 앞으로」 의 실측이 없다.
 * 규격만 보고 비트 하나를 찍으면 그게 또 확인 안 된 짐작이 된다.
 *
 * 그래서 후보를 전부 한 파일에 넣는다. 문단 하나에 후보 하나씩, 같은 그림으로.
 * **한 번 열어보면 어느 것이 맞는지 눈에 보인다.**
 *
 *   node probe-anchor.mjs <대상 hwp> [그림 든 hwp]
 *
 * 열어서 볼 것:
 *   글자를 밀어내지 않고 **글자 위에 겹쳐 보이는** 줄이 어느 번호인가.
 *   그 번호의 속성값을 index.html 의 buildPicture 에 넣으면 끝난다.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
import * as P from '../../src/scripts/engine.js';
const ab = (b) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
const u32be = (d, o) => (d[o] << 24 | d[o + 1] << 16 | d[o + 2] << 8 | d[o + 3]) >>> 0;
const MM = 7200 / 25.4;

/*
 * 후보들.
 *
 * 밑바탕은 부산대 파일에서 잰 값(0x040a2210)이다 — 세로는 문단 기준, 가로는 단 기준.
 * 거기서 「본문과의 배치」 로 의심되는 세 비트만 0~3 으로 돌린다.
 * 규격 문서마다 이 자리를 다르게 적어서, 맞는지는 열어봐야만 안다.
 */
const BASE = 0x040a2210 | 1 << 14;       // + 다른 개체와 겹침 허용
const MM2 = 7200 / 25.4;
/*
 * 첫 시험은 실패했다 — 가로 오프셋을 0 으로 둬서 그림이 전부 **왼쪽 여백**에 떨어졌다.
 * 두 번째 시험도 헛돌았다 — 18-20번 비트(높이 기준·크기 보호)를 돌려서 전부 「어울림」 이었다.
 * 본문과의 배치는 **21-23번**이다 (HWP 5.0 개체 공통 속성).
 */
const OFF_X = Math.round(12 * MM2);      // 단 왼쪽에서 12mm — 글자 한복판
const OFF_Y = Math.round(-2 * MM2);      // 줄보다 살짝 위로 올려 확실히 겹치게
const wrap = (n) => ((BASE & ~(7 << 21)) | (n << 21)) >>> 0;
const CANDIDATES = [
  { name: '지금 쓰는 값 (글자처럼 취급)', attr: 0x040a6001, off: false },
  { name: '배치 1 — 자리 차지',          attr: wrap(1), off: true },
  { name: '배치 2 — 글 뒤로',            attr: wrap(2), off: true },
  { name: '배치 3 — 글 앞으로 ★ 앱이 쓰는 값', attr: wrap(3), off: true },
];

/** 다른 hwp 에서 PNG 를 하나 빌려 온다. 작은 것이 좋다 — 겹치는지 봐야 하니까. */
function borrowPng(file) {
  const { streams } = P.readCFB(ab(fs.readFileSync(file)));
  let best = null;
  for (const [k, v] of streams) {
    if (!k.startsWith('BinData') || v[0] !== 0x89 || v[1] !== 0x50) continue;
    if (!best || v.length < best.bytes.length)
      best = { bytes: v, ext: 'png', pxW: u32be(v, 16), pxH: u32be(v, 20), from: k };
  }
  if (!best) throw new Error('PNG 를 못 찾았다: ' + file);
  return best;
}

const target = process.argv[2];
const donor = process.argv[3] || target;
if (!target) { console.error('쓰기: node probe-anchor.mjs <대상 hwp> [그림 든 hwp]'); process.exit(1); }

const png = borrowPng(donor);
const doc = await P.openDocument(ab(fs.readFileSync(target)));

/* 글자가 있는 최상위 문단을 후보 수만큼 고른다. 겹치는지 보려면 글자가 있어야 한다. */
const lines = doc.blocks.filter((b) => b.text.trim().length > 6 && !b.tables.length && !b.hasCtrl);
if (lines.length < CANDIDATES.length) {
  console.error(`글자 있는 줄이 ${lines.length}개뿐이다 — 후보 ${CANDIDATES.length}개를 못 넣는다`);
  process.exit(1);
}

/* 원본 크기를 유지하되 줄 하나에 얹힐 만한 크기로 줄인다. */
const h = Math.round(10 * MM);
const w = Math.round(png.pxW / png.pxH * h);

// 통에 스트림으로 넣으려면 4096B 이상이어야 한다. 작은 그림은 주석 청크로 채운다.
const bytes = P.padPng(png.bytes, 4096);

const pics = CANDIDATES.map((c, i) => ({
  bytes, ext: png.ext, pxW: png.pxW, pxH: png.pxH,
  para: lines[i], w, h, at: 0, attr: c.attr,
  offX: c.off ? OFF_X : 0, offY: c.off ? OFF_Y : 0,
}));

console.log(`대상 ${path.basename(target)}`);
console.log(`그림 ${png.from} · ${png.pxW}×${png.pxH} px → ${(w / MM).toFixed(0)}×${(h / MM).toFixed(0)} mm\n`);
CANDIDATES.forEach((c, i) => {
  console.log(` ${i + 1}. 0x${c.attr.toString(16).padStart(8, '0')}  ${c.name}`);
  console.log(`      → "${lines[i].text.trim().slice(0, 40)}"`);
});

const out = await P.saveDocument(doc, [], pics, []);
const outPath = target.replace(/\.hwp$/i, '') + '_배치시험.hwp';
fs.writeFileSync(outPath, out);

console.log(`\n→ ${path.basename(outPath)}`);
console.log('\n뷰어로 열고 볼 것:');
console.log('  글자를 **밀어내지 않고 위에 겹쳐 보이는** 줄이 몇 번인가.');
console.log('  1번은 지금 쓰는 값이라 글자를 밀어낼 것이다 — 그게 비교 기준이다.');
console.log('  무료로 여는 방법: 한컴 한글 뷰어, 또는 네이버 오피스 뷰어.');
