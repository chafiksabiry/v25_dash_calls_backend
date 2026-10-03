/**
 * One-shot: clear false « Injoignable » on calls that actually connected
 * (Twilio completed/hangup + duration/recording).
 *
 * Usage:
 *   node scripts/refreshConnectedCallOutcomes.js [--dry-run] [dbName]
 *
 * Default db: harx_dev
 */
const mongoose = require('mongoose');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const dbName = args.find((a) => !a.startsWith('--')) || 'harx_dev';

const FALSE_UNREACHABLE_OUTCOMES = ['no_answer', 'busy', 'too_short'];

function loadEnv() {
  try {
    require('dotenv').config();
  } catch {
    /* optional */
  }
  if (!process.env.MONGO_URI && !process.env.MONGODB_URI) {
    const fs = require('fs');
    const path = require('path');
    const envPath = path.join(__dirname, '..', '.env');
    if (fs.existsSync(envPath)) {
      const text = fs.readFileSync(envPath, 'utf8');
      const m = text.match(/^\s*MONGO_URI\s*=\s*"?([^"\r\n]+)"?/m);
      if (m) process.env.MONGO_URI = m[1].trim();
    }
  }
}

function uriForDb(db) {
  const raw = process.env.MONGO_URI || process.env.MONGODB_URI || '';
  if (!raw) throw new Error('Set MONGO_URI (or MONGODB_URI)');
  return raw.replace(/\/[^/?]+(\?|$)/, `/${db}$1`);
}

function hasConnection(doc) {
  const status = String(doc.status || '').toLowerCase();
  // Ring time on no-answer/busy is NOT a connection.
  if (['no-answer', 'noanswer', 'busy', 'canceled', 'cancelled', 'failed'].includes(status)) {
    return false;
  }
  const answeredBy = String(doc.answeredBy || '').toLowerCase();
  if (answeredBy === 'human') return true;
  const duration = Number(doc.duration) || 0;
  const hasRecording = Boolean(doc.recording_url || doc.recording_url_cloudinary);
  if (hasRecording) return true;
  if (['completed', 'hangup', 'in-progress'].includes(status) && duration > 0) {
    return true;
  }
  return false;
}

async function main() {
  loadEnv();
  const uri = uriForDb(dbName);
  console.log(`[refresh] db=${dbName} dryRun=${dryRun}`);

  const conn = await mongoose.createConnection(uri, {
    maxPoolSize: 5,
    serverSelectionTimeoutMS: 20000,
  }).asPromise();

  const calls = conn.collection('calls');
  const cursor = calls.find({
    $or: [
      { status: { $in: ['completed', 'hangup', 'in-progress'] } },
      { duration: { $gt: 0 } },
      { recording_url: { $exists: true, $nin: [null, ''] } },
      { recording_url_cloudinary: { $exists: true, $nin: [null, ''] } },
      { answeredBy: 'human' },
    ],
    $and: [
      {
        $or: [
          { callOutcome: { $in: FALSE_UNREACHABLE_OUTCOMES } },
          { suggestedDisposition: 'called_unreachable' },
          { 'ai_call_score.called_unreachable.passed': true },
          { 'ai_call_score.suggested_disposition': 'called_unreachable' },
        ],
      },
    ],
  });

  let scanned = 0;
  let matched = 0;
  let updated = 0;
  const samples = [];

  // eslint-disable-next-line no-restricted-syntax
  for await (const doc of cursor) {
    scanned += 1;
    if (!hasConnection(doc)) continue;
    matched += 1;

    const set = {};
    const unset = {};

    const outcome = String(doc.callOutcome || '').toLowerCase();
    if (FALSE_UNREACHABLE_OUTCOMES.includes(outcome)) {
      set.callOutcome = 'connected_no_sale';
      set.callOutcomeSource = 'system';
    }

    if (doc.suggestedDisposition === 'called_unreachable') {
      set.suggestedDisposition = null;
    }

    if (doc.ai_call_score?.called_unreachable?.passed === true) {
      set['ai_call_score.called_unreachable.passed'] = false;
      set['ai_call_score.called_unreachable.score'] = 0;
    }

    if (doc.ai_call_score?.suggested_disposition === 'called_unreachable') {
      set['ai_call_score.suggested_disposition'] = null;
    }

    if (!Object.keys(set).length && !Object.keys(unset).length) continue;

    if (samples.length < 15) {
      samples.push({
        sid: doc.sid || doc.call_id || String(doc._id),
        status: doc.status,
        duration: doc.duration,
        callOutcome: doc.callOutcome,
        suggestedDisposition: doc.suggestedDisposition,
        next: set,
      });
    }

    if (!dryRun) {
      await calls.updateOne({ _id: doc._id }, { $set: set });
      updated += 1;
    } else {
      updated += 1;
    }
  }

  console.log(`[refresh] scanned=${scanned} connected+false-unreachable=${matched} updated=${updated}`);
  if (samples.length) {
    console.log('[refresh] samples:');
    for (const s of samples) console.log(JSON.stringify(s));
  }

  await conn.close();
}

main().catch((err) => {
  console.error('[refresh] failed:', err);
  process.exit(1);
});
