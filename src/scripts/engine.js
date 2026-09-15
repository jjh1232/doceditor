/**
 * 양식 파일 엔진 — 읽기 · 고치기 · 저장. **화면(DOM)을 모른다.**
 *
 * hwp(5.0, CFB) · hwpx(zip+XML) · 一太郎(.jtd, CFB — 판별만) 을 다룬다.
 * 화면은 src/main.js, 문구는 src/i18n.js 가 맡는다. 여기에는 사람이 읽을 문구를 두지 않는다 —
 * 오류는 코드('TOO_BIG' 등)로만 던지고 언어는 화면이 고른다.
 *
 * 원본은 이 파일 하나다. 예전 프로토타입(hwpform-prototype/index.html)에서 2026-09-15 옮겨 왔고,
 * 테스트(test/engine/*.mjs)도 이 파일을 직접 import 한다. 사본을 두면 조용히 어긋난다.
 * 포맷 실측 기록은 docs/포맷.md.
 */

'use strict';
/* ─────────────────────────────────────────────────────────────────────
 * HWP 5.0 읽기. 라이브러리 0 — 압축 해제는 브라우저 내장 DecompressionStream.
 * 파일은 이 페이지 밖으로 나가지 않는다. fetch·XHR·form 전송이 이 파일에 없다.
 * ES 모듈로 안 쪼갠 이유: file:// 더블클릭으로 열려야 해서. (모듈은 CORS 로 막힌다)
 * ───────────────────────────────────────────────────────────────────── */

const hwpToPx = (v) => (v / 7200) * 96;

/*
 * 압축 해제.
 *
 * CFB 안의 스트림은 할당 단위에 맞춰 패딩되어 있어서 deflate 데이터가 끝난 뒤에도
 * 바이트가 남는다. Node 의 inflateRawSync 는 그걸 조용히 무시하지만
 * DecompressionStream 은 "Trailing junk" 로 던진다 — 그래서 한 번에 받지 않고
 * 청크로 모으다가, 다 받은 뒤에 나는 그 오류만 넘긴다.
 *
 * 이렇게 하면 진짜로 깨진 파일도 조용히 통과할 것 같지만 그렇지 않다 —
 * 뒤의 parseRecords 가 "레코드가 스트림 길이와 정확히 맞는가" 를 보고 던진다.
 * 잘려서 나온 결과는 거기서 걸린다.
 */
async function inflateRaw(bytes) {
  const ds = new DecompressionStream('deflate-raw');
  const w = ds.writable.getWriter();
  // 패딩 오류는 읽는 쪽·쓰는 쪽 양쪽으로 퍼진다. 세 군데를 다 받아 두지 않으면
  // 잡히지 않은 거부(unhandled rejection)로 새어 나가 페이지가 죽는다.
  const hush = () => {};
  w.closed.catch(hush);
  w.write(bytes).catch(hush);
  w.close().catch(hush);
  const reader = ds.readable.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.length;
    }
  } catch (e) {
    if (!chunks.length) throw e;   // 한 바이트도 못 풀었으면 진짜 실패다
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

/* OLE 복합문서. .hwp 는 옛날 .doc 과 같은 컨테이너다. */
function readCFB(buf) {
  const dv = new DataView(buf), u8 = new Uint8Array(buf);
  const SIG = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
  if (!SIG.every((b, i) => u8[i] === b))
    throw new Error(u8[0] === 0x50 && u8[1] === 0x4b ? 'HWPX' : 'NOT_HWP');

  const SEC = 1 << dv.getUint16(0x1e, true), MINI = 1 << dv.getUint16(0x20, true);
  const CUTOFF = dv.getUint32(0x38, true);
  const off = (s) => SEC + s * SEC;

  const nFat = dv.getUint32(0x2c, true), difat = [];
  for (let i = 0; i < 109 && difat.length < nFat; i++) {
    const s = dv.getUint32(0x4c + i * 4, true);
    if (s <= 0xfffffffa) difat.push(s);
  }
  let ds = dv.getUint32(0x44, true), nDs = dv.getUint32(0x48, true);
  while (nDs-- > 0 && ds <= 0xfffffffa) {
    const base = off(ds);
    for (let i = 0; i < SEC / 4 - 1; i++) {
      const s = dv.getUint32(base + i * 4, true);
      if (s <= 0xfffffffa) difat.push(s);
    }
    ds = dv.getUint32(base + SEC - 4, true);
  }
  const FAT = [];
  for (const s of difat) for (let i = 0; i < SEC / 4; i++) FAT.push(dv.getUint32(off(s) + i * 4, true));

  const chain = (start, fat) => {
    const out = [];
    for (let s = start; s <= 0xfffffffa && out.length < 200000; s = fat[s]) out.push(s);
    return out;
  };
  const cat = (parts, size) => {
    const out = new Uint8Array(size);
    let o = 0;
    for (const p of parts) {
      const n = Math.min(p.length, size - o);
      out.set(p.subarray(0, n), o); o += n;
      if (o >= size) break;
    }
    return out;
  };
  const readChain = (s, size) => cat(chain(s, FAT).map((x) => u8.subarray(off(x), off(x) + SEC)), size);

  const MFAT = [];
  for (const s of chain(dv.getUint32(0x3c, true), FAT))
    for (let i = 0; i < SEC / 4; i++) MFAT.push(dv.getUint32(off(s) + i * 4, true));

  const dir = [];
  const dirSectors = chain(dv.getUint32(0x30, true), FAT);
  for (const s of dirSectors)
    for (let i = 0; i < SEC / 128; i++) {
      const b = off(s) + i * 128, nl = dv.getUint16(b + 64, true);
      if (!nl) { dir.push(null); continue; }
      let name = '';
      for (let k = 0; k < nl - 2; k += 2) name += String.fromCharCode(dv.getUint16(b + k, true));
      dir.push({ name, type: u8[b + 66], left: dv.getUint32(b + 68, true), right: dv.getUint32(b + 72, true),
                 child: dv.getUint32(b + 76, true), start: dv.getUint32(b + 116, true),
                 size: Number(dv.getBigUint64(b + 120, true)) });
    }

  const root = dir[0];
  const mini = readChain(root.start, root.size);
  const readMini = (s, size) => cat(chain(s, MFAT).map((x) => mini.subarray(x * MINI, x * MINI + MINI)), size);

  // 스트림 내용과 함께 **어느 섹터에 들어 있는지**도 돌려준다.
  // 저장할 때 컨테이너를 다시 짓지 않고 그 자리에 덮어쓰기 위해서다 (saveHwp 참고).
  const streams = new Map(), chains = new Map();
  (function walk(id, path) {
    if (id > 0xfffffffa || !dir[id]) return;
    const e = dir[id];
    walk(e.left, path);
    const p = path + e.name;
    if (e.type === 2) {
      const isMini = e.size < CUTOFF;
      streams.set(p, isMini ? readMini(e.start, e.size) : readChain(e.start, e.size));
      // 미니 스트림은 64바이트 조각이고, 그 조각들은 다시 루트 스트림 안에 들어 있다.
      // 그래서 저장하려면 미니 조각 목록과 루트의 섹터 목록이 둘 다 필요하다.
      chains.set(p, { isMini, sectors: chain(e.start, isMini ? MFAT : FAT), size: e.size });
    }
    if (e.type === 1) walk(e.child, p + '/');
    walk(e.right, path);
  })(root.child, '');
  // FAT·디렉터리도 같이 돌려준다. 그림을 넣을 때 스트림을 새로 붙여야 하는데,
  // 그러려면 빈 FAT 칸과 빈 디렉터리 슬롯이 어디인지 알아야 한다 (addCfbStream 참고).
  return { streams, chains, SEC, MINI, CUTOFF, FAT, dir, dirSectors,
           rootChain: chain(root.start, FAT), sectorAt: off };
}

const TAG = { PARA_HEADER: 66, PARA_TEXT: 67, PARA_CHAR_SHAPE: 68, CTRL_HEADER: 71, LIST_HEADER: 72, TABLE: 77 };

function parseRecords(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), recs = [];
  let i = 0;
  while (i + 4 <= bytes.length) {
    const h = dv.getUint32(i, true); i += 4;
    const tag = h & 0x3ff, level = (h >> 10) & 0x3ff;
    let size = (h >>> 20) & 0xfff, ext = false;
    if (size === 0xfff) { size = dv.getUint32(i, true); i += 4; ext = true; }
    recs.push({ tag, level, size, ext, data: bytes.subarray(i, i + size) });
    i += size;
  }
  // 남은 바이트가 있으면 구조를 잘못 읽은 것이다. 조용히 넘기면 안 된다.
  if (i !== bytes.length) throw new Error('BAD_RECORDS:' + i + '/' + bytes.length);
  return recs;
}

/* 제어문자는 8 WCHAR 를 먹는다. 이걸 틀리면 뒤 글자가 전부 밀린다. */
const WIDE = new Set([1,2,3,4,5,6,7,8,9,11,12,14,15,16,17,18,19,20,21,22,23]);

function paraText(d) {
  const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
  let s = '';
  for (let i = 0; i + 1 < d.length; ) {
    const c = dv.getUint16(i, true);
    if (WIDE.has(c)) { i += 16; continue; }
    if (c === 13 || c === 10) { s += '\n'; i += 2; continue; }
    if (c < 32) { i += 2; continue; }
    s += String.fromCharCode(c); i += 2;
  }
  return s;
}

/**
 * 확장 제어문자(표·그림·각주 따위를 가리키는 8 WCHAR)가 글자 속에 있나.
 *
 * 그런 문단은 **글자를 갈아치우면 안 된다.** PARA_TEXT 를 통째로 새로 쓰면
 * 그 참조가 사라지고 가리키던 개체가 떨어져 나간다. 화면에는 아무 표시가 없다.
 */
function hasCtrlChar(d) {
  const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
  for (let i = 0; i + 1 < d.length; i += 2) if (WIDE.has(dv.getUint16(i, true))) return true;
  return false;
}

function childrenOf(recs, idx) {
  const lv = recs[idx].level, out = [];
  for (let i = idx + 1; i < recs.length && recs[i].level > lv; i++)
    if (recs[i].level === lv + 1) out.push(i);
  return out;
}

function readParagraph(recs, idx, si) {
  // si = 몇 번째 Section 인가. 저장할 때 이 문단이 어느 스트림에 속하는지 알아야 한다.
  const para = { si, rec: idx, text: '', textRec: -1, tables: [], pics: [],
                 // 화면에 실제 글자 크기·줄간격으로 그리려면 이 번호가 필요하다
                 paraId: gU16(recs[idx].data, 8), charId: 0 };
  for (const k of childrenOf(recs, idx)) {
    const r = recs[k];
    if (r.tag === TAG.PARA_TEXT) {
      para.text = paraText(r.data); para.textRec = k; para.hasCtrl = hasCtrlChar(r.data);
    }
    if (r.tag === TAG.PARA_CHAR_SHAPE && r.data.length >= 8) para.charId = gU32(r.data, 4);
    if (r.tag === TAG.CTRL_HEADER) {
      const id = String.fromCharCode.apply(null, r.data.subarray(0, 4)).split('').reverse().join('');
      if (id === 'tbl ') para.tables.push(readTable(recs, k, si));
      if (id === 'gso ') { const pic = readPicture(recs, k); if (pic) para.pics.push(pic); }
    }
  }
  return para;
}

