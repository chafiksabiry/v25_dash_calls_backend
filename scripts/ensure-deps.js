/**
 * Railway sometimes boots with a corrupted nested mongodb install
 * (missing lib/cursor/explainable_cursor.js). Reinstall before start.
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const roots = [
  path.join(__dirname, '..', 'node_modules', 'mongoose', 'node_modules', 'mongodb'),
  path.join(__dirname, '..', 'node_modules', 'mongodb'),
];

function hasExplainableCursor() {
  return roots.some((root) =>
    fs.existsSync(path.join(root, 'lib', 'cursor', 'explainable_cursor.js'))
  );
}

if (hasExplainableCursor()) {
  process.exit(0);
}

console.error('[ensure-deps] Missing mongodb explainable_cursor — wiping node_modules and reinstalling');
const appRoot = path.join(__dirname, '..');
execSync('rm -rf node_modules', { cwd: appRoot, stdio: 'inherit', shell: true });
execSync('npm ci --omit=dev', { cwd: appRoot, stdio: 'inherit', shell: true, env: process.env });

if (!hasExplainableCursor()) {
  console.error('[ensure-deps] Reinstall finished but explainable_cursor is still missing');
  process.exit(1);
}
