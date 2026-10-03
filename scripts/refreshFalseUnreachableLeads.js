/**
 * Clear stale lead.repDisposition = called_unreachable when a connected
 * call (completed + duration/recording) exists for that lead.
 *
 * Usage: node scripts/refreshFalseUnreachableLeads.js [--dry-run] [dbName]
 */
const mongoose = require('mongoose');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const dbName = args.find((a) => !a.startsWith('--')) || 'harx_dev';

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
  if (!raw) throw new Error('Set MONGO_URI');
  return raw.replace(/\/[^/?]+(\?|$)/, `/${db}$1`);
}

function hasConnection(doc) {
  const status = String(doc.status || '').toLowerCase();
  if (['no-answer', 'noanswer', 'busy', 'canceled', 'cancelled', 'failed'].includes(status)) {
    return false;
  }
  if (String(doc.answeredBy || '').toLowerCase() === 'human') return true;
  const duration = Number(doc.duration) || 0;
  const hasRecording = Boolean(doc.recording_url || doc.recording_url_cloudinary);
  if (hasRecording) return true;
  return ['completed', 'hangup', 'in-progress'].includes(status) && duration > 0;
}

async function main() {
  loadEnv();
  console.log(`[leads] db=${dbName} dryRun=${dryRun}`);
  const conn = await mongoose.createConnection(uriForDb(dbName), {
    maxPoolSize: 5,
    serverSelectionTimeoutMS: 20000,
  }).asPromise();

  const leads = conn.collection('leads');
  const calls = conn.collection('calls');

  const badLeads = await leads
    .find({ repDisposition: 'called_unreachable' })
    .project({ _id: 1, name: 1, First_Name: 1, Last_Name: 1, repDisposition: 1 })
    .toArray();

  let updated = 0;
  for (const lead of badLeads) {
    const related = await calls
      .find({ lead: lead._id })
      .project({
        status: 1,
        duration: 1,
        recording_url: 1,
        recording_url_cloudinary: 1,
        answeredBy: 1,
        sid: 1,
      })
      .toArray();
    const connected = related.some(hasConnection);
    if (!connected) continue;

    console.log(
      JSON.stringify({
        leadId: String(lead._id),
        name: lead.name || `${lead.First_Name || ''} ${lead.Last_Name || ''}`.trim(),
        calls: related.length,
        clear: 'called_unreachable → null',
      })
    );

    if (!dryRun) {
      await leads.updateOne(
        { _id: lead._id },
        { $set: { repDisposition: null } }
      );
    }
    updated += 1;
  }

  console.log(`[leads] scanned=${badLeads.length} cleared=${updated}`);
  await conn.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