/**
 * 이미 들어 있는 그림 하나를 읽는다.
 *
 * 그림은 gso 의 **손자**다 (gso → SHAPE_COMPONENT → SHAPE_COMPONENT_PICTURE).
 * 직계 자식만 보면 못 찾는다. BinItem ID 는 91바이트 중 71번지, 정렬이 안 맞는 자리다.
 */
function readPicture(recs, ctrlIdx) {
  const lv = recs[ctrlIdx].level;
  for (let i = ctrlIdx + 1; i < recs.length && recs[i].level > lv; i++) {
    if (recs[i].tag !== 85) continue;
    const c = recs[ctrlIdx].data, d = recs[i].data;
    if (d.length < 73) return null;
    const dv = new DataView(c.buffer, c.byteOffset, c.byteLength);
    return { binId: d[71] | (d[72] << 8), w: dv.getUint32(16, true), h: dv.getUint32(20, true) };
  }
  return null;
}

/* 셀의 문단은 LIST_HEADER 의 자식이 아니라 **뒤따르는 형제** 다.
 * LIST_HEADER 가 "내 문단은 N개" 라고 적어 두고 그 수만큼 가져간다.
 * 자식으로 착각하면 표가 통째로 비어 보인다. */
function readTable(recs, ctrlIdx, si) {
  const kids = childrenOf(recs, ctrlIdx);
  const tRec = kids.find((k) => recs[k].tag === TAG.TABLE);
  if (tRec === undefined) return null;
  const d = recs[tRec].data, dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
  const table = { rows: dv.getUint16(4, true), cols: dv.getUint16(6, true), cells: [] };

  for (let n = 0; n < kids.length; n++) {
    if (recs[kids[n]].tag !== TAG.LIST_HEADER) continue;
    const c = recs[kids[n]].data, cv = new DataView(c.buffer, c.byteOffset, c.byteLength);
    const nParas = cv.getInt32(0, true);
    const cell = {
      col: cv.getUint16(8, true), row: cv.getUint16(10, true),
      colSpan: cv.getUint16(12, true) || 1, rowSpan: cv.getUint16(14, true) || 1,
      width: cv.getUint32(16, true), height: cv.getUint32(20, true), paras: [],
    };
    let taken = 0;
    for (let m = n + 1; m < kids.length && taken < nParas; m++) {
      if (recs[kids[m]].tag !== TAG.PARA_HEADER) break;
      cell.paras.push(readParagraph(recs, kids[m], si));
      taken++; n = m;
    }
    cell.text = cell.paras.map((p) => p.text).join('\n').replace(/\s+$/, '');
    table.cells.push(cell);
  }
  return table;
}

async function openHwp(buf) {
  const cfb = readCFB(buf);
  const { streams, chains, SEC, MINI, CUTOFF, rootChain } = cfb;
  const fh = streams.get('FileHeader');
  if (!fh) throw new Error('NOT_HWP');
  const fdv = new DataView(fh.buffer, fh.byteOffset, fh.byteLength);
  const version = fdv.getUint32(32, true), flags = fdv.getUint32(36, true);
  // 암호·DRM 은 여기서 멈춘다. 뚫으려 하지 않는다.
  if (flags & 0b10) throw new Error('ENCRYPTED');
  if (flags & 0b10000) throw new Error('DRM');

  const sections = [];
  for (let i = 0; ; i++) {
    const path = 'BodyText/Section' + i;
    const raw = streams.get(path);
    if (!raw) break;
    const bytes = (flags & 1) ? await inflateRaw(raw) : raw;
    sections.push({ path, bytes, recs: parseRecords(bytes), chain: chains.get(path) });
  }
  if (!sections.length) throw new Error('NO_BODY');

  // DocInfo 는 화면에 안 쓰지만 그림을 넣을 때 고쳐야 한다 —
  // 「이런 그림이 있다」 를 여기 등록하지 않으면 한글이 그림을 못 찾는다.
  let docInfo = null;
  const diRaw = streams.get('DocInfo');
  if (diRaw) {
    const diBytes = (flags & 1) ? await inflateRaw(diRaw) : diRaw;
    docInfo = { bytes: diBytes, recs: parseRecords(diBytes), chain: chains.get('DocInfo') };
  }

  /* 통 안의 그림을 번호로 찾을 수 있게 꺼내 둔다.
   * 속성 하위 4비트가 압축 여부를 정한다 — png 는 대개 그대로, jpg 는 눌려 있다. */
  const bins = new Map();
  if (docInfo) {
    let n = 0;
    for (const r of docInfo.recs) {
      if (r.tag !== 18) continue;
      const id = r.data[2] | (r.data[3] << 8);
      let ext = '';
      for (let i = 0; i < (r.data[4] | (r.data[5] << 8)); i++)
        ext += String.fromCharCode(r.data[6 + i * 2] | (r.data[7 + i * 2] << 8));
      const packed = ((r.data[0] | (r.data[1] << 8)) >> 4 & 3) === 0 && (flags & 1);
      const raw = streams.get('BinData/BIN' + String(id).padStart(4, '0') + '.' + ext);
      // 화면 그리기는 동기라 여기서 풀어 둔다. 못 풀면 그 그림만 조용히 건너뛴다 —
      // 망가진 그림 하나 때문에 문서 전체가 안 열리면 안 된다.
      if (raw) {
        try { bins.set(id, { bytes: packed ? await inflateRaw(raw) : raw, ext }); } catch {}
      }
      n++;
    }
  }

  /* 글자 크기와 줄간격 표. 화면을 원본에 가깝게 그리고,
   * 「11pt 로 바꿈」 이 눈에 보이게 하려면 지금 값을 알아야 한다.
   * CHAR_SHAPE 42번지 = 1/100 pt · PARA_SHAPE 24번지 = % (실측) */
  /* 정렬도 같이 읽는다. PARA_SHAPE 0번지 속성1 의 2-4번 비트
   * (0 양쪽 · 1 왼쪽 · 2 오른쪽 · 3 가운데 · 4 배분 · 5 나눔).
   * 「지원자 :    (서명)」 줄이 **오른쪽 정렬**이라 화면이 왼쪽으로 그리면
   * 서명을 놓은 자리가 파일에서 이름 위로 떨어졌다 (2026-09-14). */
  const charPt = [], linePct = [], paraAlign = [];
  if (docInfo) {
    for (const r of docInfo.recs) {
      if (r.tag === 21 && r.data.length > 46)
        charPt.push(new DataView(r.data.buffer, r.data.byteOffset, r.data.byteLength).getInt32(42, true) / 100);
      if (r.tag === 25 && r.data.length > 28) {
        const v = new DataView(r.data.buffer, r.data.byteOffset, r.data.byteLength);
        linePct.push(v.getInt32(24, true));
        paraAlign.push((v.getUint32(0, true) >>> 2) & 7);
      }
    }
  }

  const blocks = [];
  for (let si = 0; si < sections.length; si++)
    for (let i = 0; i < sections[si].recs.length; i++)
      if (sections[si].recs[i].tag === TAG.PARA_HEADER && sections[si].recs[i].level === 0)
        blocks.push(readParagraph(sections[si].recs, i, si));

  return {
    version: [24, 16, 8, 0].map((s) => (version >>> s) & 255).join('.'),
    flags, blocks, sections, buf, docInfo, bins, charPt, linePct, paraAlign,
    layout: { SEC, MINI, CUTOFF, rootChain, cfb },
    compressed: !!(flags & 1),
    nSections: sections.length,
    nRecords: sections.reduce((a, s) => a + s.recs.length, 0),
  };
}

/* ─── 저장 ───────────────────────────────────────────────────────────
 * 컨테이너를 다시 짓지 않는다. 원본 파일을 복사해 두고 BodyText 스트림이
 * 들어 있던 **그 섹터에 그대로 덮어쓴다.**
 *
 * 그래서 새 압축본이 원래 스트림 크기보다 크면 저장을 거부한다. 실제로는
 * 거의 안 걸린다 — 원본을 만든 압축기보다 브라우저 쪽이 잘 줄이기 때문이다.
 * (자사양식 기준 7507B → 5000B 남짓)
 *
 * 왜 이렇게 하나: CFB 를 다시 짜면 FAT·miniFAT·디렉터리·DIFAT 을 전부 새로
 * 배치해야 하고, 거기서 한 군데만 틀려도 한글이 파일을 아예 못 연다.
 * 원본 구조를 한 바이트도 안 건드리는 쪽이 훨씬 안전하다.
 *
 * 남는 패딩은 문제가 안 된다 — 원본 파일도 이미 그렇게 되어 있다.
 * (그래서 DecompressionStream 이 "Trailing junk" 를 냈던 것이다)
 */

async function deflateRaw(bytes) {
  const cs = new CompressionStream('deflate-raw');
  const s = new Blob([bytes]).stream().pipeThrough(cs);
  return new Uint8Array(await new Response(s).arrayBuffer());
}

/** 레코드 배열을 다시 바이트로. 읽을 때와 정확히 대칭이어야 한다. */
function serializeRecords(recs) {
  let total = 0;
  for (const r of recs) total += (r.size >= 0xfff || r.ext ? 8 : 4) + r.data.length;
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  let o = 0;
  for (const r of recs) {
    const size = r.data.length;
    const big = size >= 0xfff;
    dv.setUint32(o, (r.tag & 0x3ff) | ((r.level & 0x3ff) << 10) | (((big ? 0xfff : size) & 0xfff) << 20), true);
    o += 4;
    if (big) { dv.setUint32(o, size, true); o += 4; }
    out.set(r.data, o);
    o += size;
  }
  return out.subarray(0, o);
}

/**
 * 문단 머리를 **사본으로 바꿔 놓고** 그 뷰를 돌려준다.
 *
 * 레코드의 data 는 원본 스트림을 가리키는 뷰라서, 거기 직접 쓰면 화면이 들고 있는
 * 문서 모델까지 같이 바뀐다. 글자 수처럼 **더하고 빼는 값**은 그러면 저장을 두 번
 * 누를 때 두 번 더해진다 — 파일은 열리는데 글자 수만 어긋난 채로 나간다.
 * 실제로 두 번째 저장부터 깨졌다.
 */
function ownHeader(recs, idx) {
  const r = recs[idx];
  const data = r.data.slice();
  recs[idx] = { ...r, data };
  return new DataView(data.buffer, data.byteOffset, data.byteLength);
}

