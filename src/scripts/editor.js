/**
 * 편집 화면 — 표·빈칸 입력, 체크칸, 사진·서명 넣기, 글자 크기·줄간격, 저장.
 *
 * 2026-09-15 hwpform-prototype/index.html 의 화면 코드를 옮겨 왔다. 동작은 그대로다.
 * 달라진 것:
 *   · 사람이 읽는 문구는 전부 T(사전)에서 꺼낸다. 사전은 페이지가 빌드 때
 *     <script type="application/json" id="editor-strings"> 로 박아 둔다 (src/locales/*.json 의 editor.*).
 *   · 형식 탭은 없앴다. 언어·형식마다 페이지가 따로 있고, 파일 형식은 내용으로 가른다.
 *
 * 파일 처리는 전부 engine.js 가 한다. 여기는 DOM 을 다루는 일만.
 */
import { hwpToPx, padPng, PIC_ATTR_FRONT, openDocument, saveDocument, jtdFit } from './engine.js';

/** 이 페이지 언어의 문구 묶음 (editor.* 키에서 접두사를 뗀 것). */
const T = JSON.parse(document.getElementById('editor-strings').textContent);

/** 끝 공백을 뗀다. 「고쳤나」 비교는 늘 양쪽에 똑같이 적용한다. */
const trimEnd = (s) => String(s).replace(/\s+$/, '');

/** '{name}' 자리를 채운다. 문구 안의 어순이 언어마다 달라서 문자열 이어 붙이기를 쓰지 않는다. */
const fmt =(s, vars) => String(s).replace(/\{(\w+)\}/g, (_, k) => (vars[k] ?? ''));

function saveLabel(doc) {
  return doc && doc.kind === 'hwpx' ? T.saveHwpx : doc && doc.kind === 'jtd' ? T.saveJtd : T.saveHwp;
}

/* ─── 화면 ─────────────────────────────────────────────────────────── */

const $ = (id) => document.getElementById(id);
let blanks = [];             // 원래 비어 있던 입력칸 (진행 표시용)
let fields = [];             // 문단 하나당 입력칸 하나
let current = null;          // { doc, name }

function render(doc, name) {
  current = { doc, name };
  const host = $('doc');
  host.textContent = '';
  blanks = [];
  fields = [];
  for (const ph of photos) URL.revokeObjectURL(ph.url);
  for (const u of picUrls.values()) URL.revokeObjectURL(u);
  picUrls.clear();
  photos = [];
  removals = [];
  formats = [];
  selected = null;
  stopPicking();
  $('selinfo').textContent = T.selNone;
  $('selinfo').classList.add('none');
  $('fapply').disabled = $('fclear').disabled = true;

  for (const b of doc.blocks) {
    const t = b.text.replace(/\n+$/, '');
    if (t.trim()) {
      const p = document.createElement('p');
      p.className = 'para' + (/^[❑■□▣※]|^\s*\d+\./.test(t.trim()) ? ' head' : '');
      p.textContent = t;
      styleLike(p, b, doc);
      // 표를 품은 문단은 못 고친다 — 글자를 갈아치우면 그 표가 떨어져 나간다.
      // 나머지는 전부 연다. 「2026년  월  일」 이나 「성명   (서명)」 처럼
      // 채우라고 비워 둔 줄이 표 밖에 있는 양식이 많다.
      if (!b.tables.length && !b.hasCtrl) fields.push(makeParaEdit(p, b, t));
      host.appendChild(p);
      if (b.pics && b.pics.length) {
        const wrap = document.createElement('div');
        wrap.className = 'inpics';
        existingPics(wrap, b, doc);
        host.appendChild(wrap);
      }
    }
    for (const tbl of b.tables) if (tbl) host.appendChild(renderTable(tbl));
  }

  const total = blanks.length;
  $('fname').textContent = name;
  $('fmeta').textContent = fmt(T.fileMeta, { kind: doc.kind.toUpperCase(), version: doc.version });
  // 一太郎 는 줄 길이를 못 바꾸는 방식이라 안내가 다르다 (engine.js 「一太郎」 머리 주석)
  $('note').innerHTML = doc.kind === 'jtd' ? T.noteJtdHtml : T.noteHtml;
  updateCount();
  $('work').style.display = 'block';
  $('work').classList.remove('picking');
  // hwpx 는 zip 이라 오히려 쉬운데 아직 안 만들었다. 一太郎 는 그림·서식 레코드를 아직 모른다.
  // 될 것처럼 보이면 안 된다.
  const noTools = doc.kind === 'hwpx' || doc.kind === 'jtd';
  for (const id of ['addphoto', 'fapply', 'fclear', 'sigclear'])
    $(id).disabled = noTools || $(id).disabled;
  $('sigpad').style.pointerEvents = noTools ? 'none' : '';
  $('side').style.opacity = noTools ? .5 : 1;
  $('side').title = noTools ? fmt(T.noTools, { kind: doc.kind.toUpperCase() }) : '';
  $('drop').style.display = 'none';
  document.querySelector('.privacy').style.display = 'none';
  $('save').textContent = saveLabel(doc);
}

