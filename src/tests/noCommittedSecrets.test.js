/**
 * Garde-fou : aucune clé privée ni fichier de compte de service ne doit être suivi par git.
 * Les identifiants Google Cloud se chargent depuis l'environnement (VERTEX_AI_CREDENTIALS, GCP_SPEECH_TO_TEXT_CREDENTIALS,
 * CLOUD_STORAGE_CREDENTIALS, ou GOOGLE_APPLICATION_CREDENTIALS pointant vers un fichier hors dépôt).
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '../..');
const SELF = path.relative(ROOT, __filename);
const SKIP_DIRS = new Set(['node_modules', '.git']);

const PATTERNS = [
  { name: 'private key block', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: 'service account private_key field', re: /\\?"private_key\\?"\s*:\s*\\?"-----BEGIN/ },
];

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile()) out.push(path.relative(ROOT, full));
  }
  return out;
}

/** Fichiers suivis par git ; à défaut de git (image Docker sans .git), tout l'arbre hors node_modules. */
function trackedFiles() {
  try {
    const out = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return out.split('\0').filter(Boolean);
  } catch (_e) {
    return walk(ROOT);
  }
}

describe('no committed secrets', () => {
  test('no tracked file contains a private key', () => {
    const offenders = [];
    for (const rel of trackedFiles()) {
      if (rel === SELF) continue;
      const full = path.join(ROOT, rel);
      let stat;
      try { stat = fs.statSync(full); } catch (_e) { continue; } // supprimé dans l'arbre de travail
      if (!stat.isFile() || stat.size > 5 * 1024 * 1024) continue;
      const text = fs.readFileSync(full, 'utf8');
      for (const { name, re } of PATTERNS) {
        if (re.test(text)) offenders.push(`${rel} (${name})`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test('.gitignore keeps credential files out of the repository', () => {
    const ignore = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8');
    for (const entry of ['config/*.json', 'temp/', '*.pem']) {
      expect(ignore.split(/\r?\n/).map((l) => l.trim())).toContain(entry);
    }
  });
});