/** 문단 하나의 글자를 갈아끼운다. 원본 레코드 배열을 직접 고친다. */
function setParagraphText(recs, para, text) {
  // 표를 품은 문단의 PARA_TEXT 에는 그 표를 가리키는 제어문자가 들어 있다.
  // 통째로 갈아치우면 표가 떨어져 나가므로 아예 막는다.
  if (para.tables.length) throw new Error('PARA_HAS_TABLE');
  // 표 말고도 각주·그림 같은 게 글자 속 참조로 들어 있을 수 있다. 같은 이유로 막는다.
  if (para.hasCtrl) throw new Error('PARA_HAS_CTRL');
  const units = [];
  for (const ch of text) {
    const s = String(ch);
    for (let i = 0; i < s.length; i++) units.push(s.charCodeAt(i));
  }
  units.push(13);                                    // 문단 끝 줄바꿈. 원본도 이렇게 들어 있다

  const data = new Uint8Array(units.length * 2);
  const dv = new DataView(data.buffer);
  units.forEach((u, i) => dv.setUint16(i * 2, u, true));

  const hv = ownHeader(recs, para.rec);
  const hdr = recs[para.rec];
  // 최상위 비트는 글자 수가 아니라 별개 플래그다. 뜻을 모르므로 그대로 보존한다.
  const flag = hv.getUint32(0, true) & 0x80000000;
  hv.setUint32(0, flag | units.length, true);

  /*
   * 글자 모양은 "몇 번째 글자부터 어떤 서식" 목록이다(8바이트씩: 위치, 모양ID).
   * 글자 수가 줄면 뒤쪽 항목이 **존재하지 않는 위치**를 가리키게 된다.
   * 빈 칸은 모양이 하나뿐이라 이 문제가 없지만, 「‘ . . ~ ’ . . ( 년 월)」 같은
   * 템플릿 칸은 둘 이상이다. 새 길이 안에 드는 것만 남기고 헤더의 개수도 맞춘다.
   */
  for (let m = para.rec + 1; m < recs.length && recs[m].level > hdr.level; m++) {
    if (recs[m].level !== hdr.level + 1 || recs[m].tag !== TAG.PARA_CHAR_SHAPE) continue;
    const d = recs[m].data;
    const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
    const keep = [];
    for (let i = 0; i + 8 <= d.length; i += 8) {
      const pos = dv.getUint32(i, true), id = dv.getUint32(i + 4, true);
      if (keep.length === 0) keep.push([0, id]);          // 첫 항목은 항상 0번 글자부터
      else if (pos < units.length) keep.push([pos, id]);
    }
    const nd = new Uint8Array(keep.length * 8);
    const ndv = new DataView(nd.buffer);
    keep.forEach(([pos, id], i) => { ndv.setUint32(i * 8, pos, true); ndv.setUint32(i * 8 + 4, id, true); });
    recs[m] = { ...recs[m], data: nd, size: nd.length };
    hv.setUint16(12, keep.length, true);                  // PARA_HEADER 의 글자모양 수
    break;
  }

  if (para.textRec >= 0) {
    recs[para.textRec] = { ...recs[para.textRec], data, size: data.length };
    return;
  }
  // 빈 문단에는 PARA_TEXT 가 아예 없다. PARA_HEADER 바로 뒤에 새로 끼운다.
  recs.splice(para.rec + 1, 0, {
    tag: TAG.PARA_TEXT, level: hdr.level + 1, size: data.length, ext: false, data,
  });
}

/**
 * 채운 값을 반영한 새 파일 바이트를 만든다.
 * edits: [{ para, text }]
 */
async function saveHwp(doc, edits, pictures = [], formats = [], removes = []) {
  if (!doc.compressed) throw new Error('UNCOMPRESSED');   // 이 경로는 안 만들어 봤다

  const { SEC, MINI, rootChain } = doc.layout;
  const at = (s) => SEC + s * SEC;                        // CFB v3: 헤더 512B 뒤부터 섹터 0

  /** 압축본을 원래 스트림이 있던 그 자리에 써넣는다. 넘치면 거부한다. */
  const writeInPlace = (out, chain, packed, what) => {
    const { sectors, size, isMini } = chain;
    if (packed.length > size) throw new Error('TOO_BIG:' + what + ' ' + packed.length + '>' + size);

    // 원래 크기만큼 0 으로 채워 넣는다 — 디렉터리의 스트림 크기를 안 건드리기 위해서다.
    const padded = new Uint8Array(size);
    padded.set(packed, 0);

    if (!isMini) {
      for (let i = 0; i < sectors.length; i++) {
        const from = i * SEC;
        if (from >= padded.length) break;
        out.set(padded.subarray(from, Math.min(from + SEC, padded.length)), at(sectors[i]));
      }
    } else {
      // 미니 조각 하나는 루트 스트림 안의 어느 위치다. MINI(64)가 SEC(512)를 나누어
      // 떨어지므로 한 조각이 두 섹터에 걸치는 일은 없다 — 그래서 자를 필요가 없다.
      for (let i = 0; i < sectors.length; i++) {
        const from = i * MINI;
        if (from >= padded.length) break;
        const posInRoot = sectors[i] * MINI;
        const rootSec = rootChain[Math.floor(posInRoot / SEC)];
        if (rootSec === undefined) throw new Error('MINI_OVERFLOW');
        out.set(padded.subarray(from, Math.min(from + MINI, padded.length)), at(rootSec) + (posInRoot % SEC));
      }
    }
  };

  let out = new Uint8Array(doc.buf.slice(0));             // 원본 복사본에 덮어쓴다

  /* 그림은 DocInfo 등록이 먼저다 — 거기서 받은 번호를 본문에 적어야 한다.
   * 모델을 직접 고치지 않고 사본으로 한다. 저장이 실패해도 화면이 안 더러워진다. */
  const ids = new Map(), shapes = new Map();
  if (pictures.length || formats.length) {
    if (!doc.docInfo) throw new Error('NO_DOCINFO');
    const di = { recs: doc.docInfo.recs.slice() };
    for (const p of pictures) ids.set(p, addBinData(di, p.ext));

    // 같은 값을 여러 문단에 주면 레코드를 하나만 만들어 돌려 쓴다.
    const cache = new Map();
    const once = (key, make) => {
      if (!cache.has(key)) cache.set(key, make());
      return cache.get(key);
    };
    for (const f of formats) {
      const cur = shapeIdsOf(doc.sections[f.para.si].recs, f.para);
      shapes.set(f, {
        charId: f.sizePt == null ? null
          : once('c' + cur.charId + ':' + f.sizePt, () => newCharShape(di, cur.charId, f.sizePt)),
        paraId: f.linePct == null ? null
          : once('p' + cur.paraId + ':' + f.linePct, () => newParaShape(di, cur.paraId, f.linePct)),
      });
    }
    writeInPlace(out, doc.docInfo.chain, await deflateRaw(serializeRecords(di.recs)), 'DocInfo');
  }

  /* 글자 고치기와 그림 끼우기를 한 줄에 세운다. 둘 다 레코드를 끼울 수 있어서
   * 인덱스가 밀린다 — 그래서 **뒤에서 앞으로** 한꺼번에 처리해야 한다.
   * 따로 돌리면 뒤쪽 작업이 엉뚱한 레코드를 잡는다. */
  const bySection = new Map();
  const push = (si, rec, run) => {
    if (!bySection.has(si)) bySection.set(si, []);
    bySection.get(si).push({ rec, run });
  };
  for (const e of edits) push(e.para.si, e.para.rec, (recs) => setParagraphText(recs, e.para, e.text));
  // 빼기가 먼저다. 넣기가 먼저 돌면 para.textRec 가 낡은 값이 되어 엉뚱한 데를 자른다.
  for (const r of removes)
    push(r.para.si, r.para.rec, (recs) => removePicture(recs, r.para, r.binId));
  for (const p of pictures)
    push(p.para.si, p.para.rec,
         (recs) => insertPicture(recs, p.para, ids.get(p), p.w, p.h, p.pxW, p.pxH,
                                 p.at || 0, p.attr, p.offX || 0, p.offY || 0));
  for (const f of formats)
    push(f.para.si, f.para.rec,
         (recs) => applyShapes(recs, f.para, shapes.get(f).charId, shapes.get(f).paraId));

  for (const [si, ops] of bySection) {
    const sec = doc.sections[si];
    const recs = sec.recs.slice();
    for (const op of ops.sort((a, b) => b.rec - a.rec)) op.run(recs);
    writeInPlace(out, sec.chain, await deflateRaw(serializeRecords(recs)), 'Section' + si);
  }

  /* 이미지 바이트만 통에 새로 붙인다. 여기서만 파일이 커진다. */
  for (const p of pictures)
    out = cfbAddStream(out, 'BinData',
                       'BIN' + String(ids.get(p)).padStart(4, '0') + '.' + p.ext, p.bytes);

  return out;
}

/* ─── 그림 넣기 ───────────────────────────────────────────────────────
 * 지금까지는 **있는 값을 고쳤다.** 모르는 건 안 건드리면 됐다.
 * 그림은 **없던 것을 짓는다.** 배치를 틀리면 한글이 파일을 아예 못 연다.
 *
 * 그래서 짐작으로 쓰지 않았다. 아래 숫자는 전부 `probe-image.mjs` 로 실제 파일
 * 넷을 뜯어 잰 값이다. 자리표는 README 「그림 — 2026-09-13 실측」 에 있다.
 *
 * 그림 하나가 세 군데에 나뉘어 들어가고, 셋이 서로를 가리킨다.
 *
 *   BinData/BIN000N.jpg      통 안의 새 스트림 — 이미지 바이트
 *   DocInfo  BIN_DATA        "이런 그림이 있다" + ID_MAPPINGS 개수
 *   BodyText gso 3층         본문 어디에 얼마나 크게
 *
 * 하나라도 빠지면 그림이 안 보이거나 파일이 안 열린다.
 * ─────────────────────────────────────────────────────────────────── */

const GSO_ID = [0x20, 0x6f, 0x73, 0x67];   // 'gso ' — 파일에는 뒤집혀 들어간다
const PIC_ID = [0x63, 0x69, 0x70, 0x24];   // '$pic'
const CROP_PER_PX = 75;                    // 자르기 단위 = 7200/96, 96dpi 기준 HWPUNIT
/*
 * 개체 공통 속성. 표본(0x040a6000)에 「글자처럼 취급」 비트(0번)를 켠 값이다.
 * 글자 하나처럼 줄 안에 흘러 들어가므로 옆 글자를 밀어낸다.
 *
 * 서명처럼 **글자 위에 겹쳐야** 하는 경우의 값은 아직 모른다 —
 * 가진 표본이 전부 같은 배치라 실측이 없다. `probe-anchor.mjs` 가
 * 후보를 한 파일에 다 넣어 주는 실험용이다. 눈으로 확인되면 여기를 바꾼다.
 */