function renderTable(tbl) {
  // 열 너비: 병합 안 된 셀이 알려주는 값을 쓴다. 없는 열은 뒤에서 고르게 나눈다.
  const colW = new Array(tbl.cols).fill(0);
  for (const c of tbl.cells) if (c.colSpan === 1 && !colW[c.col]) colW[c.col] = c.width;

  const wrap = document.createElement('div');
  wrap.className = 'tw';
  const table = document.createElement('table');
  const cg = document.createElement('colgroup');
  for (let i = 0; i < tbl.cols; i++) {
    const col = document.createElement('col');
    if (colW[i]) col.style.width = Math.max(40, Math.round(hwpToPx(colW[i]))) + 'px';
    cg.appendChild(col);
  }
  table.appendChild(cg);

  const byRow = new Map();
  for (const c of tbl.cells) {
    if (!byRow.has(c.row)) byRow.set(c.row, []);
    byRow.get(c.row).push(c);
  }
  for (const row of [...byRow.keys()].sort((a, b) => a - b)) {
    const tr = document.createElement('tr');
    for (const c of byRow.get(row).sort((a, b) => a.col - b.col)) {
      const td = document.createElement('td');
      if (c.colSpan > 1) td.colSpan = c.colSpan;
      if (c.rowSpan > 1) td.rowSpan = c.rowSpan;

      /*
       * 모든 칸을 고칠 수 있게 한다.
       *
       * 처음에는 「빈 칸만」 입력칸으로 만들었는데, 그러면 「‘ . . ~ ’ . . ( 년 월)」
       * 처럼 **채우라고 넣어 둔 틀**이 글자가 있다는 이유로 라벨로 분류된다.
       * 무엇이 라벨이고 무엇이 틀인지 파일만 봐서는 구분할 방법이 없다 —
       * 그래서 구분하려 들지 않고 전부 열어 두되, 비어 있던 칸만 눈에 띄게 한다.
       *
       * 문단마다 입력칸을 하나씩 만든다. 저장이 문단 단위라 그래야 1:1 로 맞는다.
       */
      td.className = 'cell';
      // 사진을 넣을 때 어느 칸·어느 문단인지 알아야 한다.
      // 표를 품은 칸은 제외한다 — 되돌릴 때 그 표까지 다시 그려야 해서 복잡해진다.
      td._cell = c;
      td._para = c.paras.some((p) => p.tables.length) ? null : (c.paras[0] || null);
      fillCell(td, c);
      tr.appendChild(td);
    }
    table.appendChild(tr);
  }
  wrap.appendChild(table);
  return wrap;
}

/**
 * 문단이 실제로 쓰는 글자 크기·줄간격을 화면에 입힌다.
 *
 * 이게 없으면 「11pt 로 바꿈」 을 눌러도 화면이 그대로라 들어갔는지 알 수가 없다.
 * 원래 크기도 같이 반영해야 바뀐 게 눈에 보인다.
 *
 * pt → px 는 96dpi 기준 4/3 배다. 화면은 근사치이지 인쇄 미리보기가 아니다.
 */
function styleLike(el, para, doc, over) {
  const pt = (over && over.sizePt) || (doc && doc.charPt && doc.charPt[para.charId]);
  const pct = (over && over.linePct) || (doc && doc.linePct && doc.linePct[para.paraId]);
  el.style.fontSize = pt ? (pt * 4 / 3).toFixed(1) + 'px' : '';
  el.style.lineHeight = pct ? (pct / 100).toFixed(2) : '';
  const al = doc && doc.paraAlign && doc.paraAlign[para.paraId];
  el.style.textAlign = ({ 1: 'left', 2: 'right', 3: 'center' })[al] || '';
}

/**
 * 그 문단의 첫 줄이 단 안에서 차지하는 가로 구간 (HWPUNIT).
 * PARA_LINE_SEG 36B 씩: 24번지 = 시작 위치, 28번지 = 폭.
 * 글자를 고치면 낡은 값이 되지만 **구간**은 글자 수와 무관하게 그대로다.
 */
function lineBox(doc, para) {
  const recs = doc.sections[para.si].recs, lv = recs[para.rec].level;
  for (let i = para.rec + 1; i < recs.length && recs[i].level > lv; i++) {
    if (recs[i].tag !== 69 || recs[i].level !== lv + 1 || recs[i].data.length < 36) continue;
    const d = recs[i].data, v = new DataView(d.buffer, d.byteOffset, d.byteLength);
    return { start: v.getInt32(24, true), width: v.getInt32(28, true) };
  }
  return null;
}

/**
 * 화면에서 놓은 가로 위치(줄 왼쪽 기준 px)를 파일의 가로 오프셋(단 왼쪽 기준)으로.
 *
 * 화면과 한글은 글꼴 폭도, 줄 폭도 다르다. 그래서 **정렬이 붙는 쪽 끝**에서 잰다 —
 * 오른쪽 정렬 줄의 「(서명)」 은 오른쪽 끝에서 몇 mm 인지가 양쪽에서 거의 같다.
 */
function floatOffX(doc, ph) {
  const inner = ph.host.clientWidth - PARA_PAD.x * 2;
  const x = ph.x - PARA_PAD.x;
  const box = lineBox(doc, ph.para) || { start: 0, width: pxToHwp(inner) };
  const al = doc.paraAlign && doc.paraAlign[ph.para.paraId];
  if (al === 2) return box.start + box.width - pxToHwp(inner - x);
  if (al === 3) return box.start + Math.round(box.width / 2) + pxToHwp(x - inner / 2);
  return box.start + pxToHwp(x);
}

/**
 * 파일에 **이미 들어 있는** 그림을 화면에 그린다.
 *
 * 이게 없으면 사진을 넣어 저장한 뒤 다시 열었을 때 아무것도 안 보인다 —
 * 파일에는 멀쩡히 들어 있는데 화면만 모르는 것이라 버그로 착각하기 딱 좋다.
 */
