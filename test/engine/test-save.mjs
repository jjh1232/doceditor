/*
 * 저장 왕복 검증.
 *
 *   열기 → 고치기 → 저장 → **저장한 파일을 다시 열기** → 글자 확인
 *
 * 두 가지를 다 본다:
 *   1. 빈 칸 채우기      — PARA_TEXT 레코드를 새로 끼운다
 *   2. 글자 있는 칸 고치기 — 기존 PARA_TEXT 를 갈고, 글자 모양 목록을 정리한다
 *
 * 2번이 따로 있는 이유: 「‘ . . ~ ’ . . ( 년 월)」 같은 틀은 글자 모양이 둘 이상이라,
 * 글자 수가 바뀌면 뒤쪽 항목이 없는 위치를 가리키게 된다. 1번에는 그 경로가 없다.
 *
 * 여기를 통과해도 "한글이 연다" 는 증명이 아니다 — 그건 사람이 한 번 열어봐야 안다.
 * 다만 구조가 깨졌으면 여기서 걸린다. parseRecords 가 레코드 합과 스트림 길이가
 * 정확히 맞는지 보기 때문에, 한 바이트라도 어긋나면 다시 열 때 던진다.
 *
 *   node test-save.mjs <hwp파일...>
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
import { openDocument, saveDocument } from '../../src/scripts/engine.js';
/** 셀 안의 모든 문단을 모은다 — 화면이 문단마다 입력칸을 만드는 것과 같은 기준. */
function collectParas(doc) {
  const out = [];
  const walk = (paras) => {
    for (const p of paras)
      for (const t of p.tables) {
        if (!t) continue;
        for (const c of t.cells) {
          for (const para of c.paras) {
            if (para.tables.length) continue;   // 표를 품은 문단은 고칠 수 없다
            // 글자 속에 그림·각주 참조가 든 문단도 마찬가지다. 통째로 갈아치우면
            // 그 참조가 사라져 개체가 떨어져 나간다. 화면도 이 문단은 안 연다.
            if (para.hasCtrl) continue;
            // 서식 조각이 몇 개인지 — 여럿이면 고칠 때 정리가 필요한 문단이다.
            // hwp 는 PARA_CHAR_SHAPE 항목 수, hwpx 는 <hp:t> 조각 수가 같은 뜻이다.
            let shapes = 1;
            if (doc.kind === 'hwpx') {
              shapes = Math.max(1, para.textEls.length);
            } else {
              const recs = doc.sections[para.si].recs;
              const lv = recs[para.rec].level;
              for (let m = para.rec + 1; m < recs.length && recs[m].level > lv; m++)
                if (recs[m].level === lv + 1 && recs[m].tag === 68) { shapes = recs[m].data.length / 8; break; }
            }
            out.push({ para, text: para.text.replace(/\n+$/, ''), shapes });
          }
          walk(c.paras);
        }
      }
  };
  walk(doc.blocks);
  return out;
}

/** 저장한 바이트를 다시 열어 모든 셀 문단의 글자를 모은다. */
function textsOf(doc) {
  const out = [];
  (function walk(paras) {
    for (const p of paras)
      for (const t of p.tables) {
        if (!t) continue;
        for (const c of t.cells) {
          for (const para of c.paras) out.push(para.text.replace(/\n+$/, '').trim());
          walk(c.paras);
        }
      }
  })(doc.blocks);
  return out;
}

const FILL = ['홍길동', '洪吉童', '1994-03-12', '010-1234-5678', 'hong@example.com',
              '부산광역시 남구', '한국항만연수원', 'ABC 물류', '대리', '2020.03'];

let bad = 0;
for (const f of process.argv.slice(2)) {
  const name = path.basename(f).slice(0, 34);
  try {
    const buf = fs.readFileSync(f);
    const doc = await openDocument(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));

    const all = collectParas(doc);
    const empty = all.filter((x) => !x.text.trim());
    const filled = all.filter((x) => x.text.trim());
    const multi = filled.filter((x) => x.shapes > 1);      // 글자 모양이 여럿인 것

    const edits = [];
    // 1. 빈 칸 — 골고루 흩어 넣는다. 앞쪽만 채우면 레코드 삽입 위치 문제를 못 잡는다.
    const step = Math.max(1, Math.floor(empty.length / FILL.length));
    for (let i = 0; i < FILL.length && i * step < empty.length; i++)
      edits.push({ para: empty[i * step].para, text: FILL[i] });
    // 2. 글자 모양이 여럿인 칸을 우선으로 고쳐 본다 (없으면 아무 글자 있는 칸)
    for (const x of (multi.length ? multi : filled).slice(0, 4))
      edits.push({ para: x.para, text: '2024. 3. 1 ~ 2026. 2.28' });
    // 3. 체크 상자 — □ 를 ■ 로. 화면에서 체크하면 나가는 값과 같은 모양이다.
    const boxes = filled.filter((x) => x.text.includes('□') && !edits.some((e) => e.para === x.para));
    for (const x of boxes.slice(0, 2))
      edits.push({ para: x.para, text: x.text.replace('□', '■') });

    if (!edits.length) { console.log(`--  ${name.padEnd(36)} 고칠 문단이 없음 — 건너뜀`); continue; }

    const saved = await saveDocument(doc, edits);
    const re = await openDocument(saved.buffer.slice(0));       // 구조가 깨졌으면 여기서 던진다
    const got = textsOf(re);

    const missing = edits.filter((e) => !got.includes(e.text.trim()));
    // hwp 는 원본 자리에 덮어쓰므로 크기가 같아야 한다.
    // hwpx 는 zip 을 다시 묶으니 크기가 달라지는 게 정상이다.
    const sizeOk = doc.kind === 'hwpx' ? saved.length > 0 : saved.length === buf.length;

    if (missing.length || !sizeOk) {
      bad++;
      console.log(`✗   ${name.padEnd(36)} ${missing.length ? `못 찾은 값 ${missing.length}개: ${missing.map((m) => m.text).join(', ')}` : ''}${sizeOk ? '' : ` 크기 바뀜 ${buf.length}→${saved.length}`}`);
    } else {
      const size = doc.kind === 'hwpx' ? `${buf.length}→${saved.length}B` : '크기 동일';
      console.log(`ok  ${name.padEnd(36)} [${doc.kind}] 빈칸 ${String(empty.length).padStart(3)} · 글자칸 ${String(filled.length).padStart(3)} (조각여럿 ${String(multi.length).padStart(2)})  →  ${edits.length}곳 고쳐 저장 → 전부 확인  ${size}`);
    }
  } catch (e) {
    bad++;
    console.log(`✗   ${name.padEnd(36)} ${e.message}`);
  }
}
console.log(`\n${bad ? bad + '개 실패' : '전부 통과'}`);
process.exit(bad ? 1 : 0);
