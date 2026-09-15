/*
 * 브라우저를 안 열고 파서를 검증한다.
 *
 * site/src/engine.js 를 그대로 import 한다. 사본을 두면 둘이 조용히 어긋난다.
 *
 *   node test.mjs <hwp파일...>
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { openDocument as openHwp } from '../../src/scripts/engine.js';
const files = process.argv.slice(2);
let bad = 0;

for (const f of files) {
  const name = path.basename(f);
  try {
    const buf = fs.readFileSync(f);
    const doc = await openHwp(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));

    let tables = 0, cells = 0, blanks = 0, filled = 0;
    const walk = (paras) => {
      for (const p of paras)
        for (const t of p.tables) {
          if (!t) continue;
          tables++;
          for (const c of t.cells) {
            cells++;
            c.text.trim() ? filled++ : blanks++;
            walk(c.paras);              // 표 안의 표
          }
        }
    };
    walk(doc.blocks);

    console.log(
      `ok  ${name.slice(0, 40).padEnd(42)} v${doc.version}  ` +
      `레코드 ${String(doc.nRecords).padStart(5)}  표 ${String(tables).padStart(3)}  ` +
      `셀 ${String(cells).padStart(4)}  채워짐 ${String(filled).padStart(4)}  빈칸 ${String(blanks).padStart(4)}`
    );
    if (cells > 0 && blanks === 0) console.log(`      ※ 표는 있는데 빈칸이 0개다 — 채울 곳이 없는 문서이거나 셀 파싱이 틀렸다`);
  } catch (e) {
    const code = String(e.message).split(':')[0];
    const expected = ['HWPX', 'ENCRYPTED', 'DRM'].includes(code);
    console.log(`${expected ? '--' : '✗ '}  ${name.slice(0, 40).padEnd(42)} ${e.message}`);
    if (!expected) bad++;
  }
}

console.log(`\n${files.length}개 중 ${bad}개 실패`);
process.exit(bad ? 1 : 0);