function existingPics(host, para, doc) {
  for (const pic of para.pics || []) {
    const bin = doc && doc.bins && doc.bins.get(pic.binId);
    if (!bin) continue;
    if (!picUrls.has(pic.binId))
      picUrls.set(pic.binId, URL.createObjectURL(new Blob([bin.bytes], { type: 'image/' + bin.ext })));

    const box = document.createElement('div');
    box.className = 'inpic';
    const img = document.createElement('img');
    img.src = picUrls.get(pic.binId);
    img.alt = T.picInDoc;
    img.style.width = Math.round(hwpToPx(pic.w)) + 'px';
    img.style.height = Math.round(hwpToPx(pic.h)) + 'px';
    box.appendChild(img);

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'unpic';
    del.textContent = T.remove;
    del.title = T.removePicTitle;
    box.appendChild(del);

    /* 지우는 게 아니라 **뺄 것으로 표시**한다. 저장할 때 한꺼번에 처리하고,
     * 그 전까지는 되돌릴 수 있다. 한 번 누르면 끝인 동작은 무섭다. */
    del.addEventListener('click', (e) => {
      e.preventDefault(); e.stopPropagation();
      removals.push({ para, binId: pic.binId });
      const gone = document.createElement('span');
      gone.className = 'gonepic';
      gone.textContent = T.picRemoved + ' ';
      const undo = document.createElement('button');
      undo.type = 'button';
      undo.textContent = T.undo;
      undo.addEventListener('click', (ev) => {
        ev.preventDefault(); ev.stopPropagation();
        removals = removals.filter((r) => !(r.para === para && r.binId === pic.binId));
        gone.replaceWith(box);
        updateCount();
      });
      gone.appendChild(undo);
      box.replaceWith(gone);
      updateCount();
    });

    host.appendChild(box);
  }
}


/**
 * 칸 하나의 속을 채운다. 처음 그릴 때와 **사진을 뺐을 때** 둘 다 여기를 쓴다.
 *
 * 다시 채우기 전에 이 칸이 갖고 있던 입력칸 기록을 지운다.
 * 안 지우면 화면에 없는 유령 입력칸이 fields 에 남아 저장에 섞인다.
 */
function fillCell(td, c) {
  const mine = new Set(c.paras);
  fields = fields.filter((f) => !mine.has(f.para));
  blanks = blanks.filter((f) => !mine.has(f.para));
  td.textContent = '';

  const paras = c.paras.length ? c.paras : [];
  if (!paras.length) td.textContent = c.text;
  for (const para of paras) {
    // 파일에 이미 들어 있는 그림. 이게 빠져 있어서 저장한 사진이 다시 열면 안 보였다.
    existingPics(td, para, current && current.doc);

    // 표를 품은 문단은 입력칸으로 만들지 않는다 — 글자를 갈아끼우면 그 표가
    // 떨어져 나간다. 대신 그 표를 그린다. (셀 안의 표는 이렇게 딸려 나온다)
    if (para.tables.length) {
      for (const inner of para.tables) if (inner) td.appendChild(renderTable(inner));
      continue;
    }
    // 글자 속에 그림·각주 참조가 든 문단도 못 고친다. 글자로만 보여 준다.
    if (para.hasCtrl) {
      const sp = document.createElement('div');
      sp.style.padding = '6px 7px';
      sp.textContent = para.text.replace(/\n+$/, '');
      if (sp.textContent) td.appendChild(sp);
      continue;
    }
    const original = para.text.replace(/\n+$/, '');
    const empty = !original.trim();
    // 「□필  □미필」 처럼 네모가 든 문단은 입력칸 대신 체크칸으로 만든다.
    const field = BOX.test(original) ? makeChecks(td, para, original)
                                     : makeInput(td, para, original, empty);
    fields.push(field);
    if (empty) blanks.push(field);
  }
}
/*
 * 네모(U+25A1)는 도형이 아니라 **그냥 글자**다. 체크한다는 건 □ 를 ■ 로 바꾸는 것뿐이라
 * 파일 구조를 건드릴 일이 없다 — 글자 교체 하나로 끝난다.
 *
 * ▣(U+25A3)는 제외한다. 「▣ 성    명 :」 처럼 항목 머리표로 쓰이지 체크칸이 아니다.
 */
const BOX = /□/;

/**
 * 본문 문단 하나를 제자리에서 고칠 수 있게 만든다.
 *
 * 입력 상자로 바꾸지 않는 이유가 둘이다. 문서가 문서처럼 안 읽히고,
 * 상자는 한 줄이라 길게 감기는 문단이 잘린다.
 *
 * plaintext-only 는 붙여넣기까지 글자만 받는다. 못 쓰는 브라우저에서는
 * 보통 편집으로 떨어지는데, 값을 textContent 로만 읽으므로 결과는 같다.
 */
function makeParaEdit(p, para, original) {
  p.classList.add('edit');
  p.setAttribute('contenteditable', 'plaintext-only');
  if (p.contentEditable !== 'plaintext-only') p.setAttribute('contenteditable', 'true');
  p.setAttribute('role', 'textbox');
  p.spellcheck = false;

  // 문단 하나가 한 줄이다. 줄바꿈이 들어가면 저장할 때 문단이 갈라진다.
  p._para = para;
  p.addEventListener('focus', () => pickLine(para, p, p));
  p.addEventListener('keydown', (e) => { if (e.key === 'Enter') e.preventDefault(); });
  // 떠 있는 그림 위젯의 글자(「38×21mm 빼기」)는 문단 글자가 아니다.
  const read = () => [...p.childNodes]
    .filter((n) => !(n.classList && n.classList.contains('photo')))
    .map((n) => n.textContent).join('');
  p.addEventListener('input', () => {
    p.classList.toggle('dirty', trimEnd(read()) !== trimEnd(original));
    // 一太郎: 빈칸(공백) 수보다 많이 쓰면 저장할 수 없다. 저장을 눌러 보기 전에 그 줄에서 바로 알린다.
    if (para.jtd) {
      const over = jtdFit(para.jtd.text, read()) === null;
      p.classList.toggle('over', over);
      p.title = over ? T.overLength : '';
    }
    updateCount();
  });
  return { para, original, empty: false, read };
}