const PIC_ATTR = 0x040a6001;
/*
 * 서명처럼 **글 앞으로** 떠서 글자를 덮는 값. 규격(HWP 5.0 개체 공통 속성)으로 짰다.
 *
 *   bit 0      글자처럼 취급          0
 *   bit 3-4    세로 기준             2 = 문단   ┐ 표본값 0x040a2210 과 같다
 *   bit 8-9    가로 기준             2 = 단     ┘
 *   bit 14     다른 개체와 겹침 허용   1
 *   bit 21-23  본문과의 배치          3 = 글 앞으로   ★
 *
 * 처음 실험(probe-anchor 첫판)은 18-20번을 돌려서 전부 「어울림」 이었다 —
 * 18-19 는 높이 기준, 20 은 크기 보호다. 배치는 21-23 이다.
 * 위치는 CTRL_HEADER 8번지(세로)·12번지(가로) 오프셋으로 준다. 음수도 된다.
 */
const PIC_ATTR_FRONT = (0x040a2210 | 1 << 14 | 3 << 21) >>> 0;   // 0x046a6210
const FREESECT = 0xffffffff, ENDOFCHAIN = 0xfffffffe, NOSTREAM = 0xffffffff;

const gU16 = (u, o) => u[o] | (u[o + 1] << 8);
const gU32 = (u, o) => (u[o] | (u[o + 1] << 8) | (u[o + 2] << 16) | (u[o + 3] << 24)) >>> 0;
const sU16 = (u, o, v) => { u[o] = v & 255; u[o + 1] = (v >>> 8) & 255; };
const sU32 = (u, o, v) => { u[o] = v & 255; u[o + 1] = (v >>> 8) & 255; u[o + 2] = (v >>> 16) & 255; u[o + 3] = (v >>> 24) & 255; };
const sF64 = (u, o, v) => new DataView(u.buffer, u.byteOffset, u.byteLength).setFloat64(o, v, true);

/**
 * 통에 스트림을 새로 붙인다.
 *
 * **통을 다시 짓지 않는다.** 비어 있는 FAT 칸과 디렉터리 슬롯을 찾아 쓰고,
 * 모자란 만큼만 파일 뒤에 섹터를 덧붙인다. 기존 바이트는 하나도 안 건드린다 —
 * BodyText 를 제자리에 덮어쓰는 것과 같은 원칙이다.
 *
 * 못 하는 두 가지는 조용히 넘기지 않고 던진다:
 *   PIC_TOO_SMALL   4096B 미만은 미니 스트림에 들어가야 하는데 그 경로는 안 만들었다
 *   NEED_FAT_SECTOR FAT 을 늘려야 한다 (DIFAT 까지 손대야 하는 경우)
 */
function cfbAddStream(src, storageName, streamName, data) {
  const SEC = 1 << gU16(src, 0x1e);
  const CUTOFF = gU32(src, 0x38);
  const SLOTS = SEC / 128;                      // 섹터 하나에 들어가는 디렉터리 항목 수
  if (data.length < CUTOFF) throw new Error('PIC_TOO_SMALL:' + data.length);
  const at = (s) => SEC + s * SEC;

  /* FAT 을 읽되 **어느 섹터에 들어 있는지** 도 같이 기억한다. 되써야 하기 때문이다. */
  const nFat = gU32(src, 0x2c), fatSecs = [];
  for (let i = 0; i < 109 && fatSecs.length < nFat; i++) {
    const s = gU32(src, 0x4c + i * 4);
    if (s <= 0xfffffffa) fatSecs.push(s);
  }
  let ds = gU32(src, 0x44), nDs = gU32(src, 0x48);
  while (nDs-- > 0 && ds <= 0xfffffffa) {
    const base = at(ds);
    for (let i = 0; i < SEC / 4 - 1; i++) {
      const s = gU32(src, base + i * 4);
      if (s <= 0xfffffffa) fatSecs.push(s);
    }
    ds = gU32(src, base + SEC - 4);
  }
  const FAT = [];
  for (const s of fatSecs) for (let i = 0; i < SEC / 4; i++) FAT.push(gU32(src, at(s) + i * 4));

  const dirStart = gU32(src, 0x30), dirSecs = [];
  for (let s = dirStart; s <= 0xfffffffa; s = FAT[s]) dirSecs.push(s);

  /*
   * 섹터를 하나 집는다.
   *
   * FAT 에 빈 칸이 없으면 **FAT 자체를 한 섹터 늘린다.** 새 FAT 섹터는 자기가
   * 새로 열어 주는 구간의 첫 번호를 자기 자리로 쓴다 — 그래야 닭과 달걀이 안 된다.
   * DIFAT 은 헤더 안 109칸을 쓰고, 그마저 차면 여기서 멈춘다 (표본은 2~5칸 사용).
   */
  const zeroed = [];                                   // 새로 집은 섹터 — 쓰기 전에 지워야 한다
  let cursor = 0;
  const alloc = () => {
    for (;;) {
      while (cursor < FAT.length && FAT[cursor] !== FREESECT) cursor++;
      if (cursor < FAT.length) { zeroed.push(cursor); return cursor++; }
      if (fatSecs.length >= 109) throw new Error('NEED_DIFAT_SECTOR');
      const self = FAT.length;                         // 이 FAT 섹터가 앉을 자리
      for (let i = 0; i < SEC / 4; i++) FAT.push(FREESECT);
      FAT[self] = 0xfffffffd;                          // FATSECT — FAT 자신이 쓰는 섹터
      fatSecs.push(self);
      zeroed.push(self);
    }
  };

  /* 디렉터리 슬롯. 모자라면 디렉터리 사슬에 섹터를 하나 잇는다. */
  const slotAt = (id) => at(dirSecs[Math.floor(id / SLOTS)]) + (id % SLOTS) * 128;
  const findFreeSlots = (src2) => {
    const f = [];
    for (let id = 0; id < dirSecs.length * SLOTS; id++) {
      const o = slotAt(id);
      if (gU16(src2, o + 64) === 0 || src2[o + 66] === 0) f.push(id);
    }
    return f;
  };

  const need = Math.ceil(data.length / SEC);
  const got = [];
  for (let i = 0; i < need; i++) got.push(alloc());

  // 스토리지가 없으면 항목이 둘 필요하다. 미리 최대치로 잡아 둔다.
  let extraDirSec = -1;
  if (findFreeSlots(src).length < 2) {
    extraDirSec = alloc();
    FAT[dirSecs[dirSecs.length - 1]] = extraDirSec;
    FAT[extraDirSec] = ENDOFCHAIN;
    dirSecs.push(extraDirSec);
  }

  /* 파일을 필요한 만큼만 늘린 사본을 만든다. 여기서부터는 out 에만 쓴다. */
  const curSecs = Math.floor((src.length - SEC) / SEC);
  const maxSec = [...got, extraDirSec, ...fatSecs].reduce((a, b) => (b > a ? b : a), curSecs - 1);
  const out = new Uint8Array(SEC + Math.max(curSecs, maxSec + 1) * SEC);
  out.set(src.subarray(0, Math.min(src.length, out.length)));

  // 파일 안의 빈 섹터를 재활용할 때는 예전 쓰레기가 남아 있다. 반드시 지운다.
  for (const s of zeroed) out.fill(0, at(s), at(s) + SEC);

  // 늘어난 FAT 섹터를 DIFAT(헤더 109칸)과 개수에 등록한다.
  for (let i = 0; i < fatSecs.length; i++) sU32(out, 0x4c + i * 4, fatSecs[i]);
  sU32(out, 0x2c, fatSecs.length);
  const fatAt = (j) => at(fatSecs[Math.floor(j / (SEC / 4))]) + (j % (SEC / 4)) * 4;

  const nameOf = (id) => {
    const o = slotAt(id), nl = gU16(out, o + 64);
    let s = '';
    for (let k = 0; k + 1 < nl - 1; k += 2) s += String.fromCharCode(gU16(out, o + k));
    return s;
  };
  const freeSlots = findFreeSlots(out);

  /** 디렉터리 항목 하나를 쓴다. 색은 검정으로 둔다 (아래 주의 참고). */
  const writeEntry = (id, name, type, start, size, child) => {
    const o = slotAt(id);
    out.fill(0, o, o + 128);
    for (let i = 0; i < name.length; i++) sU16(out, o + i * 2, name.charCodeAt(i));
    sU16(out, o + 64, (name.length + 1) * 2);
    out[o + 66] = type;                       // 1 = 스토리지, 2 = 스트림
    out[o + 67] = 1;                          // 검정
    sU32(out, o + 68, NOSTREAM);              // left
    sU32(out, o + 72, NOSTREAM);              // right
    sU32(out, o + 76, child);
    sU32(out, o + 116, start);
    sU32(out, o + 120, size);
    sU32(out, o + 124, 0);                    // v3 는 상위 32비트를 0 으로 둔다
  };

  /*
   * 이름 비교는 **길이가 먼저**, 그 다음 대문자로 바꿔서 비교한다 (MS-CFB 2.6.4).
   * 트리는 원래 레드-블랙인데 여기서는 **평범한 이진 탐색 트리로만 끼운다.**
   * 읽는 쪽은 색을 거의 안 보지만, 이 부분이 이 함수에서 제일 위험한 곳이다.
   */
  const less = (a, b) => (a.length !== b.length ? a.length < b.length : a.toUpperCase() < b.toUpperCase());
  const treeInsert = (rootId, newId) => {
    if (rootId > 0xfffffffa) return newId;               // 부모의 첫 자식이 된다
    let cur = rootId;
    for (;;) {
      const goLeft = less(nameOf(newId), nameOf(cur));
      const o = slotAt(cur), field = goLeft ? o + 68 : o + 72;
      const nxt = gU32(out, field);
      if (nxt > 0xfffffffa) { sU32(out, field, newId); return rootId; }
      cur = nxt;
    }
  };

  /* 스토리지를 찾거나 새로 만든다. 양식 파일에는 BinData 가 아예 없다. */
  const rootChild = gU32(out, slotAt(0) + 76);
  let storageId = -1;
  (function walk(id) {
    if (id > 0xfffffffa || storageId >= 0) return;
    if (nameOf(id) === storageName) { storageId = id; return; }
    walk(gU32(out, slotAt(id) + 68)); walk(gU32(out, slotAt(id) + 72));
  })(rootChild);

  const needSlots = (storageId < 0 ? 2 : 1);
  if (freeSlots.length < needSlots) throw new Error('NEED_DIR_SECTOR:' + freeSlots.length + '<' + needSlots);

  const streamId = freeSlots[0];
  writeEntry(streamId, streamName, 2, got[0], data.length, NOSTREAM);

  if (storageId < 0) {
    storageId = freeSlots[1];
    writeEntry(storageId, storageName, 1, 0, 0, streamId);
    sU32(out, slotAt(0) + 76, treeInsert(rootChild, storageId));
  } else {
    const o = slotAt(storageId);
    sU32(out, o + 76, treeInsert(gU32(out, o + 76), streamId));
  }

  /* 사슬을 잇고 FAT 전체를 되쓴다. 안 건드린 칸은 읽은 값을 그대로 다시 쓰는 것이라
   * 바이트가 안 변한다. FAT 섹터를 늘렸을 수 있어서 부분 갱신보다 이게 안전하다. */
  for (let i = 0; i < got.length; i++) FAT[got[i]] = i + 1 < got.length ? got[i + 1] : ENDOFCHAIN;
  for (let j = 0; j < FAT.length; j++) sU32(out, fatAt(j), FAT[j]);

  for (let i = 0; i < got.length; i++)
    out.set(data.subarray(i * SEC, Math.min((i + 1) * SEC, data.length)), at(got[i]));

  return out;
}

