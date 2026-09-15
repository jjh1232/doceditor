/*
 * 一太郎 DocumentText 의 레코드 규칙 검증.
 *
 * 가설 (2026-09-16, 문부과학성 様式A 에서 눈으로 찾음):
 *   · 스트림은 UTF-16BE 워드열. 앞에 세그먼트 머리("SsmgV001"·"TextV001" + 길이)가 있다.
 *   · 001c 로 레코드가 열리고, w[i+2] 가 레코드 길이(워드).
 *       끝 워드가 001f  → 한 덩어리 레코드
 *       끝 워드가 001d  → 안에 글자를 품는 레코드의 「여는 쪽」. 뒤에 글자가 오고
 *                         001e LEN … 001f 로 닫힌다 (LEN = 닫는 쪽 길이)
 *   · 나머지 워드는 글자. 000a 가 줄바꿈.
 *
 * 이 규칙으로 스트림 끝까지 **어긋남 없이** 걸어갈 수 있으면 가설이 맞다.
 */
import fs from 'node:fs';
import { readCFB } from '../../src/scripts/engine.js';

const hex = (w) => w.toString(16).padStart(4, '0');
for (const file of process.argv.slice(2)) {
  const b = fs.readFileSync(file);
  const { streams } = readCFB(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
  const d = streams.get('DocumentText');
  const w = [];
  for (let i = 0; i + 1 < d.length; i += 2) w.push((d[i] << 8) | d[i + 1]);

  // 세그먼트 머리 찾기: ASCII 8글자 이름 + 길이
  const heads = [];
  for (let i = 0; i + 4 < w.length; i++) {
    const s = String.fromCharCode(w[i] >> 8, w[i] & 255, w[i + 1] >> 8, w[i + 1] & 255, w[i + 2] >> 8, w[i + 2] & 255, w[i + 3] >> 8, w[i + 3] & 255);
    if (/^[A-Z][a-z]+V\d{3}$/.test(s)) heads.push({ at: i, name: s, a: hex(w[i + 4]), b: hex(w[i + 5]), c: hex(w[i + 6]) });
  }

  const tags = new Map(), nests = new Map();
  let i = heads.length ? heads[heads.length - 1].at + 4 : 0;
  // 머리 뒤 몇 워드는 레코드가 아니다 — 첫 001c 까지 건너뛴다
  while (i < w.length && w[i] !== 0x001c) i++;
  let chars = 0, lines = 0, bad = null, depth = 0, maxDepth = 0;
  while (i < w.length) {
    const c = w[i];
    if (c === 0x001c) {
      const tag = w[i + 1], len = w[i + 2], end = w[i + len - 1];
      if (!len || i + len > w.length || (end !== 0x001f && end !== 0x001d)) { bad = { at: i, tag: hex(tag), len, end: hex(end ?? 0) }; break; }
      const key = hex(tag) + (end === 0x001d ? '(연다)' : '');
      tags.set(key, (tags.get(key) || 0) + 1);
      if (end === 0x001d) { depth++; maxDepth = Math.max(maxDepth, depth); nests.set(hex(tag), (nests.get(hex(tag)) || 0) + 1); }
      i += len;
    } else if (c === 0x001e) {
      const len = w[i + 1];
      if (!len || w[i + len - 1] !== 0x001f) { bad = { at: i, closeLen: len, end: hex(w[i + len - 1] ?? 0) }; break; }
      depth--;
      i += len;
    } else {
      if (c === 0x000a) lines++; else chars++;
      i++;
    }
  }
  console.log(`\n${file.split(/[\\/]/).pop()}  ${d.length}B · ${w.length}워드`);
  console.log('  세그먼트 머리:', heads.map((h) => `${h.name}@${h.at}[${h.a} ${h.b} ${h.c}]`).join('  '));
  console.log(bad ? `  ✗ 어긋남: ${JSON.stringify(bad)}` : `  ✓ 끝까지 걸어감 · 글자 ${chars} · 줄바꿈 ${lines} · 최대 중첩 ${maxDepth} · 끝 깊이 ${depth}`);
  console.log('  레코드 종류:', [...tags].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}×${n}`).join(' '));
}