function makeInput(td, para, original, empty) {
  const el = document.createElement('div');
  el.className = 'cin ' + (empty ? 'blank' : 'filled');
  el.textContent = original;
  el.setAttribute('contenteditable', 'plaintext-only');
  if (el.contentEditable !== 'plaintext-only') el.setAttribute('contenteditable', 'true');
  el.setAttribute('role', 'textbox');
  el.spellcheck = false;
  el._para = para;

  // 칸 하나가 문단 하나다. 줄바꿈이 들어가면 저장할 때 문단이 갈라진다.
  el.addEventListener('keydown', (e) => { if (e.key === 'Enter') e.preventDefault(); });
  const read = () => el.textContent;
  el.addEventListener('input', () => {
    if (!empty) el.classList.toggle('dirty', trimEnd(read()) !== trimEnd(original));
    updateCount();
  });
  el.addEventListener('focus', () => pickLine(para, el, td));
  styleLike(el, para, current && current.doc);
  td.appendChild(el);
  return { para, original, empty, read };
}

function makeChecks(td, para, original) {
  // □ 로 쪼개면 사이사이 글자가 조각으로 남는다. 되돌릴 때 그 조각을 그대로 이어 붙여
  // 원래 모양을 한 글자도 잃지 않고 복원한다.
  const segs = original.split('□');
  const wrap = document.createElement('div');
  wrap.className = 'checks';
  const boxes = [];
  segs.forEach((seg, i) => {
    if (i > 0) {
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.addEventListener('change', updateCount);
      wrap.appendChild(cb);
      boxes.push(cb);
    }
    if (seg.trim()) {
      const lab = document.createElement('span');
      lab.textContent = seg.trim();
      wrap.appendChild(lab);
    }
  });
  td.appendChild(wrap);
  const read = () => segs.reduce((acc, seg, i) =>
    i === 0 ? seg : acc + (boxes[i - 1].checked ? '■' : '□') + seg, '');
  return { para, original, empty: false, read };
}


/* ─── 사진 · 서명 · 서식 ───────────────────────────────────────────────
 * 엔진은 「어느 문단에 · 어디쯤에 · 얼마나 크게 · 무슨 바이트로」 만 받는다.
 * 화면이 하는 일은 그걸 모으는 것뿐이다.
 *
 * 사진 바이트는 **저장할 때** 만든다. 모서리를 끌 때마다 다시 구우면 손이 느려지는데
 * 어차피 쓰이는 건 마지막 값 하나다. 서명은 이미 PNG 라 그대로 쓴다 —
 * JPEG 으로 다시 구우면 투명이 날아가 흰 네모가 된다.
 * ─────────────────────────────────────────────────────────────────── */

let photos = [];      // { host, para, cell, bmp, url, scale, at, png? }
let picking = null;   // 고른 그림. 들어갈 자리를 기다리는 중이다
let formats = [];     // { para, sizePt, linePct, el }
let selected = null;  // 지금 고른 줄 { para, el, cell }
let removals = [];    // 뺄 것으로 표시한 그림 { para, binId }
const picUrls = new Map();   // 파일에 이미 든 그림의 blob 주소. 문서마다 새로 만든다

const photoParas = () => new Set(photos.map((p) => p.para));
const MM = 7200 / 25.4;
const DEFAULT_BOX = { width: 40 * MM, height: 40 * MM };   // 표 밖에 넣을 때의 기준 상자
const pxToHwp = (v) => Math.round(v * 7200 / 96);
/* .para.edit 의 안쪽 여백. 글자는 이만큼 들어가서 시작하므로 오프셋에서 뺀다.
 * CSS 의 `padding: 1px 4px` 와 같이 바꿔야 한다. */
const PARA_PAD = { x: 4, y: 1 };

/** 칸 안에 다 들어가게(contain) 맞춘다. 잘라내지 않는다 — 얼굴이 잘린다. */
function fitToCell(bmp, cell, scale) {
  const c = cell || DEFAULT_BOX;
  const k = Math.min(c.width * 0.94 / bmp.width, c.height * 0.94 / bmp.height) * scale;
  return { w: Math.max(1, Math.round(bmp.width * k)), h: Math.max(1, Math.round(bmp.height * k)) };
}

const toBlobP = (cv, type, q) => new Promise((r) => cv.toBlob(r, type, q));

/**
 * 저장 직전에 JPEG 바이트를 만든다. 기본 300dpi.
 *
 * 통에 넣으려면 4096B 이상이어야 한다. 작으면 품질을 올리고, 그래도 모자라면
 * 화소를 키운다 — **물리 크기는 안 건드린다.** 종이에 찍히는 크기가 달라지면 안 된다.
 */
async function encodePhoto(bmp, w, h) {
  for (const dpi of [300, 600, 1200]) {
    const pxW = Math.max(1, Math.round(w / 7200 * dpi));
    const pxH = Math.max(1, Math.round(h / 7200 * dpi));
    const cv = document.createElement('canvas');
    cv.width = pxW; cv.height = pxH;
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, pxW, pxH);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bmp, 0, 0, pxW, pxH);
    for (const q of [0.92, 1]) {
      const blob = await toBlobP(cv, 'image/jpeg', q);
      if (blob.size >= 4096)
        return { bytes: new Uint8Array(await blob.arrayBuffer()), ext: 'jpg', pxW, pxH };
    }
  }
  throw new Error('PHOTO_TOO_SMALL');
}