/**
 * PNG 뒤에 무해한 주석 덩어리를 붙여 최소 크기를 맞춘다.
 *
 * 통에 스트림으로 넣으려면 4096B 이상이어야 하는데(미니 스트림 경로를 안 만들었다),
 * 서명은 선 몇 개라 그보다 훨씬 작게 압축된다. tEXt 는 표준 보조 청크라
 * 어느 뷰어든 그냥 건너뛴다. **그림 자체는 한 픽셀도 안 변한다.**
 */
function padPng(bytes, min) {
  if (bytes.length >= min) return bytes;
  // 끝의 IEND(12B) 앞에 끼운다. 모양이 다르면 손대지 않는다.
  const cut = bytes.length - 12;
  if (!(bytes[cut + 4] === 0x49 && bytes[cut + 5] === 0x45 &&
        bytes[cut + 6] === 0x4e && bytes[cut + 7] === 0x44)) return bytes;

  const body = new TextEncoder().encode('Comment\0' + 'x'.repeat(min - bytes.length));
  const chunk = new Uint8Array(12 + body.length);
  const v = new DataView(chunk.buffer);
  v.setUint32(0, body.length);                       // PNG 길이는 빅엔디언이다
  chunk.set([0x74, 0x45, 0x58, 0x74], 4);            // 'tEXt'
  chunk.set(body, 8);
  v.setUint32(8 + body.length, crc32(chunk.subarray(4, 8 + body.length)));

  const out = new Uint8Array(bytes.length + chunk.length);
  out.set(bytes.subarray(0, cut), 0);
  out.set(chunk, cut);
  out.set(bytes.subarray(cut), cut + chunk.length);
  return out;
}

/**
 * DocInfo 에 그림을 등록하고 새 BinItem ID 를 돌려준다.
 * ID_MAPPINGS 의 첫 칸이 BinData 개수다. 안 올리면 한글이 그림을 못 찾는다.
 */
function addBinData(docInfo, ext) {
  const recs = docInfo.recs;
  const mi = recs.findIndex((r) => r.tag === 17);
  if (mi < 0) throw new Error('NO_ID_MAPPINGS');
  const nd = recs[mi].data.slice();
  const id = gU32(nd, 0) + 1;
  sU32(nd, 0, id);
  recs[mi] = { ...recs[mi], data: nd, size: nd.length };

  // BIN_DATA 는 ID_MAPPINGS 뒤에 죽 늘어선다. **순서가 곧 번호**라 맨 뒤에 붙인다.
  let k = mi + 1;
  while (k < recs.length && recs[k].tag === 18) k++;
  const d = new Uint8Array(6 + ext.length * 2);
  sU16(d, 0, 0x0021);        // 포함 + 무압축. png 표본이 전부 이 값이었다
  sU16(d, 2, id);
  sU16(d, 4, ext.length);
  for (let i = 0; i < ext.length; i++) sU16(d, 6 + i * 2, ext.charCodeAt(i));
  recs.splice(k, 0, { tag: 18, level: recs[mi].level, size: d.length, ext: false, data: d });
  return id;
}

/**
 * 본문 레코드 3층을 짓는다. 크기는 전부 HWPUNIT(1/7200 인치).
 *
 * 초기 크기와 현재 크기를 같게 둔다 — 그러면 변환 행렬 세 개가 전부 항등이라
 * 계산할 게 없고 틀릴 데도 없다. 원본 픽셀 수는 자르기 값으로만 들어간다.
 */
function buildPicture(level, binId, w, h, pxW, pxH, attr = PIC_ATTR, offX = 0, offY = 0) {
  /* 개체 식별 번호. 시계로 만들면 저장할 때마다 파일이 달라져서
   * 「두 번 저장하면 같은가」 를 검사할 수 없다. 값으로부터 만든다. */
  const inst = ((binId * 0x9e3779b1) ^ (w * 31) ^ (h * 131) ^ 0x5a000000) >>> 0 & 0x7ffffffe;

  const ctrl = new Uint8Array(48);
  ctrl.set(GSO_ID, 0);
  sU32(ctrl, 4, attr);
  sU32(ctrl, 8, offY >>> 0); sU32(ctrl, 12, offX >>> 0);   // 떠 있을 때만 쓰인다
  sU32(ctrl, 16, w); sU32(ctrl, 20, h);
  sU32(ctrl, 36, inst);
  sU16(ctrl, 44, 0);                       // 설명문 길이 0 + 뒤의 NUL 2바이트

  const shape = new Uint8Array(196);
  shape.set(PIC_ID, 0); shape.set(PIC_ID, 4);
  sU16(shape, 18, 1);                      // 로컬 버전
  sU32(shape, 20, w); sU32(shape, 24, h);  // 초기 크기
  sU32(shape, 28, w); sU32(shape, 32, h);  // 현재 크기 — 같게 두어 배율 1
  sU32(shape, 36, 0x24080000);             // 표본값
  sU32(shape, 42, Math.round(w / 2));      // 회전 중심
  sU32(shape, 46, Math.round(h / 2));
  sU16(shape, 50, 1);                      // 행렬 쌍 1개 → 항등 3개 (이동·배율·회전)
  for (const base of [52, 100, 148]) { sF64(shape, base, 1); sF64(shape, base + 32, 1); }

  const pic = new Uint8Array(91);
  const pts = [[0, 0], [w, 0], [w, h], [0, h]];
  pts.forEach(([x, y], i) => { sU32(pic, 12 + i * 8, x); sU32(pic, 16 + i * 8, y); });
  const cw = pxW * CROP_PER_PX, ch = pxH * CROP_PER_PX;
  sU32(pic, 52, cw); sU32(pic, 56, ch);    // 자르기 right·bottom (left·top 은 0)
  sU16(pic, 71, binId);                    // ★ 정렬이 안 맞는 자리다
  sU32(pic, 74, inst + 1);
  sU32(pic, 82, cw); sU32(pic, 86, ch);    // 원본 크기

  return [
    { tag: TAG.CTRL_HEADER, level, size: ctrl.length, ext: false, data: ctrl },
    { tag: 76, level: level + 1, size: shape.length, ext: false, data: shape },
    { tag: 85, level: level + 2, size: pic.length, ext: false, data: pic },
  ];
}

/**
 * 문단 하나에 그림을 끼운다.
 *
 * 글자 쪽에는 **확장 제어문자 8 WCHAR** 가 들어가고(코드 11, 앞뒤로 같은 코드),
 * 레코드 쪽에는 3층이 그 문단의 자식으로 붙는다. 글자 수에 8 을 더해야 한다 —
 * 안 더하면 그 뒤 글자가 전부 밀린다.
 */
function insertPicture(recs, para, binId, w, h, pxW, pxH, at = 0, attr = PIC_ATTR, offX = 0, offY = 0) {
  const hdr = recs[para.rec];
  const lv = hdr.level;

  const ctrlChars = new Uint8Array(16);
  sU16(ctrlChars, 0, 11);
  ctrlChars.set(GSO_ID, 2);
  sU16(ctrlChars, 14, 11);

  if (para.textRec >= 0) {
    const old = recs[para.textRec].data;
    // 문단 끝 줄바꿈보다는 앞에 넣어야 한다. 뒤에 넣으면 다음 줄로 넘어간다.
    const cut = Math.max(0, Math.min(at, old.length / 2 - 1)) * 2;
    const nd = new Uint8Array(16 + old.length);
    nd.set(old.subarray(0, cut), 0);
    nd.set(ctrlChars, cut);
    nd.set(old.subarray(cut), cut + 16);
    recs[para.textRec] = { ...recs[para.textRec], data: nd, size: nd.length };
    at = cut / 2;
  } else {
    // 빈 칸에는 PARA_TEXT 가 아예 없다. 제어문자 + 줄바꿈으로 새로 만든다.
    const nd = new Uint8Array(18);
    nd.set(ctrlChars, 0); sU16(nd, 16, 13);
    recs.splice(para.rec + 1, 0, { tag: TAG.PARA_TEXT, level: lv + 1, size: 18, ext: false, data: nd });
    at = 0;
  }

  const hv = ownHeader(recs, para.rec);
  const flag = hv.getUint32(0, true) & 0x80000000;
  hv.setUint32(0, flag | (((hv.getUint32(0, true) & 0x7fffffff) + 8) >>> 0), true);

  // 글자 모양 목록은 「몇 번째 글자부터」 라서 끼운 자리 뒤가 전부 밀린다.
  // 첫 항목은 언제나 0번 글자부터이므로 그대로 둔다.
  for (let m = para.rec + 1; m < recs.length && recs[m].level > lv; m++) {
    if (recs[m].tag !== TAG.PARA_CHAR_SHAPE || recs[m].level !== lv + 1) continue;
    const nd = recs[m].data.slice();
    for (let i = 8; i + 8 <= nd.length; i += 8) if (gU32(nd, i) >= at) sU32(nd, i, gU32(nd, i) + 8);
    recs[m] = { ...recs[m], data: nd, size: nd.length };
    break;
  }

  // 3층은 문단의 **맨 뒤 자식**으로 붙인다 (PARA_LINE_SEG 다음).
  let end = para.rec + 1;
  while (end < recs.length && recs[end].level > lv) end++;
  recs.splice(end, 0, ...buildPicture(lv + 1, binId, w, h, pxW, pxH, attr, offX, offY));
}

/**
 * 문단에서 그림 하나를 뺀다.
 *
 * **통과 DocInfo 는 안 건드린다.** 스트림을 지우려면 섹터를 되돌리고 디렉터리 트리를
 * 다시 엮어야 하고, BIN_DATA 를 지우면 그 뒤 그림들의 번호가 전부 한 칸씩 밀린다.
 * 본문에서만 떼어내면 화면에서도 인쇄에서도 안 보인다 — 안 쓰는 바이트가 남을 뿐이다.
 * 안 건드려도 되는 건 안 건드린다는 원칙 그대로다.
 */
