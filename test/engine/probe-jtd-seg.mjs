// DocumentText 안의 「xxxxV.01」 세그먼트 이름을 전부 찾고, 뒤 4워드(길이 후보)를 찍는다
import fs from 'node:fs';
import { readCFB } from '../../src/scripts/engine.js';
const hex = (w) => w.toString(16).padStart(4, '0');
for (const file of process.argv.slice(2)) {
  const b = fs.readFileSync(file);
  const d = readCFB(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)).streams.get('DocumentText');
  const w = []; for (let i = 0; i + 1 < d.length; i += 2) w.push((d[i] << 8) | d[i + 1]);
  const out = [];
  for (let i = 0; i + 6 < w.length; i++) {
    const s = String.fromCharCode(w[i] >> 8, w[i] & 255, w[i + 1] >> 8, w[i + 1] & 255, w[i + 2] >> 8, w[i + 2] & 255, w[i + 3] >> 8, w[i + 3] & 255);
    if (/^[A-Za-z]{4}V\.\d\d$/.test(s)) {
      const len32 = (w[i + 4] << 16 | w[i + 5]) >>> 0;
      out.push(`${s}@${i} len32=${len32} (끝=${i + 6 + len32})`);
    }
  }
  console.log(file.split(/[\\/]/).pop(), `총 ${w.length}워드`);
  out.forEach((x) => console.log('   ', x));
}