/** 사진 하나의 위젯. 크기는 오른쪽 아래 모서리를 끌어서 바꾼다. */
function photoWidget(ph) {
  const box = document.createElement('div');
  box.className = 'photo';

  const pf = document.createElement('div');
  pf.className = 'pf';
  const img = document.createElement('img');
  img.src = ph.url;
  img.alt = ph.png ? T.signature : T.photoAlt;
  pf.appendChild(img);

  const grip = document.createElement('button');
  grip.type = 'button';
  grip.className = 'grip';
  grip.setAttribute('aria-label', T.resizeGrip);
  pf.appendChild(grip);
  box.appendChild(pf);

  const tools = document.createElement('div');
  tools.className = 'tools';
  const sz = document.createElement('span');
  sz.className = 'sz';
  const del = document.createElement('button');
  del.type = 'button';
  del.textContent = T.remove;
  del.addEventListener('click', (e) => { e.stopPropagation(); e.preventDefault(); removePhoto(ph); });
  tools.append(sz, del);
  box.appendChild(tools);

  const base = fitToCell(ph.bmp, ph.cell, 1);
  const basePx = Math.max(1, hwpToPx(base.w));
  const apply = () => {
    const { w, h } = fitToCell(ph.bmp, ph.cell, ph.scale);
    img.style.width = Math.round(hwpToPx(w)) + 'px';
    img.style.height = Math.round(hwpToPx(h)) + 'px';
    sz.textContent = (w / MM).toFixed(0) + '×' + (h / MM).toFixed(0) + 'mm';
  };
  const setScale = (v) => { ph.scale = Math.min(1, Math.max(0.2, v)); apply(); };

  let from = null;
  grip.addEventListener('pointerdown', (e) => {
    e.preventDefault(); e.stopPropagation();
    from = { x: e.clientX, y: e.clientY, w: basePx * ph.scale };
    box.classList.add('sizing');
    grip.setPointerCapture(e.pointerId);
  });
  grip.addEventListener('pointermove', (e) => {
    if (!from) return;
    const grow = Math.max(e.clientX - from.x, (e.clientY - from.y) * (base.w / base.h));
    setScale((from.w + grow) / basePx);
  });
  for (const ev of ['pointerup', 'pointercancel'])
    grip.addEventListener(ev, () => { from = null; box.classList.remove('sizing'); });

  /* 떠 있는 그림은 그림을 잡고 끌어 옮긴다. 화면이 원본 배치의 근사치라
   * 처음 놓은 자리가 조금 어긋나 보일 수 있고, 그걸 손으로 맞출 수 있어야 한다. */
  if (ph.float) {
    let grab = null;
    img.draggable = false;
    img.addEventListener('pointerdown', (e) => {
      e.preventDefault(); e.stopPropagation();
      grab = { x: e.clientX - ph.x, y: e.clientY - ph.y };
      img.setPointerCapture(e.pointerId);
    });
    img.addEventListener('pointermove', (e) => {
      if (!grab) return;
      ph.x = e.clientX - grab.x; ph.y = e.clientY - grab.y;
      box.style.left = ph.x + 'px'; box.style.top = ph.y + 'px';
    });
    for (const ev of ['pointerup', 'pointercancel'])
      img.addEventListener(ev, () => { grab = null; });
  }

  /* 마우스가 유일한 길이면 안 된다. 방향키로도 되게 둔다. */
  grip.addEventListener('keydown', (e) => {
    const step = (e.shiftKey ? 0.1 : 0.02) *
      ({ ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 }[e.key] || 0);
    if (!step) return;
    e.preventDefault();
    setScale(ph.scale + step);
  });

  apply();
  return box;
}

function removePhoto(ph) {
  photos = photos.filter((x) => x !== ph);
  URL.revokeObjectURL(ph.url);
  if (ph.cell) {
    fillCell(ph.host, ph.cell);                 // 그 칸만 원래대로 되돌린다
  } else if (ph.float) {
    ph.box.remove();                            // 글자는 안 건드렸으니 위젯만 걷는다
    ph.host.classList.remove('hasfloat');
  } else {
    ph.host.querySelector('.photo')?.remove();  // 표 밖 줄은 글자를 다시 열어 준다
    ph.host.setAttribute('contenteditable', ph.host.dataset.ce || 'true');
  }
  updateCount();
}

/** 클릭한 지점이 그 줄의 몇 번째 글자인지. 서명을 「(서명)」 앞에 놓으려면 필요하다. */
function caretIn(el, e) {
  const r = document.caretRangeFromPoint ? document.caretRangeFromPoint(e.clientX, e.clientY)
    : (document.caretPositionFromPoint && document.caretPositionFromPoint(e.clientX, e.clientY));
  if (!r) return (el.textContent || '').length;
  const off = r.offset !== undefined ? r.offset : r.startOffset;
  return Math.min(Math.max(0, off), (el.textContent || '').length);
}

function place(host, para, cell, at, src = picking, pt = null) {
  const already = photos.find((x) => x.para === para);
  if (already) removePhoto(already);

  const ph = { host, para, cell, at, bmp: src.bmp, url: src.url, png: src.png, scale: 1 };
  /* 표 밖의 글자 있는 줄은 **글 앞으로** 띄운다. 「성명   (서명)」 위에 겹쳐야 하는데
   * 글자처럼 끼우면 옆 글자를 밀어낸다. 빈 칸(PARA_TEXT 없음)은 예전 방식 그대로. */
  ph.float = !cell && para.textRec >= 0 && !!pt;
  photos.push(ph);

  if (cell) {
    host.textContent = '';
    host.appendChild(photoWidget(ph));
  } else if (ph.float) {
    // 놓은 지점이 그림 한가운데가 되게. 좌표는 줄의 왼쪽 위 기준 px.
    const { w, h } = fitToCell(ph.bmp, null, 1);
    const r = host.getBoundingClientRect();
    ph.x = Math.round(pt.x - r.left - hwpToPx(w) / 2);
    ph.y = Math.round(pt.y - r.top - hwpToPx(h) / 2);
    const box = photoWidget(ph);
    box.classList.add('float');
    box.contentEditable = 'false';
    box.style.left = ph.x + 'px'; box.style.top = ph.y + 'px';
    ph.box = box;
    host.classList.add('hasfloat');
    host.appendChild(box);
  } else {
    // 표 밖 줄은 글자를 남겨 두고 그 뒤에 붙인다. 대신 그 줄은 글자 편집을 닫는다.
    host.dataset.ce = host.getAttribute('contenteditable') || 'true';
    host.setAttribute('contenteditable', 'false');
    const w = photoWidget(ph);
    w.style.display = 'inline-block';
    w.style.verticalAlign = 'middle';
    host.appendChild(w);
  }

  if (src === picking) picking = null;     // 조각은 남겨 둔다. 여러 곳에 놓을 수 있다
  $('work').classList.remove('picking');
  $('err').textContent = '';
  updateCount();
}