function removePicture(recs, para, binId) {
  const hdr = recs[para.rec];
  const lv = hdr.level;

  /* 이 문단의 gso 제어들을 **순서대로** 모은다. 글자 속 제어문자도 같은 순서라
   * 「몇 번째 gso 인가」 로 둘을 짝지을 수 있다. */
  const gsos = [];
  for (let i = para.rec + 1; i < recs.length && recs[i].level > lv; i++) {
    const d = recs[i].data;
    if (recs[i].level !== lv + 1 || recs[i].tag !== TAG.CTRL_HEADER) continue;
    if (String.fromCharCode(d[3], d[2], d[1], d[0]) === 'gso ') gsos.push(i);
  }
  let nth = -1, ctrlIdx = -1;
  for (let n = 0; n < gsos.length && ctrlIdx < 0; n++) {
    const i = gsos[n];
    for (let j = i + 1; j < recs.length && recs[j].level > recs[i].level; j++)
      if (recs[j].tag === 85 && gU16(recs[j].data, 71) === binId) { nth = n; ctrlIdx = i; break; }
  }
  if (ctrlIdx < 0) throw new Error('PIC_NOT_FOUND');

  /* 글자에서 그 제어문자 8 WCHAR 를 들어낸다. 안 빼면 가리킬 데 없는 참조가 남는다. */
  let dropText = false;
  if (para.textRec >= 0) {
    const d = recs[para.textRec].data;
    let seen = -1, at = -1;
    for (let k = 0; k + 1 < d.length; ) {
      const c = gU16(d, k);
      if (!WIDE.has(c)) { k += 2; continue; }
      if (String.fromCharCode(d[k + 5], d[k + 4], d[k + 3], d[k + 2]) === 'gso ' && ++seen === nth) {
        at = k; break;
      }
      k += 16;
    }
    if (at >= 0) {
      const nd = new Uint8Array(d.length - 16);
      nd.set(d.subarray(0, at), 0);
      nd.set(d.subarray(at + 16), at);
      // 줄바꿈 하나만 남으면 레코드째 없앤다. 원래 빈 칸에는 PARA_TEXT 가 아예 없고,
      // 그래야 넣기 전 파일과 구조가 완전히 같아진다.
      dropText = nd.length === 2 && gU16(nd, 0) === 13;
      if (!dropText) recs[para.textRec] = { ...recs[para.textRec], data: nd, size: nd.length };

      const hv = ownHeader(recs, para.rec);
      const flag = hv.getUint32(0, true) & 0x80000000;
      hv.setUint32(0, flag | (((hv.getUint32(0, true) & 0x7fffffff) - 8) >>> 0), true);

      // 글자 모양 목록의 위치도 8 만큼 되민다. 첫 항목은 언제나 0 이라 그대로 둔다.
      const cut = at / 2;
      for (let m = para.rec + 1; m < recs.length && recs[m].level > lv; m++) {
        if (recs[m].tag !== TAG.PARA_CHAR_SHAPE || recs[m].level !== lv + 1) continue;
        const cd = recs[m].data.slice();
        for (let i = 8; i + 8 <= cd.length; i += 8) {
          const pos = gU32(cd, i);
          if (pos > cut) sU32(cd, i, Math.max(cut, pos - 8));
        }
        recs[m] = { ...recs[m], data: cd, size: cd.length };
        break;
      }
    }
  }

  // 3층을 통째로 들어낸다. PARA_TEXT 는 이보다 앞이라 인덱스가 안 밀린다.
  let end = ctrlIdx + 1;
  while (end < recs.length && recs[end].level > recs[ctrlIdx].level) end++;
  recs.splice(ctrlIdx, end - ctrlIdx);
  if (dropText) recs.splice(para.textRec, 1);
}

/*
 * ── 글자 모양 · 문단 모양 ────────────────────────────────────────────
 * 크기와 줄간격은 본문이 아니라 **DocInfo** 에 있다. 고치려면 거기에 레코드를
 * 새로 만들고 ID_MAPPINGS 개수를 올린 다음, 문단이 그 번호를 가리키게 한다.
 * BIN_DATA 와 **완전히 같은 방식**이다.
 *
 * 실측 (자사양식.hwp, 2026-09-13):
 *   CHAR_SHAPE 74B   42번지 INT32 = 기준 크기, 1/100 pt   (1100 = 11pt)
 *   PARA_SHAPE 58B   24번지·50번지 INT32 = 줄간격 %       (150 = 150%)
 *                    0번지 속성1 의 하위 2비트가 0 이어야 % 로 읽는다
 *
 * ID_MAPPINGS 칸 번호도 실측이다. 개수가 레코드 수와 정확히 맞는 걸로 확인했다.
 */
const MAP_CHAR_SHAPE = 9, MAP_PARA_SHAPE = 13;
const CHAR_SIZE_AT = 42, LINE_PCT_AT = 24, LINE_PCT_AT2 = 50;

/** 같은 태그 레코드를 하나 베껴 고쳐 붙이고 새 번호를 돌려준다. 번호는 등장 순서다. */
function cloneDocInfo(di, tag, mapIndex, fromId, patch) {
  const recs = di.recs;
  const same = recs.filter((r) => r.tag === tag);
  if (!same.length) throw new Error('NO_SHAPE');
  const src = same[Math.min(fromId, same.length - 1)];
  const nd = src.data.slice();
  patch(nd);

  recs.splice(recs.indexOf(same[same.length - 1]) + 1, 0,
              { tag, level: src.level, size: nd.length, ext: false, data: nd });

  const mi = recs.findIndex((r) => r.tag === 17);
  const md = recs[mi].data.slice();
  sU32(md, mapIndex * 4, gU32(md, mapIndex * 4) + 1);
  recs[mi] = { ...recs[mi], data: md, size: md.length };

  return same.length;                       // 0 부터 세는 새 번호
}

const newCharShape = (di, fromId, sizePt) =>
  cloneDocInfo(di, 21, MAP_CHAR_SHAPE, fromId, (d) =>
    new DataView(d.buffer, d.byteOffset, d.byteLength)
      .setInt32(CHAR_SIZE_AT, Math.round(sizePt * 100), true));

const newParaShape = (di, fromId, linePct) =>
  cloneDocInfo(di, 25, MAP_PARA_SHAPE, fromId, (d) => {
    const v = new DataView(d.buffer, d.byteOffset, d.byteLength);
    v.setUint32(0, v.getUint32(0, true) & ~3, true);     // 줄간격을 % 로 읽게
    v.setInt32(LINE_PCT_AT, linePct, true);
    if (d.length > LINE_PCT_AT2 + 4) v.setInt32(LINE_PCT_AT2, linePct, true);
  });

/** 문단이 지금 쓰는 번호들. 베낄 원본을 고르는 데 쓴다. */
function shapeIdsOf(recs, para) {
  const hdr = recs[para.rec];
  const paraId = gU16(hdr.data, 8);
  let charId = 0;
  for (let m = para.rec + 1; m < recs.length && recs[m].level > hdr.level; m++)
    if (recs[m].tag === TAG.PARA_CHAR_SHAPE) { charId = gU32(recs[m].data, 4); break; }
  return { paraId, charId };
}

/** 문단이 새 번호를 가리키게 한다. 글자 모양은 문단 전체를 하나로 통일한다. */
function applyShapes(recs, para, charId, paraId) {
  const hdr = recs[para.rec];
  if (paraId != null) ownHeader(recs, para.rec).setUint16(8, paraId, true);
  if (charId == null) return;
  for (let m = para.rec + 1; m < recs.length && recs[m].level > hdr.level; m++) {
    if (recs[m].tag !== TAG.PARA_CHAR_SHAPE) continue;
    const nd = recs[m].data.slice();
    for (let i = 0; i + 8 <= nd.length; i += 8) sU32(nd, i + 4, charId);
    recs[m] = { ...recs[m], data: nd, size: nd.length };
    break;
  }
}

/* ─── HWPX ───────────────────────────────────────────────────────────
 * zip + XML(OWPML). 문서 모델은 HWP 와 **같다** — 표현만 다르다.
 *
 *   HWP 5.0            HWPX
 *   PARA_HEADER   →    <hp:p>
 *   PARA_TEXT     →    <hp:t>
 *   TABLE         →    <hp:tbl rowCnt colCnt>
 *   LIST_HEADER   →    <hp:tc> + <hp:cellAddr> <hp:cellSpan> <hp:cellSz>
 *
 * 그래서 화면과 저장 뼈대를 그대로 쓴다. 새로 붙는 건 입구뿐이다.
 *
 * XML 을 트리로 만들어 통째로 다시 써내지 않는다. **원본 문자열에서 고칠 부분만
 * 잘라 끼운다.** CFB 를 다시 안 짓는 것과 같은 이유다 — 우리가 안 건드린 곳은
 * 한 글자도 안 변해야 안전하다. 그리고 DOMParser 에 기대지 않으므로
 * 브라우저 밖(테스트)에서도 같은 코드가 돈다.
 */

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();
function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** zip 목록을 읽는다. 각 항목의 원본 바이트를 그대로 들고 있는다. */
function readZip(buf) {
  const u8 = new Uint8Array(buf), dv = new DataView(buf);
  let eocd = -1;
  for (let i = u8.length - 22; i >= 0 && i > u8.length - 66000; i--)
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('NOT_ZIP');

  const n = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const entries = [];
  for (let i = 0; i < n; i++) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('BAD_ZIP');
    const flags = dv.getUint16(p + 8, true);
    // 데이터 서술자(bit 3)를 쓰면 크기가 헤더에 없다. 한컴 파일엔 안 나오지만 막아 둔다.
    if (flags & 8) throw new Error('ZIP_STREAMED');
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const cmtLen = dv.getUint16(p + 32, true);
    const local = dv.getUint32(p + 42, true);
    const cSize = dv.getUint32(p + 20, true);
    const name = new TextDecoder().decode(u8.subarray(p + 46, p + 46 + nameLen));
    const cdEnd = p + 46 + nameLen + extraLen + cmtLen;

    const lNameLen = dv.getUint16(local + 26, true);
    const lExtraLen = dv.getUint16(local + 28, true);
    const dataStart = local + 30 + lNameLen + lExtraLen;

    entries.push({
      name, method: dv.getUint16(p + 10, true),
      crc: dv.getUint32(p + 16, true), cSize, uSize: dv.getUint32(p + 24, true),
      header: u8.slice(local, dataStart),        // 로컬 헤더를 통째로 보존
      body: u8.slice(dataStart, dataStart + cSize),
      central: u8.slice(p, cdEnd),               // 중앙 디렉터리 항목도 그대로
    });
    p = cdEnd;
  }
  return entries;
}

async function unzip(entry) {
  if (entry.method === 0) return entry.body;     // 저장(무압축)
  if (entry.method !== 8) throw new Error('ZIP_METHOD:' + entry.method);
  return inflateRaw(entry.body);
}

