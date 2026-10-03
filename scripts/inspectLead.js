require('dotenv').config();
const mongoose = require('mongoose');

const leadId = process.argv[2];
const dbName = process.argv[3] || 'harx';

function uriForDb(db) {
  const raw = process.env.MONGO_URI || process.env.MONGODB_URI || '';
  return raw.replace(/\/[^/?]+(\?|$)/, `/${db}$1`);
}

(async () => {
  await mongoose.connect(uriForDb(dbName));
  const id = new mongoose.Types.ObjectId(leadId);
  const doc = await mongoose.connection.collection('leads').findOne({ _id: id });
  console.log(
    JSON.stringify(
      doc
        ? {
            _id: String(doc._id),
            name: doc.name || `${doc.First_Name || ''} ${doc.Last_Name || ''}`.trim(),
            repDisposition: doc.repDisposition,
            Stage: doc.Stage,
            status: doc.status,
            nextAction: doc.nextAction,
          }
        : null,
      null,
      2
    )
  );
  await mongoose.disconnect();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