function startPicking(what) {
  $('work').classList.add('picking');
  $('err').innerHTML = fmt(T.pickHtml, { what });
}
function stopPicking() {
  if (picking) URL.revokeObjectURL(picking.url);
  picking = null;
  $('work').classList.remove('picking');
  $('err').textContent = '';
}

/* ── 자필 서명 ──────────────────────────────────────────────────────
 * 캔버스에 그린 선을 **투명 PNG** 로 굽는다. JPEG 으로 구우면 배경이 흰 네모가
 * 되어 서명란 위에 종이를 덧댄 꼴이 된다.
 *
 * 그린 부분만 잘라 낸다. 빈 여백까지 넣으면 칸 안에서 서명이 작아진다.
 */
const sig = { down: false, drew: false };

function sigCtx() {
  const cv = $('sigpad');
  const ctx = cv.getContext('2d');
  ctx.lineWidth = 4; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.strokeStyle = '#111';
  return ctx;
}
function sigPos(e) {
  const cv = $('sigpad'), r = cv.getBoundingClientRect();
  return { x: (e.clientX - r.left) * cv.width / r.width, y: (e.clientY - r.top) * cv.height / r.height };
}
function sigClear() {
  const cv = $('sigpad');
  cv.getContext('2d').clearRect(0, 0, cv.width, cv.height);
  sig.drew = false;
  cv.classList.remove('has');
  const chip = $('sigchip');
  if (chip._src) URL.revokeObjectURL(chip._src.url);
  chip._src = null;
  chip.classList.remove('on');
}
/** 그려진 화소의 테두리 상자. 투명한 데는 알파가 0 이라 그걸로 찾는다. */
function sigBounds() {
  const cv = $('sigpad');
  const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
  let x0 = cv.width, y0 = cv.height, x1 = -1, y1 = -1;
  for (let y = 0; y < cv.height; y++)
    for (let x = 0; x < cv.width; x++)
      if (d[(y * cv.width + x) * 4 + 3] > 8) {
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
  if (x1 < 0) return null;
  const pad = 6;
  x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad);
  x1 = Math.min(cv.width - 1, x1 + pad); y1 = Math.min(cv.height - 1, y1 + pad);
  return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/* ── 끌어다 놓기 ────────────────────────────────────────────────────
 * 「그리고 → 버튼 누르고 → 자리 클릭」 은 단계가 많아 어디에 쓰는지 모른다.
 * 눈에 보이는 조각을 만들어 **그대로 끌어다 놓게** 한다. 클릭 방식도 남겨 둔다.
 *
 * 탐색기에서 사진을 바로 끌어오는 것도 같은 자리에서 받는다 —
 * 그게 사람들이 제일 먼저 시도하는 동작이다.
 */
let dragSrc = null;       // 지금 끌고 있는 것 { bmp, url, png? }

function showChip(id, src, kind) {
  const el = $(id);
  el.querySelector('img').src = src.url;
  el.classList.add('on');
  el._src = src;
  el._kind = kind;
}

function bindChip(id, kind) {
  const el = $(id);
  el.addEventListener('dragstart', (e) => {
    if (!el._src) return;
    dragSrc = el._src;
    e.dataTransfer.effectAllowed = 'copy';
    e.dataTransfer.setData('text/plain', kind);      // 파이어폭스는 뭐라도 담아야 끌린다
    e.dataTransfer.setDragImage(el.querySelector('img'), 20, 15);
  });
  el.addEventListener('dragend', () => { dragSrc = null; clearDropOn(); });
  // 끌기가 안 되는 환경도 있다. 누르면 예전처럼 자리 고르기로 들어간다.
  el.addEventListener('click', () => {
    if (!el._src) return;
    picking = el._src;
    startPicking(kind);
  });
}

const clearDropOn = () =>
  document.querySelectorAll('.dropon').forEach((x) => x.classList.remove('dropon'));

/** 놓을 수 있는 자리인가. 표 안의 칸이거나 표 밖의 고칠 수 있는 줄. */
function dropTarget(e) {
  const td = e.target.closest && e.target.closest('td.cell');
  if (td) return td._para ? { host: td, para: td._para, cell: td._cell, at: 0 } : null;
  const p = e.target.closest && e.target.closest('.para.edit');
  if (p && p._para) return { host: p, para: p._para, cell: null, at: caretIn(p, e) };
  return null;
}

const draggingImage = (e) =>
  dragSrc || [...(e.dataTransfer?.items || [])].some((i) => i.kind === 'file' && i.type.startsWith('image/'));

/* ── 서식 고르기 ───────────────────────────────────────────────────── */

/** 지금 손이 가 있는 줄을 옆 패널에 비춘다. */
function pickLine(para, el, host) {
  selected = { para, el, host };
  const t = (el.value !== undefined ? el.value : el.textContent || '').trim();
  $('selinfo').textContent = t || T.emptyCell;
  $('selinfo').classList.toggle('none', !t);
  const f = formats.find((x) => x.para === para);
  const d = current.doc;
  const nowPt = d.charPt && d.charPt[para.charId];
  const nowPct = d.linePct && d.linePct[para.paraId];
  $('fnote').textContent = (nowPt ? fmt(T.nowPt, { pt: nowPt }) : '') +
    (nowPct ? fmt(T.nowLine, { pct: nowPct }) : '') || T.sizeNote;
  $('fsize').value = f && f.sizePt != null ? String(f.sizePt) : '';
  $('fline').value = f && f.linePct != null ? String(f.linePct) : '';
  $('fapply').disabled = false;
  $('fclear').disabled = !f;
}

function applyFormat() {
  if (!selected) return;
  const sizePt = $('fsize').value ? +$('fsize').value : null;
  const linePct = $('fline').value ? +$('fline').value : null;
  formats = formats.filter((f) => f.para !== selected.para);
  selected.host.classList.remove('fmt');
  if (sizePt != null || linePct != null) {
    formats.push({ para: selected.para, sizePt, linePct });
    selected.host.classList.add('fmt');
  }
  // 누르는 즉시 화면에도 입힌다. 저장해 봐야 아는 기능은 쓸 수 없다.
  styleLike(selected.el, selected.para, current.doc, { sizePt, linePct });
  $('fclear').disabled = !(sizePt != null || linePct != null);
  updateCount();
}

function changedFields() {
  // 사진을 넣은 문단은 글자를 안 건드린다. 같은 문단에 둘 다 하면 서로를 지운다.
  // 떠 있는 그림은 예외다 — 글자를 먼저 갈고 제어문자를 **맨 뒤에** 붙이므로 안 부딪친다.
  const used = new Set(photos.filter((p) => !p.float).map((p) => p.para));
  // 끝 공백은 양쪽 다 떼고 비교한다. 원본만 안 떼면 「▣ 성    명 : 」 처럼 공백으로 끝나는 줄이
  // 손대지 않았는데도 「고친 칸」 으로 잡혀, 저장할 때 멋대로 다시 쓰였다 (2026-09-16).
  return fields.filter((f) => !used.has(f.para) && trimEnd(f.read()) !== trimEnd(f.original));
}

function updateCount() {
  const done = blanks.filter((f) => f.read().trim()).length;
  const changed = changedFields().length;
  // 표 칸이 없는 문서(一太郎 등)는 「빈칸 0/0」 대신 고친 줄 수만 보여 준다
  $('fcount').textContent = (blanks.length
      ? fmt(T.countBlanks, { done, total: blanks.length }) + (changed > done ? fmt(T.countChanged, { n: changed }) : '')
      : fmt(T.countEdited, { n: changed }))
    + (photos.length ? fmt(T.countPics, { n: photos.length }) : '')
    + (formats.length ? fmt(T.countFormats, { n: formats.length }) : '')
    + (removals.length ? fmt(T.countRemovals, { n: removals.length }) : '');
  $('save').disabled = changed === 0 && photos.length === 0 && formats.length === 0 && removals.length === 0;
}

async function save() {
  const btn = $('save');
  const edits = changedFields().map((f) => ({ para: f.para, text: f.read() }));
  if (!edits.length && !photos.length && !formats.length && !removals.length) return;

  btn.disabled = true;
  btn.textContent = T.saving;
  try {
    // 사진 바이트는 여기서 처음 만든다. 화면에서는 원본 비트맵만 들고 있었다.
    const pics = [];
    for (const ph of photos) {
      const { w, h } = fitToCell(ph.bmp, ph.cell, ph.scale);
      // 서명은 이미 PNG 다. 다시 구우면 투명이 날아가 흰 네모가 된다.
      const enc = ph.png
        ? { bytes: padPng(ph.png.bytes, 4096), ext: 'png', pxW: ph.png.pxW, pxH: ph.png.pxH }
        : await encodePhoto(ph.bmp, w, h);
      pics.push(ph.float
        ? { ...enc, para: ph.para, w, h, at: Infinity, attr: PIC_ATTR_FRONT,
            offX: floatOffX(current.doc, ph), offY: pxToHwp(ph.y - PARA_PAD.y) }
        : { ...enc, para: ph.para, w, h, at: ph.at || 0 });
    }
    const bytes = await saveDocument(current.doc, edits, pics, formats, removals);
    // 확장자는 문서 형식을 따른다. 예전엔 hwpx 도 「_작성.hwp」 로 내려받아져 안 열렸다.
    const ext = { hwpx: 'hwpx', jtd: 'jtd' }[current.doc.kind] || 'hwp';
    const type = { hwpx: 'application/hwp+zip', jtd: 'application/x-js-taro' }[ext] || 'application/x-hwp';
    const url = URL.createObjectURL(new Blob([bytes], { type }));
    const a = document.createElement('a');
    a.href = url;
    a.download = current.name.replace(/\.(hwpx?|jtd|jtt)$/i, '') + T.fileSuffix + '.' + ext;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    btn.textContent = saveLabel(current.doc);
  } catch (e) {
    const code = String(e.message).split(':')[0];
    $('err').innerHTML = fmt(T.saveFailHtml, { msg: T['saveErr.' + code] || e.message });
    btn.textContent = saveLabel(current.doc);
    btn.disabled = false;
  }
}

function fail(code, detail) {
  const m = T['openErr.' + code + '.t']
    ? [T['openErr.' + code + '.t'], T['openErr.' + code + '.d']]
    : [T.openFail, detail || code];
  $('err').innerHTML = `<div class="msg ${code === 'HWPX' ? 'warn' : 'err'}"><b>${m[0]}</b><br>${m[1]}</div>`;
}


async function load(file) {
  $('err').textContent = '';
  try {
    const doc = await openDocument(await file.arrayBuffer());
    render(doc, file.name);
  } catch (e) {
    const code = String(e.message).split(':')[0];
    fail(code, e.message);
  }
}

/* 받는 통로 셋 — 드롭 · 클릭 · 붙여넣기. 하나만 두면 꼭 다른 걸 시도한다. */
const drop = $('drop');
drop.addEventListener('click', () => $('file').click());
drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('file').click(); } });
$('file').addEventListener('change', (e) => e.target.files[0] && load(e.target.files[0]));
for (const ev of ['dragenter', 'dragover'])
  document.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); });