/** 고친 항목만 다시 압축하고, 나머지는 원본 압축 바이트를 그대로 옮겨 담는다. */
async function writeZip(entries, changed) {
  const parts = [], centrals = [];
  let offset = 0;
  for (const e of entries) {
    let header = e.header, body = e.body, crc = e.crc, cSize = e.cSize, uSize = e.uSize;
    const now = changed.get(e.name);
    if (now !== undefined) {
      const raw = new TextEncoder().encode(now);
      // mimetype 처럼 무압축으로 둔 항목은 그 성질을 유지한다.
      body = e.method === 0 ? raw : await deflateRaw(raw);
      crc = crc32(raw); cSize = body.length; uSize = raw.length;
      header = e.header.slice();
      const hv = new DataView(header.buffer, header.byteOffset, header.byteLength);
      hv.setUint32(14, crc, true); hv.setUint32(18, cSize, true); hv.setUint32(22, uSize, true);
    }
    const central = e.central.slice();
    const cv = new DataView(central.buffer, central.byteOffset, central.byteLength);
    cv.setUint32(16, crc, true); cv.setUint32(20, cSize, true); cv.setUint32(24, uSize, true);
    cv.setUint32(42, offset, true);
    parts.push(header, body);
    centrals.push(central);
    offset += header.length + body.length;
  }
  const cdOffset = offset;
  let cdSize = 0;
  for (const c of centrals) { parts.push(c); cdSize += c.length; }

  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, centrals.length, true); ev.setUint16(10, centrals.length, true);
  ev.setUint32(12, cdSize, true); ev.setUint32(16, cdOffset, true);
  parts.push(eocd);

  const out = new Uint8Array(parts.reduce((a, b) => a + b.length, 0));
  let o = 0;
  for (const q of parts) { out.set(q, o); o += q.length; }
  return out;
}

/*
 * 아주 작은 XML 훑기. 각 요소가 원본 문자열의 **어디에 있는지**를 같이 들고 있는다.
 * 그 위치가 있어야 나중에 그 자리만 잘라 끼울 수 있다.
 */
function parseXml(src) {
  const root = { name: '#root', attrs: {}, children: [], parent: null };
  let cur = root, i = 0;
  while (i < src.length) {
    const lt = src.indexOf('<', i);
    if (lt < 0) break;
    if (src.startsWith('<?', lt) || src.startsWith('<!', lt)) { i = src.indexOf('>', lt) + 1; continue; }
    const gt = src.indexOf('>', lt);
    if (gt < 0) break;
    const inner = src.slice(lt + 1, gt);
    if (inner[0] === '/') {
      if (cur.parent) { cur.end = gt + 1; cur.contentEnd = lt; cur = cur.parent; }
      i = gt + 1; continue;
    }
    const selfClose = inner.endsWith('/');
    const bodyStr = selfClose ? inner.slice(0, -1) : inner;
    const sp = bodyStr.search(/\s/);
    const name = sp < 0 ? bodyStr : bodyStr.slice(0, sp);
    const attrs = {};
    if (sp > 0) for (const m of bodyStr.slice(sp).matchAll(/([\w:.-]+)\s*=\s*"([^"]*)"/g)) attrs[m[1]] = m[2];

    const node = { name, attrs, selfClose, children: [], parent: cur, start: lt, contentStart: gt + 1 };
    cur.children.push(node);
    if (selfClose) { node.end = gt + 1; node.contentEnd = gt + 1; }
    else cur = node;
    i = gt + 1;
  }
  return root;
}

const kids = (n, name) => n.children.filter((c) => c.name === name);
function deepFind(node, name, stopAt, out = []) {
  for (const c of node.children) {
    if (c.name === name) out.push(c);
    else if (c.name !== stopAt) deepFind(c, name, stopAt, out);
  }
  return out;
}

const unesc = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
                      .replace(/&apos;/g, "'").replace(/&amp;/g, '&');
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** hp:p 하나를 문단 모델로. 중첩된 표 안의 글자는 이 문단 것이 아니다. */
function hwpxParagraph(pEl, src, si) {
  const ts = deepFind(pEl, 'hp:t', 'hp:tbl');
  const text = ts.map((t) => unesc(src.slice(t.contentStart, t.contentEnd))).join('');
  // 빈 문단에는 <hp:t> 가 아예 없다 (HWP 에서 빈 문단에 PARA_TEXT 가 없는 것과 같다).
  // 그때 글자를 끼워 넣을 자리가 필요해서 <hp:run> 도 같이 들고 있는다.
  // 표를 품은 run 은 제외한다 — 거기 글자를 넣으면 표 앞에 엉뚱한 글자가 붙는다.
  const runs = deepFind(pEl, 'hp:run', 'hp:tbl').filter((r) => !deepFind(r, 'hp:tbl', 'hp:tbl').length);
  const para = { si, el: pEl, textEls: ts, runEls: runs, text: text + '\n', tables: [] };
  for (const tbl of deepFind(pEl, 'hp:tbl', 'hp:tbl')) para.tables.push(hwpxTable(tbl, src, si));
  return para;
}

function hwpxTable(tblEl, src, si) {
  const table = { rows: +tblEl.attrs.rowCnt || 0, cols: +tblEl.attrs.colCnt || 0, cells: [] };
  for (const tr of kids(tblEl, 'hp:tr'))
    for (const tc of kids(tr, 'hp:tc')) {
      const addr = kids(tc, 'hp:cellAddr')[0], span = kids(tc, 'hp:cellSpan')[0], sz = kids(tc, 'hp:cellSz')[0];
      const paras = [];
      for (const sub of kids(tc, 'hp:subList'))
        for (const p of kids(sub, 'hp:p')) paras.push(hwpxParagraph(p, src, si));
      table.cells.push({
        col: +((addr && addr.attrs.colAddr) || 0), row: +((addr && addr.attrs.rowAddr) || 0),
        colSpan: +((span && span.attrs.colSpan) || 1) || 1,
        rowSpan: +((span && span.attrs.rowSpan) || 1) || 1,
        width: +((sz && sz.attrs.width) || 0), height: +((sz && sz.attrs.height) || 0),
        paras, text: paras.map((p) => p.text).join('\n').replace(/\s+$/, ''),
      });
    }
  return table;
}

async function openHwpx(buf) {
  const entries = readZip(buf);
  const dec = new TextDecoder();
  const sections = [];
  for (let i = 0; ; i++) {
    const e = entries.find((x) => x.name === 'Contents/section' + i + '.xml');
    if (!e) break;
    const src = dec.decode(await unzip(e));
    sections.push({ name: e.name, src, root: parseXml(src) });
  }
  if (!sections.length) throw new Error('NO_BODY');

  const blocks = [];
  for (let si = 0; si < sections.length; si++) {
    const top = sections[si].root;
    const sec = top.children.find((c) => c.name === 'hs:sec') || top;
    for (const p of kids(sec, 'hp:p')) blocks.push(hwpxParagraph(p, sections[si].src, si));
  }

  let version = '';
  const vEl = entries.find((x) => x.name === 'version.xml');
  if (vEl) {
    const m = dec.decode(await unzip(vEl)).match(/major="(\d+)"[^>]*minor="(\d+)"[^>]*micro="(\d+)"/);
    if (m) version = m[1] + '.' + m[2] + '.' + m[3];
  }

  return {
    kind: 'hwpx', buf, entries, sections, blocks,
    version: version || 'HWPX',
    nSections: sections.length,
    nRecords: sections.reduce((a, s) => a + (s.src.match(/<hp:/g) || []).length, 0),
  };
}

/**
 * 고친 글자를 XML 에 되꽂는다.
 * 문단의 첫 <hp:t> 에 전부 넣고 나머지는 비운다 — HWP 쪽에서 글자 모양 목록을
 * 첫 항목만 남기는 것과 같은 처리다. 서식이 여럿이던 문단은 첫 서식으로 합쳐진다.
 */
async function saveHwpx(doc, edits) {
  const bySection = new Map();
  for (const e of edits) {
    if (!bySection.has(e.para.si)) bySection.set(e.para.si, []);
    bySection.get(e.para.si).push(e);
  }

  const changed = new Map();
  for (const [si, list] of bySection) {
    const sec = doc.sections[si];
    const splices = [];
    for (const e of list) {
      // 표를 품은 문단은 건드리지 않는다. 글자를 갈아끼우면 표가 떨어져 나간다.
      if (e.para.tables.length) throw new Error('PARA_HAS_TABLE');
      const ts = e.para.textEls;
      if (ts.length) {
        const t0 = ts[0];
        // <hp:t/> 는 자기닫힘이라 안에 글자를 못 넣는다. 태그째 펴 준다.
        if (t0.selfClose) splices.push({ at: t0.start, to: t0.end, text: '<hp:t>' + esc(e.text) + '</hp:t>' });
        else splices.push({ at: t0.contentStart, to: t0.contentEnd, text: esc(e.text) });
        for (const t of ts.slice(1))
          if (!t.selfClose) splices.push({ at: t.contentStart, to: t.contentEnd, text: '' });
        continue;
      }
      // 빈 문단 — <hp:t> 를 새로 만들어 첫 <hp:run> 안에 넣는다.
      const run = e.para.runEls[0];
      if (!run) throw new Error('NO_RUN');
      const tag = '<hp:t>' + esc(e.text) + '</hp:t>';
      if (run.selfClose) {
        // <hp:run .../> 를 <hp:run ...><hp:t>…</hp:t></hp:run> 로 편다
        const open = sec.src.slice(run.start, run.end - 2);
        splices.push({ at: run.start, to: run.end, text: open + '>' + tag + '</hp:run>' });
      } else {
        splices.push({ at: run.contentStart, to: run.contentStart, text: tag });
      }
    }
    // 뒤에서 앞으로 끼운다. 앞에서 하면 뒤쪽 위치가 전부 밀린다.
    splices.sort((a, b) => b.at - a.at);
    let src = sec.src;
    for (const s of splices) src = src.slice(0, s.at) + s.text + src.slice(s.to);
    changed.set(sec.name, src);
  }
  return writeZip(doc.entries, changed);
}

/**
 * 파일 형식을 **내용**으로 가른다. 확장자는 틀릴 수 있어도 안의 구조는 안 틀린다.
 *
 *   zip (PK)                       → hwpx
 *   CFB + FileHeader 스트림         → hwp
 *   CFB + DocumentText 스트림       → jtd (一太郎 .jtd/.jtt, 2026-09-15 실측: 문부과학성 양식 4개)
 *
 * hwp 와 一太郎 는 **같은 CFB 통**이라 앞 바이트(D0 CF 11 E0)로는 못 가른다. 통을 열어 이름을 본다.
 */
