// 어긋난 레코드의 실제 끝(다음 001f)과 길이 칸들을 나란히 본다 + 세그먼트 머리 해석
import fs from 'node:fs';
import { readCFB } from '../../src/scripts/engine.js';
const hex = (w) => w.toString(16).padStart(4, '0');
const [file, atArg] = process.argv.slice(2);
const b = fs.readFileSync(file);
const d = readCFB(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)).streams.get('DocumentText');
const w = []; for (let i = 0; i + 1 < d.length; i += 2) w.push((d[i] << 8) | d[i + 1]);
console.log('앞 16워드:', w.slice(0, 16).map(hex).join(' '));
const ascii = (i) => String.fromCharCode(w[i] >> 8, w[i] & 255, w[i + 1] >> 8, w[i + 1] & 255, w[i + 2] >> 8, w[i + 2] & 255, w[i + 3] >> 8, w[i + 3] & 255);
console.log('이름 0:', ascii(0), ' 이름 10:', ascii(10), ' 총 워드', w.length);
if (atArg) {
  const at = Number(atArg);
  let j = at + 1; while (j < w.length && w[j] !== 0x001f) j++;
  console.log(`@${at} tag ${hex(w[at + 1])} len칸 ${w[at + 2]} (${hex(w[at + 2])}) 다음칸 ${hex(w[at + 3])} → 다음 001f 는 +${j - at} (길이면 ${j - at + 1})`);
  console.log('끝 근처:', w.slice(j - 6, j + 3).map(hex).join(' '));
}
