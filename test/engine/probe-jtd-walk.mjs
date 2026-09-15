/*
 * 파서 v2 시험: 닫는 쪽을 찾아 레코드를 건너뛰고, 텍스트 세그먼트 안에서만 걷는다.
 *
 *   레코드  001c TAG LEN 0000 … LEN 0000 TAG 001f   (닫는 쪽은 여는 쪽의 거울)
 *           닫는 쪽은 보통 i+LEN-4 에 있지만, 안에 그림·괘선 자료를 품은 레코드는 더 뒤에 있다
 *   중첩    001c TAG LEN … 001d  글자  001e LEN2 … 001f
 */
import fs from 'node:fs';
import { readCFB } from '../../src/scripts/engine.js';
const hex = (w) => w.toString(16).padStart(4, '0');

export function walk(w) {
  // 텍스트 구간
  const name10 = String.fromCharCode(w[10] >> 8, w[10] & 255, w[11] >> 8, w[11] & 255);
  let i = 10, end = w.length;
  if (name10 === 'Text') { const len = (w[14] << 16 | w[15]) >>> 0; i = 16; end = Math.min(w.length, 16 + len); }
  const runs = [];            // { start, text } — 줄바꿈(000a) 포함 연속 글자
  let run = null, stop = null, depth = 0, recs = 0;
  const markers = new Map();
  const flush = () => { if (run) { runs.push(run); run = null; } };
  while (i < end) {
    const c = w[i];
    if (c === 0x001c) {
      flush();
      const tag = w[i + 1], len = w[i + 2];
      if (!len) { stop = { at: i, why: 'len0' }; break; }
      if (w[i + len - 1] === 0x001d) { depth++; i += len; recs++; continue; }
      // 닫는 쪽은 여는 쪽의 거울: LEN 0000 TAG 001f (4워드)
      const closeAt = (k) => w[k] === len && w[k + 1] === 0 && w[k + 2] === tag && w[k + 3] === 0x001f;
      let k = i + len - 4;
      if (!closeAt(k)) { k = i + 4; while (k + 3 < end && !closeAt(k)) k++; }
      if (k + 3 >= end) { stop = { at: i, why: 'close-not-found', tag: hex(tag), len }; break; }
      i = k + 4; recs++;
    } else if (c === 0x001e) {
      flush();
      const len = w[i + 1];
      if (!len || w[i + len - 1] !== 0x001f) { stop = { at: i, why: 'bad-001e' }; break; }
      depth--; i += len; recs++;
    } else if (c < 0x20 && c !== 0x000a) {
      // 홀로 선 제어 워드(000e 등). 서식 레코드 바로 앞에 붙는 표시라 글자가 아니다. 한 칸만 건너뛴다.
      flush(); markers.set(hex(c), (markers.get(hex(c)) || 0) + 1); i++;
    } else {
      if (!run) run = { start: i, text: '' };
      run.text += String.fromCharCode(c); i++;
    }
  }
  flush();
  return { runs, stop, depth, recs, end, walked: stop ? stop.at : end, markers };
}

if (process.argv[1].endsWith('probe-jtd-walk.mjs')) {
  for (const file of process.argv.slice(2)) {
    const b = fs.readFileSync(file);
    const d = readCFB(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)).streams.get('DocumentText');
    const w = []; for (let i = 0; i + 1 < d.length; i += 2) w.push((d[i] << 8) | d[i + 1]);
    const r = walk(w);
    const chars = r.runs.reduce((a, x) => a + x.text.replace(/\n/g, '').length, 0);
    console.log(`\n${file.split(/[\\/]/).pop()}  구간 ~${r.end} · 걸어간 곳 ${r.walked} · 레코드 ${r.recs} · 글자 ${chars} · 깊이 ${r.depth}`, r.stop ? `\n  멈춤 ${JSON.stringify(r.stop)}` : '  ✓ 끝까지');
    const text = r.runs.map((x) => x.text).join('').split('\n').filter((l) => l.trim());
    console.log('  줄 수', text.length, '· 앞 12줄:');
    text.slice(0, 12).forEach((l) => console.log('   │' + l));
  }
}
