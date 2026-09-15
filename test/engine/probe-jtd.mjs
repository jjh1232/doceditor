/*
 * 一太郎(.jtd) DocumentText 실측.
 *
 *   node test/engine/probe-jtd.mjs <jtd 파일> [시작바이트] [길이]
 *
 * 스트림을 UTF-16BE 두 바이트씩 읽어, 글자로 보이는 것은 글자로, 아닌 것은 16진수로 찍는다.
 * 제어 레코드의 경계와 길이 규칙을 눈으로 찾기 위한 도구다 (hwp 의 probe-image 와 같은 역할).
 */
import fs from 'node:fs';
import { readCFB } from '../../src/scripts/engine.js';

const [file, startArg, lenArg] = process.argv.slice(2);
const b = fs.readFileSync(file);
const { streams } = readCFB(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
const d = streams.get('DocumentText');
const start = Number(startArg || 0), len = Number(lenArg || 600);

const isText = (c) => (c >= 0x20 && c < 0x7f) || (c >= 0x3000 && c <= 0x9fff) || (c >= 0xff00 && c <= 0xffef) || (c >= 0xac00 && c <= 0xd7a3);
let line = '', out = [];
for (let i = start; i + 1 < Math.min(d.length, start + len); i += 2) {
  const c = (d[i] << 8) | d[i + 1];
  if (isText(c)) line += String.fromCharCode(c);
  else { if (line) { out.push(JSON.stringify(line)); line = ''; } out.push(c.toString(16).padStart(4, '0')); }
  if (out.length > 16) { console.log(String(i).padStart(6), out.join(' ')); out = []; }
}
if (line) out.push(JSON.stringify(line));
if (out.length) console.log(out.join(' '));
console.log('\nDocumentText', d.length, 'B · 스트림:', [...streams.keys()].filter((k) => !k.includes('/')).join(' '));
