/*
 * npm run test:engine — 표본 폴더의 hwp·hwpx 로 읽기 · 저장 왕복을 돈다.
 * 윈도우의 npm 셸은 *.hwp 를 펼치지 못해서 파일 목록을 여기서 만든다.
 *
 *   HWP_SAMPLES=<폴더> npm run test:engine     (기본: 사용자 다운로드 폴더)
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = process.env.HWP_SAMPLES || path.join(os.homedir(), 'Downloads');
const files = fs.readdirSync(dir).filter((f) => /\.hwpx?$/i.test(f)).map((f) => path.join(dir, f));
if (!files.length) { console.error(`표본이 없다: ${dir}`); process.exit(1); }

let failed = 0;
for (const t of ['test.mjs', 'test-save.mjs']) {
  const r = spawnSync(process.execPath, ['--no-warnings', path.join(here, t), ...files], { stdio: 'inherit' });
  if (r.status !== 0) failed++;
}
process.exit(failed ? 1 : 0);
