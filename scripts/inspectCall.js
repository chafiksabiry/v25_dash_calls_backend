require('dotenv').config();
const mongoose = require('mongoose');

const sid = process.argv[2] || 'CA8fa28697cec3e32c33a4e9f5a1261c4f';
const dbName = process.argv[3] || 'harx_dev';

function uriForDb(db) {
  const raw = process.env.MONGO_URI || process.env.MONGODB_URI || '';
  return raw.replace(/\/[^/?]+(\?|$)/, `/${db}$1`);
}

(async () => {
  await mongoose.connect(uriForDb(dbName));
  const doc = await mongoose.connection.collection('calls').findOne({
    $or: [{ sid }, { call_id: sid }, { sid: new RegExp(sid.slice(0, 10)) }],
  });
  if (!doc) {
    console.log(`not found in ${dbName}`);
  } else {
    console.log(
      JSON.stringify(
        {
          _id: String(doc._id),
          sid: doc.sid,
          status: doc.status,
          duration: doc.duration,
          callOutcome: doc.callOutcome,
          callOutcomeSource: doc.callOutcomeSource,
          suggestedDisposition: doc.suggestedDisposition,
          answeredBy: doc.answeredBy,
          validByAI: doc.validByAI,
          valid: doc.valid,
          ai_call_status: doc.ai_call_status,
          hasRec: Boolean(doc.recording_url || doc.recording_url_cloudinary),
          recording_url: doc.recording_url ? 'yes' : null,
          recording_url_cloudinary: doc.recording_url_cloudinary ? 'yes' : null,
          unreachable: doc.ai_call_score?.called_unreachable,
          overall: doc.ai_call_score?.overall,
          leadId: doc.lead,
        },
        null,
        2
      )
    );
  }
  await mongoose.disconnect();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