function sniffFormat(buf) {
  const head = new Uint8Array(buf, 0, Math.min(8, buf.byteLength));
  if (head[0] === 0x50 && head[1] === 0x4b) return 'hwpx';
  const isCfb = head[0] === 0xd0 && head[1] === 0xcf && head[2] === 0x11 && head[3] === 0xe0;
  if (!isCfb) return 'unknown';
  try {
    const { streams } = readCFB(buf);
    if (streams.has('FileHeader')) return 'hwp';
    if (streams.has('DocumentText')) return 'jtd';
  } catch (e) { /* 통이 깨졌으면 아래로 */ }
  return 'unknown';
}

/* ─── 一太郎 (.jtd) ──────────────────────────────────────────────────────
 * 2026-09-16 문부과학성 様式A 4개로 실측. 자리표는 docs/포맷.md 「一太郎」.
 *
 * DocumentText 는 압축 없는 UTF-16BE 워드열이다.
 *
 *   머리      "SsmgV.01" … "TextV.01" LEN32   ← 이름이 있으면 본문은 +16 부터 LEN 워드
 *             (이름 없이 바로 본문이 시작하는 파일도 있다. 그땐 다음 「xxxxV.01」 이름까지)
 *   레코드    001c TAG LEN 0000  …  LEN 0000 TAG 001f     닫는 쪽은 여는 쪽의 거울.
 *             보통 i+LEN-4 에 닫히지만, 괘선·그림 자료를 품은 레코드는 그보다 뒤에 닫힌다
 *   중첩      001c TAG LEN … 001d  글자  001e LEN2 … 001f   (칸 이름표 같은 것)
 *   표시      000e 같은 홀로 선 제어 워드 — 서식 레코드 앞에 붙는다. 글자가 아니다
 *   글자      나머지. 000a 가 줄바꿈
 *
 * **글자 수를 바꾸지 않는다.** 줄 위치는 DocumentTextPositionTables · LineMark · PageMark 가
 * 워드 번호로 가리키고 있어서, 길이가 달라지면 그 표들을 다 고쳐야 한다(hwp 의 PARA_LINE_SEG 자리).
 * 그 대신 **빈칸(공백) 자리에 덮어쓴다** — 양식의 빈칸은 원래 공백으로 비워 둔 것이라 대부분 이걸로 채워진다.
 * 스트림 크기가 그대로라 다른 스트림은 한 바이트도 안 바뀐다.
 * ─────────────────────────────────────────────────────────────────── */

const JTD_SPACE = (c) => c === ' ' || c === '　';

/** DocumentText → 줄 목록. 줄마다 글자와 그 글자가 있는 워드 번호를 든다. */
function jtdWalk(w) {
  const name = (i) => String.fromCharCode(w[i] >> 8, w[i] & 255, w[i + 1] >> 8, w[i + 1] & 255,
    w[i + 2] >> 8, w[i + 2] & 255, w[i + 3] >> 8, w[i + 3] & 255);
  let i = 10, end = w.length;
  if (name(10) === 'TextV.01') {
    i = 16;
    end = Math.min(w.length, 16 + ((w[14] << 16 | w[15]) >>> 0));
  } else {
    for (let k = 10; k + 4 < w.length; k++) if (/^[A-Za-z]{4}V\.\d\d$/.test(name(k))) { end = k; break; }
  }

  const lines = [];
  let line = { text: '', idx: [] }, stop = null;
  const endLine = () => { lines.push(line); line = { text: '', idx: [] }; };
  while (i < end) {
    const c = w[i];
    if (c === 0x001c) {
      const tag = w[i + 1], len = w[i + 2];
      if (!len) { stop = i; break; }
      if (w[i + len - 1] === 0x001d) { i += len; continue; }          // 중첩 여는 쪽 — 안의 글자는 계속 읽는다
      const closes = (k) => w[k] === len && w[k + 1] === 0 && w[k + 2] === tag && w[k + 3] === 0x001f;
      let k = i + len - 4;
      if (!closes(k)) { k = i + 4; while (k + 3 < end && !closes(k)) k++; }
      if (k + 3 >= end) { stop = i; break; }
      i = k + 4;
    } else if (c === 0x001e) {
      const len = w[i + 1];
      if (!len || w[i + len - 1] !== 0x001f) { stop = i; break; }
      i += len;
    } else if (c === 0x000a) {
      endLine(); i++;
    } else if (c < 0x20) {
      i++;                                                            // 홀로 선 표시 워드
    } else {
      line.text += String.fromCharCode(c); line.idx.push(i); i++;
    }
  }
  // 멈춘 곳의 반쪽 줄은 버린다. 어긋난 자리 바로 앞 글자는 믿을 수 없다.
  if (stop === null && line.idx.length) endLine();
  return { lines, stop, end };
}

/**
 * 고친 줄을 **원래 길이에 맞춘다.** 못 맞추면 null.
 *
 * 앞뒤로 같은 부분을 떼고 가운데만 본다.
 *   짧아졌으면  남는 자리를 공백으로 채운다 (지운 자리에 전각 공백이 있었으면 전각으로)
 *   길어졌으면  뒤이어 오는 공백을 먹고, 모자라면 앞쪽 공백을 먹는다
 * 「代表者職・氏名　　　　　職印」 에 이름을 끼워 넣으면 職印 앞 공백이 줄어 職印 자리가 그대로다.
 */
function jtdFit(old, next) {
  next = String(next).replace(/\n/g, '');
  if (next.length === old.length) return next;
  let p = 0;
  while (p < old.length && p < next.length && old[p] === next[p]) p++;
  let s = 0;
  while (s < old.length - p && s < next.length - p && old[old.length - 1 - s] === next[next.length - 1 - s]) s++;
  let prefix = old.slice(0, p), suffix = old.slice(old.length - s);
  const oldMid = old.slice(p, old.length - s), newMid = next.slice(p, next.length - s);

  if (newMid.length < oldMid.length) {
    const pad = oldMid.includes('　') ? '　' : ' ';
    return prefix + newMid + pad.repeat(oldMid.length - newMid.length) + suffix;
  }
  let extra = newMid.length - oldMid.length;
  let k = 0;
  while (k < suffix.length && k < extra && JTD_SPACE(suffix[k])) k++;
  suffix = suffix.slice(k); extra -= k;
  let j = 0;
  while (j < prefix.length && j < extra && JTD_SPACE(prefix[prefix.length - 1 - j])) j++;
  prefix = prefix.slice(0, prefix.length - j); extra -= j;
  return extra > 0 ? null : prefix + newMid + suffix;
}

async function openJtd(buf) {
  const cfb = readCFB(buf);
  const bytes = cfb.streams.get('DocumentText');
  if (!bytes) throw new Error('NOT_HWP');
  const w = new Array(bytes.length >> 1);
  for (let i = 0; i < w.length; i++) w[i] = (bytes[2 * i] << 8) | bytes[2 * i + 1];
  const { lines, stop } = jtdWalk(w);
  if (!lines.some((l) => l.text.trim())) throw new Error('JTD_NO_TEXT');
  return {
    kind: 'jtd', version: '', buf, cfb, words: w,
    // 화면은 hwp 의 「표 밖 문단」 과 같은 모양으로 그린다. 표·그림은 없다(괘선은 글자 위에 겹쳐 그려진다).
    blocks: lines.map((l) => ({ text: l.text + '\n', tables: [], pics: [], hasCtrl: false, jtd: l })),
    nRecords: lines.length,
    partial: stop !== null,          // 끝까지 못 읽었으면 그 뒤는 화면에 안 나온다
  };
}

async function saveJtd(doc, edits) {
  const w = doc.words.slice();
  for (const e of edits) {
    const line = e.para.jtd;
    const fit = jtdFit(line.text, e.text);
    if (fit === null) throw new Error('JTD_TOO_LONG:' + line.text.trim().slice(0, 20));
    for (let k = 0; k < line.idx.length; k++) w[line.idx[k]] = fit.charCodeAt(k);
  }
  const bytes = new Uint8Array(w.length * 2);
  for (let i = 0; i < w.length; i++) { bytes[2 * i] = w[i] >> 8; bytes[2 * i + 1] = w[i] & 255; }

  // 크기가 그대로이므로 원래 섹터(또는 미니 조각)에 그대로 덮어쓴다. 통은 안 건드린다.
  const out = new Uint8Array(doc.buf.slice(0));
  const { SEC, MINI, rootChain, chains } = doc.cfb;
  const { sectors, isMini } = chains.get('DocumentText');
  const at = (s) => SEC + s * SEC;
  const unit = isMini ? MINI : SEC;
  for (let n = 0; n < sectors.length; n++) {
    const from = n * unit;
    if (from >= bytes.length) break;
    const piece = bytes.subarray(from, Math.min(from + unit, bytes.length));
    if (!isMini) { out.set(piece, at(sectors[n])); continue; }
    const pos = sectors[n] * MINI, rootSec = rootChain[Math.floor(pos / SEC)];
    if (rootSec === undefined) throw new Error('MINI_OVERFLOW');
    out.set(piece, at(rootSec) + (pos % SEC));
  }
  return out;
}

/** 확장자가 아니라 **내용**으로 갈라 연다. 이름은 틀릴 수 있어도 앞 바이트는 안 틀린다. */
async function openDocument(buf) {
  const kind = sniffFormat(buf);
  if (kind === 'hwpx') return openHwpx(buf);
  if (kind === 'jtd') return openJtd(buf);
  const d = await openHwp(buf);
  d.kind = 'hwp';
  return d;
}

const saveDocument = (doc, edits, pictures, formats, removes) =>
  (doc.kind === 'hwpx' ? saveHwpx(doc, edits)
    : doc.kind === 'jtd' ? saveJtd(doc, edits)
    : saveHwp(doc, edits, pictures, formats, removes));

export {
  jtdWalk,
  jtdFit,
  openJtd,
  saveJtd,
  hwpToPx,
  inflateRaw,
  readCFB,
  TAG,
  parseRecords,
  WIDE,
  paraText,
  hasCtrlChar,
  childrenOf,
  readParagraph,
  readPicture,
  readTable,
  openHwp,
  deflateRaw,
  serializeRecords,
  ownHeader,
  setParagraphText,
  saveHwp,
  GSO_ID,
  PIC_ID,
  CROP_PER_PX,
  PIC_ATTR,
  PIC_ATTR_FRONT,
  FREESECT,
  gU16,
  gU32,
  sU16,
  sU32,
  sF64,
  cfbAddStream,
  padPng,
  addBinData,
  buildPicture,
  insertPicture,
  removePicture,
  MAP_CHAR_SHAPE,
  CHAR_SIZE_AT,
  cloneDocInfo,
  newCharShape,
  newParaShape,
  shapeIdsOf,
  applyShapes,
  CRC,
  crc32,
  readZip,
  unzip,
  writeZip,
  parseXml,
  kids,
  deepFind,
  unesc,
  esc,
  hwpxParagraph,
  hwpxTable,
  openHwpx,
  saveHwpx,
  sniffFormat,
  openDocument,
  saveDocument,
};
