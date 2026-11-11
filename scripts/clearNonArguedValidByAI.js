/**
 * For connected non-argued calls, clear validByAI=false (looks like reject).
 * Usage: node scripts/clearNonArguedValidByAI.js [--dry-run] [dbName]
 */
require('dotenv').config();
const mongoose = require('mongoose');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const dbName = args.find((a) => !a.startsWith('--')) || 'harx';

function uriForDb(db) {
  const raw = process.env.MONGO_URI || process.env.MONGODB_URI || '';
  return raw.replace(/\/[^/?]+(\?|$)/, `/${db}$1`);
}

(async () => {
  console.log(`[clear] db=${dbName} dryRun=${dryRun}`);
  await mongoose.connect(uriForDb(dbName));
  const filter = {
    callOutcome: { $in: ['connected_no_sale', 'too_short'] },
    validByAI: false,
    status: { $in: ['completed', 'hangup', 'in-progress'] },
    $or: [
      { duration: { $gt: 0 } },
      { recording_url: { $exists: true, $nin: [null, ''] } },
      { recording_url_cloudinary: { $exists: true, $nin: [null, ''] } },
    ],
  };
  const docs = await mongoose.connection.collection('calls').find(filter).project({ sid: 1, duration: 1, callOutcome: 1 }).toArray();
  console.log(`[clear] matched=${docs.length}`);
  docs.slice(0, 12).forEach((d) => console.log(JSON.stringify({ sid: d.sid, duration: d.duration, callOutcome: d.callOutcome })));
  if (!dryRun && docs.length) {
    const res = await mongoose.connection.collection('calls').updateMany(filter, {
      $set: { validByAI: null, valid: null, ai_refusal_reason: null },
    });
    console.log(`[clear] modified=${res.modifiedCount}`);
  }
  await mongoose.disconnect();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