for (const ev of ['dragleave', 'drop'])
  document.addEventListener(ev, (e) => { e.preventDefault(); if (e.type === 'dragleave' && e.relatedTarget) return; drop.classList.remove('over'); });
document.addEventListener('drop', (e) => {
  const f = e.dataTransfer.files[0];
  // 사진은 문서가 아니다. 본문에 떨군 것이면 그쪽에서 이미 처리했다.
  if (f && !f.type.startsWith('image/')) load(f);
});
document.addEventListener('paste', (e) => { const f = e.clipboardData.files[0]; if (f) load(f); });
$('reset').addEventListener('click', () => location.reload());
$('save').addEventListener('click', save);

/* 사진 고르기 → 조각이 생긴다. 그 조각을 끌어다 놓거나 눌러서 자리를 고른다. */
$('addphoto').addEventListener('click', () => $('photofile').click());
$('photofile').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  e.target.value = '';                       // 같은 파일을 또 골라도 이벤트가 오게
  if (f) await usePhotoFile(f);
});

async function usePhotoFile(f) {
  try {
    // from-image: 휴대폰 사진은 EXIF 로 눕혀져 온다. 여기서 세워 둔다.
    const bmp = await createImageBitmap(f, { imageOrientation: 'from-image' });
    const chip = $('photochip');
    if (chip._src) URL.revokeObjectURL(chip._src.url);
    showChip('photochip', { bmp, url: URL.createObjectURL(f) }, T.photo);
    return chip._src;
  } catch (err) {
    $('err').innerHTML = fmt(T.photoFailHtml, { msg: err.message });
    return null;
  }
}

