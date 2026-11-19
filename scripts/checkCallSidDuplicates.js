/**
 * LECTURE SEULE : vérifie qu'aucun sid texte n'est en double dans `calls` avant de basculer l'index `sid_1` en unique partiel
 * (src/models/Call.js). Usage : node scripts/checkCallSidDuplicates.js <base>
 * Aucun doublon -> bascule (opération manuelle, hors de ce script) : db.calls.dropIndex('sid_1') puis redémarrage du service
 * (Mongoose recrée `sid_1` unique partiel) ou db.calls.createIndex({ sid: 1 }, { name: 'sid_1', unique: true,
 * partialFilterExpression: { sid: { $type: 'string' } } }).
 * Doublons -> les traiter d'abord : la création de l'index échouerait (sans rien modifier aux documents).
 */
require('dotenv').config();
const mongoose = require('mongoose');

const dbName = process.argv[2];
if (!dbName) { console.error('usage : node scripts/checkCallSidDuplicates.js <base>'); process.exit(1); }
const uri = String(process.env.MONGO_URI || process.env.MONGODB_URI || '').replace(/\/[^/?]+(\?|$)/, `/${dbName}$1`);

(async () => {
  await mongoose.connect(uri);
  const calls = mongoose.connection.collection('calls');
  const dups = await calls.aggregate([
    { $match: { sid: { $type: 'string' } } },
    { $group: { _id: '$sid', n: { $sum: 1 }, ids: { $push: '$_id' } } },
    { $match: { n: { $gt: 1 } } },
    { $limit: 50 },
  ]).toArray();
  const nullSids = await calls.countDocuments({ sid: null });
  console.log(JSON.stringify({ database: dbName, duplicateStringSids: dups.length, sample: dups.slice(0, 10), nullOrMissingSid: nullSids, indexes: await calls.indexes() }, null, 2));
  await mongoose.disconnect();
})().catch((e) => { console.error(e.message); process.exit(1); });
