/*
 * 끝에서 끝까지: 실제 브라우저에서 hwp 를 열고 → 빈칸을 채우고 → 저장 → 내려받은 파일을 엔진으로 다시 연다.
 *
 *   npm run build && npx astro preview --port 4329   (다른 창)
 *   node test/e2e.mjs <hwp 파일> [언어=ko]
 *
 * 설치 없이 돌리려고 Playwright 대신 크롬의 DevTools 프로토콜을 직접 쓴다 (Node 의 전역 WebSocket).
 * 화면이 멀쩡해 보이는지가 아니라 **저장한 파일에 글자가 들어갔는지**를 본다.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { openDocument } from '../src/scripts/engine.js';

const file = path.resolve(process.argv[2] || '');
const lang = process.argv[3] || 'ko';
const BASE = process.env.E2E_URL || 'http://localhost:4329/doceditor';
const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
if (!fs.existsSync(file)) { console.error('쓰기: node test/e2e.mjs <hwp 파일> [언어]'); process.exit(1); }

const dl = fs.mkdtempSync(path.join(os.tmpdir(), 'doceditor-e2e-'));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'doceditor-chrome-'));
const port = 9300 + Math.floor(Math.random() * 500);
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', `--remote-debugging-port=${port}`,
  `--user-data-dir=${profile}`, '--no-first-run', 'about:blank'], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ws, seq = 0;
const pending = new Map();
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++seq;
  pending.set(id, { resolve, reject });
  ws.send(JSON.stringify({ id, method, params }));
});
const evaluate = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
};
async function waitFor(expr, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await evaluate(expr)) return true; await sleep(150); }
  throw new Error('시간 초과: ' + expr);
}

let failed = false;
const check = (ok, name, detail = '') => { console.log(`${ok ? 'ok ' : '✗  '} ${name}${detail ? '  ' + detail : ''}`); if (!ok) failed = true; };

try {
  let target;
  for (let i = 0; i < 50 && !target; i++) {
    try { target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t) => t.type === 'page'); } catch {}
    if (!target) await sleep(200);
  }
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  const consoleErrors = [];
  ws.addEventListener('message', (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id); pending.delete(msg.id);
      msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
    } else if (msg.method === 'Runtime.exceptionThrown') {
      consoleErrors.push(msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text);
    }
  });
  await send('Runtime.enable');
  await send('Page.enable');
  await send('DOM.enable');
  await send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dl });

  await send('Page.navigate', { url: `${BASE}/${lang}` });
  await waitFor(`document.readyState === 'complete' && !!document.getElementById('file')`);
  await sleep(500);
  check(consoleErrors.length === 0, '페이지 로드 중 스크립트 오류 없음', consoleErrors.join(' | '));

  // 파일 넣기
  const { root } = await send('DOM.getDocument');
  const { nodeId } = await send('DOM.querySelector', { nodeId: root.nodeId, selector: '#file' });
  await send('DOM.setFileInputFiles', { nodeId, files: [file] });
  await evaluate(`document.getElementById('file').dispatchEvent(new Event('change', { bubbles: true }))`);
  await waitFor(`getComputedStyle(document.getElementById('work')).display !== 'none'`);
  const info = await evaluate(`({
    blanks: document.querySelectorAll('#doc .cin.blank').length,
    fields: document.querySelectorAll('#doc [contenteditable]').length,
    count: document.getElementById('fcount').textContent,
    save: document.getElementById('save').textContent,
    saveDisabled: document.getElementById('save').disabled,
    err: document.getElementById('err').textContent,
  })`);
  check(info.fields > 0, '문서가 열리고 입력칸이 생김', `입력칸 ${info.fields} · 빈칸 ${info.blanks} · "${info.count}"`);
  check(!info.err, '열기 오류 없음', info.err);
  check(/hwp|一太郎|Ichitaro/i.test(info.save), '저장 버튼 문구', `"${info.save}"`);
  // 아무것도 안 고쳤으면 저장할 게 없어야 한다. 끝 공백 비교가 어긋나 멋대로 「고친 칸」 이 잡힌 적이 있다.
  check(info.saveDisabled, '열자마자는 저장 버튼이 꺼져 있음 (손대지 않은 칸이 고친 칸으로 안 잡힘)', `"${info.count}"`);

  const isJtd = /\.jt[dt]$/i.test(file);
  let MARK = 'E2E검증' + Date.now().toString(36);
  if (isJtd) {
    // 一太郎: 빈칸(전각 공백 두 칸) 자리에 덮어쓴다. 넘치게 쓰면 그 줄이 빨개져야 한다.
    const r = await evaluate(`(() => {
      const el = [...document.querySelectorAll('#doc .para.edit')].find((p) => p.textContent.includes('　　'));
      if (!el) return { none: true };
      const orig = el.textContent;
      el.focus();
      el.textContent = orig + 'あふれるほど長い文字列あふれるほど長い文字列あふれるほど長い文字列'.repeat(4);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      const overShown = el.classList.contains('over');
      el.textContent = orig.replace('　　', '１８');
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return { overShown, overCleared: !el.classList.contains('over'), filled: el.textContent,
               enabled: !document.getElementById('save').disabled, sideOff: getComputedStyle(document.getElementById('side')).opacity < 1 };
    })()`);
    check(!r.none, '빈칸(전각 공백)이 있는 줄을 찾음');
    check(r.overShown && r.overCleared, '넘치게 쓰면 빨간 줄 · 맞추면 풀림');
    check(r.enabled, '고치면 저장 버튼이 켜짐');
    check(r.sideOff, '사진·서명·서식 패널은 꺼져 있음 (一太郎는 아직 미지원)');
    MARK = r.filled;
  } else {
    // 첫 빈칸에 글자 넣기
    const typed = await evaluate(`(() => {
      const el = document.querySelector('#doc .cin.blank') || document.querySelector('#doc [contenteditable]');
      el.focus(); el.textContent = ${JSON.stringify(MARK)};
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return !document.getElementById('save').disabled;
    })()`);
    check(typed, '글자를 넣으면 저장 버튼이 켜짐');
  }

  await evaluate(`document.getElementById('save').click()`);
  let saved;
  for (let i = 0; i < 100 && !saved; i++) {
    saved = fs.readdirSync(dl).find((f) => /\.(hwpx?|jtd)$/i.test(f));
    if (!saved) await sleep(200);
  }
  check(!!saved, '파일이 내려받아짐', saved || '');

  if (saved) {
    const b = fs.readFileSync(path.join(dl, saved));
    const doc = await openDocument(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
    // 문단·표·셀의 text 를 전부 훑는다. hwpx 는 XML 노드가 부모를 가리켜서 JSON.stringify 가 돌지 않는다.
    const seen = new WeakSet();
    const found = (function walk(v) {
      if (!v || typeof v !== 'object' || seen.has(v)) return false;
      seen.add(v);
      if (typeof v.text === 'string' && v.text.includes(MARK)) return true;
      for (const k of ['blocks', 'tables', 'cells', 'paras']) if (Array.isArray(v[k]) && v[k].some(walk)) return true;
      return Array.isArray(v) && v.some(walk);
    })(doc);
    check(found, '저장한 파일을 엔진으로 다시 열면 넣은 글자가 들어 있음', MARK);
  }
  check(consoleErrors.length === 0, '전 과정 스크립트 오류 없음', consoleErrors.join(' | '));
} catch (e) {
  console.error('✗   실행 실패:', e.message);
  failed = true;
} finally {
  try { ws?.close(); } catch {}
  chrome.kill();
  await sleep(300);
  for (const d of [dl, profile]) try { fs.rmSync(d, { recursive: true, force: true }); } catch {}
}
process.exit(failed ? 1 : 0);