/* ── 서명판 ── 그리는 즉시 아래에 조각이 생긴다 */
$('sigpad').addEventListener('pointerdown', (e) => {
  e.preventDefault();
  sig.down = true;
  const { x, y } = sigPos(e);
  const ctx = sigCtx();
  ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + 0.1, y);   // 점 하나도 찍히게
  ctx.stroke();
  sig.drew = true;
  $('sigpad').classList.add('has');
  $('sigpad').setPointerCapture(e.pointerId);
});
$('sigpad').addEventListener('pointermove', (e) => {
  if (!sig.down) return;
  const { x, y } = sigPos(e);
  const ctx = sigCtx();
  ctx.lineTo(x, y); ctx.stroke();
});
for (const ev of ['pointerup', 'pointercancel'])
  $('sigpad').addEventListener(ev, () => {
    if (!sig.down) return;
    sig.down = false;
    if (sig.drew) syncSigChip();
  });
$('sigclear').addEventListener('click', sigClear);

/** 그린 부분만 잘라 투명 PNG 조각으로 만든다. 획을 더할 때마다 다시 만든다. */
async function syncSigChip() {
  const b = sigBounds();
  if (!b) return;
  const out = document.createElement('canvas');
  out.width = b.w; out.height = b.h;
  out.getContext('2d').drawImage($('sigpad'), b.x, b.y, b.w, b.h, 0, 0, b.w, b.h);
  const blob = await toBlobP(out, 'image/png');
  const chip = $('sigchip');
  if (chip._src) URL.revokeObjectURL(chip._src.url);
  showChip('sigchip', {
    bmp: await createImageBitmap(blob),
    url: URL.createObjectURL(blob),
    png: { bytes: new Uint8Array(await blob.arrayBuffer()), pxW: out.width, pxH: out.height },
  }, T.signature);
}

bindChip('photochip', T.photo);
bindChip('sigchip', T.signature);

/* ── 놓기 ── 패널 조각도 받고 탐색기에서 온 사진 파일도 받는다 ── */
$('doc').addEventListener('dragover', (e) => {
  if (!draggingImage(e)) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
  const t = dropTarget(e);
  clearDropOn();
  if (t) t.host.classList.add('dropon');
});
$('doc').addEventListener('dragleave', (e) => { if (!e.relatedTarget) clearDropOn(); });
$('doc').addEventListener('drop', async (e) => {
  if (!draggingImage(e)) return;
  e.preventDefault();
  e.stopPropagation();                      // 문서 열기 쪽으로 안 넘어가게
  clearDropOn();
  const t = dropTarget(e);
  if (!t) return;

  let src = dragSrc;
  if (!src) {
    const f = [...e.dataTransfer.files].find((x) => x.type.startsWith('image/'));
    if (!f) return;
    src = await usePhotoFile(f);            // 탐색기에서 온 파일. 조각도 같이 만든다
  }
  if (src) place(t.host, t.para, t.cell, t.at, src, { x: e.clientX, y: e.clientY });
  dragSrc = null;
});

/* 클릭으로 고르는 길도 남겨 둔다 */
$('doc').addEventListener('click', (e) => {
  if (!picking) return;
  const t = dropTarget(e);
  if (!t) {
    if (e.target.closest('td.cell'))
      $('err').innerHTML = T.cellNoPhotoHtml;
    return;
  }
  e.preventDefault();
  place(t.host, t.para, t.cell, t.at, picking, { x: e.clientX, y: e.clientY });
});

$('fapply').addEventListener('click', applyFormat);
$('fclear').addEventListener('click', () => {
  $('fsize').value = ''; $('fline').value = '';
  applyFormat();
});

document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && picking) stopPicking(); });
