#!/usr/bin/env node
/**
 * Render Deployment Compatibility Bridge (`server/` -> `backend/`, `client/` -> `frontend/`).
 *
 * Khi dịch vụ Web trên Render Dashboard vẫn lưu Build/Start Command cũ từ kiến trúc trước khi tách nhánh:
 *   Build: `npm install --include=dev --prefix server && npm install --include=dev --prefix client && npm run build`
 *   Start: `npm start` | `npm start --prefix server` | `node server/dist/index.js`
 *
 * Script này xóa sạch biến môi trường `npm_config_prefix` / `PREFIX` bị kế thừa từ `--prefix server|client`
 * rồi chuyển tiếp chính xác sang `backend/` và `frontend/`, đồng thời tạo `server/dist/index.js` sau khi build.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

const [, , action, target] = process.argv;

if (action === 'postbuild') {
  const legacyDistDir = path.join(repoRoot, 'server', 'dist');
  fs.mkdirSync(legacyDistDir, { recursive: true });
  fs.writeFileSync(
    path.join(legacyDistDir, 'index.js'),
    "'use strict';\nrequire('../../backend/dist/index.js');\n",
    'utf8',
  );
  console.log('[render-compat] Generated server/dist/index.js -> ../../backend/dist/index.js');
  process.exit(0);
}

if (!target || !['backend', 'frontend'].includes(target)) {
  console.error(`[render-compat] Invalid target "${target ?? ''}". Expected "backend" or "frontend".`);
  process.exit(1);
}

const targetDir = path.join(repoRoot, target);
const cleanEnv = { ...process.env };
delete cleanEnv.npm_config_prefix;
delete cleanEnv.NPM_CONFIG_PREFIX;
delete cleanEnv.PREFIX;
delete cleanEnv.INIT_CWD;

const argsByAction = {
  install: ['install', '--include=dev'],
  build: ['run', 'build'],
  start: ['start'],
};

const npmArgs = argsByAction[action];
if (!npmArgs) {
  console.error(`[render-compat] Unknown action "${action ?? ''}".`);
  process.exit(1);
}

console.log(`[render-compat] Forwarding "${action}" -> ./${target} (${npmArgs.join(' ')})`);
const isWin = process.platform === 'win32';
const res = spawnSync(isWin ? 'npm.cmd' : 'npm', npmArgs, {
  cwd: targetDir,
  env: cleanEnv,
  stdio: 'inherit',
  shell: isWin,
});

if (res.error) {
  console.error(`[render-compat] Failed to run npm in ./${target}:`, res.error);
  process.exit(1);
}

process.exit(res.status ?? 0);
