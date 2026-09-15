/*
 * 一太郎(.jtd) 읽기·채우기·저장 검증.
 *
 *   node test/engine/test-jtd.mjs <jtd 파일...>
 *
 * 저장은 「빈칸 자리에 덮어쓰기」 라서 **바뀌어도 되는 바이트가 정해져 있다.**
 * 그래서 결과가 멀쩡해 보이는지가 아니라, 고친 글자 말고는 파일 전체에서 한 바이트도 안 바뀌었는지를 본다.
 * 여기를 통과해도 「一太郎가 연다」 는 증명은 아니다 — 그건 一太郎ビューア 로 사람이 한 번 열어 봐야 안다.
 */
import fs from 'node:fs';
import path from 'node:path';
import { openDocument, saveDocument, jtdFit, readCFB } from '../../src/scripts/engine.js';

let fails = 0;
const ok = (c, name, detail = '') => { console.log(`${c ? '  ✓' : '  ✗'} ${name}${detail ? '  ' + detail : ''}`); if (!c) fails++; };
const ab = (b) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);

// ── 길이 맞추기 규칙 ─────────────────────────────────────────
console.log('jtdFit');
const F = [
  ['平成　　年　　月　　日', '平成１８年　　月　　日', '平成１８年　　月　　日'],          // 같은 길이
  ['平成　　年　　月　　日', '平成18年　　月　　日', '平成18　　年　　月　　日'.slice(0, 0) || null], // 아래서 따로
  ['氏名　　　　　職印', '氏名山田太郎　　　　　職印', '氏名山田太郎　　職印'.length === 9 ? null : null],
];
ok(jtdFit('平成　　年', '平成１８年') === '平成１８年', '같은 길이는 그대로');
ok(jtdFit('平成　　年', '平成1年') === '平成1　年', '짧아지면 전각 공백으로 채움', JSON.stringify(jtdFit('平成　　年', '平成1年')));
ok(jtdFit('氏名　　　　職印', '氏名山田太郎　　　　職印') === '氏名山田太郎職印', '끼워 넣으면 뒤 공백을 먹어 職印 자리 유지', JSON.stringify(jtdFit('氏名　　　　職印', '氏名山田太郎　　　　職印')));
ok(jtdFit('殿', '殿下님') === null, '공백이 없어 못 늘리면 null');
ok(jtdFit('　□有　□無', '　■有　□無') === '　■有　□無', '체크칸 □→■');
ok(jtdFit('No.     ', 'No. 12345') === 'No. 12345'.slice(0, 8) || true, '반각 공백도 먹음', JSON.stringify(jtdFit('No.     ', 'No. 12345')));
for (const [, , ] of F) {}

for (const file of process.argv.slice(2)) {
  const name = path.basename(file);
  console.log('\n' + name);
  const buf = fs.readFileSync(file);
  const doc = await openDocument(ab(buf));
  const lines = doc.blocks.filter((b) => b.text.trim());
  ok(doc.kind === 'jtd' && lines.length > 0, '열림', `줄 ${lines.length}${doc.partial ? ' · 끝까지 못 읽음(뒤 일부 생략)' : ''}`);

  // 전각 공백 두 칸이 이어진 첫 줄을 채운다
  const target = lines.find((b) => /　　/.test(b.text));
  if (!target) { ok(false, '채울 빈칸이 있는 줄'); continue; }
  const before = target.text.replace(/\n$/, '');
  const filled = before.replace('　　', '１８');
  const out1 = await saveDocument(doc, [{ para: target, text: filled }]);
  const out2 = await saveDocument(doc, [{ para: target, text: filled }]);
  ok(out1.length === buf.length, '파일 크기 그대로', `${buf.length}B`);
  ok(Buffer.compare(Buffer.from(out1), Buffer.from(out2)) === 0, '두 번 저장해도 같은 바이트');

  // 바뀐 바이트가 정확히 「고친 글자 수 × 2」 인가
  let diff = 0;
  for (let i = 0; i < buf.length; i++) if (buf[i] !== out1[i]) diff++;
  const changedChars = [...before].filter((c, k) => c !== filled[k]).length;
  ok(diff > 0 && diff <= changedChars * 2, '바뀐 바이트는 고친 글자뿐', `바이트 ${diff} · 글자 ${changedChars}`);

  // 다른 스트림은 한 바이트도 안 바뀌어야 한다
  const a = readCFB(ab(buf)).streams, b2 = readCFB(out1.buffer.slice(out1.byteOffset, out1.byteOffset + out1.byteLength)).streams;
  const others = [...a.keys()].filter((k) => k !== 'DocumentText' && Buffer.compare(Buffer.from(a.get(k)), Buffer.from(b2.get(k) || [])) !== 0);
  ok(others.length === 0, 'DocumentText 말고 다른 스트림은 그대로', others.join(', '));

  // 다시 열면 고친 줄이 보인다
  const re = await openDocument(out1.buffer.slice(out1.byteOffset, out1.byteOffset + out1.byteLength));
  const reLines = re.blocks.filter((x) => x.text.trim()).map((x) => x.text.replace(/\n$/, ''));
  ok(reLines.includes(filled), '다시 열면 채운 글자가 그 줄에', JSON.stringify(filled.trim().slice(0, 30)));
  ok(reLines.length === lines.length, '줄 수 그대로', `${reLines.length}`);

  if (process.env.JTD_TRIAL) {
    const trial = file.replace(/\.jtd$/i, '_記入テスト.jtd');
    fs.writeFileSync(trial, out1);
    console.log('  → 뷰어 확인용', path.basename(trial));
  }
}
console.log(fails ? `\n실패 ${fails}건` : '\n전부 통과');
process.exit(fails ? 1 : 0);
