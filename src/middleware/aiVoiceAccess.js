const mongoose = require('mongoose');
const { authenticateUser, callerCompanyId } = require('./companyScope');

/**
 * Contrôle d'accès des routes de l'agent vocal IA (appels sortants réels, configuration de l'assistant d'un gig).
 *
 *  - Jeton de connexion de l'entreprise TOUJOURS exigé (aucun mode anonyme ni de secours : ces routes déclenchent des
 *    appels facturés et modifient le prompt joué en direct).
 *  - Le centre de l'appelant est résolu par le service d'inscription (source de vérité), jamais lu dans le corps ou dans
 *    l'en-tête `x-company-id`. Un companyId fourni qui ne correspond pas au centre de l'appelant est refusé (403).
 */

const idString = (v) => {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'object') {
    if (typeof v.toHexString === 'function') return v.toHexString(); // ObjectId (dont _id renvoie lui-même)
    if (v.$oid) return String(v.$oid);
    if (v._id && v._id !== v) return idString(v._id);
  }
  return String(v);
};

function deny(res, status, message) {
  return res.status(status).json({ success: false, message });
}

/** Jeton utilisateur valide + centre de l'appelant dans `req.companyId`. */
function requireCompanyUser(req, res, next) {
  return authenticateUser(req, res, async () => {
    try {
      const companyId = await callerCompanyId(req.auth);
      if (!companyId) return deny(res, 403, 'Not allowed for this company');
      const claimed = idString((req.body && req.body.companyId) || req.headers['x-company-id']);
      if (claimed && claimed !== String(companyId)) return deny(res, 403, 'Not allowed for this company');
      req.companyId = String(companyId);
      return next();
    } catch (error) {
      if (error && error.status) return deny(res, error.status, error.message);
      return deny(res, 500, 'Access check failed');
    }
  });
}

async function findGig(gigId) {
  const gigIdStr = String(gigId);
  const orId = [{ _id: gigIdStr }];
  if (mongoose.Types.ObjectId.isValid(gigIdStr)) orId.push({ _id: new mongoose.Types.ObjectId(gigIdStr) });
  return mongoose.connection.db.collection('gigs').findOne({ $or: orId }, { projection: { companyId: 1 } });
}

/** /gigs/:id/... : le gig doit exister et appartenir au centre de l'appelant (à placer après requireCompanyUser). */
function guardGigOwnership(param = 'id') {
  return async (req, res, next) => {
    const gigId = req.params[param];
    if (!gigId || !mongoose.Types.ObjectId.isValid(String(gigId))) return deny(res, 400, 'Valid gig id is required');
    try {
      const gig = await findGig(gigId);
      if (!gig) return deny(res, 404, 'Gig not found');
      if (idString(gig.companyId) !== req.companyId) return deny(res, 403, 'Not allowed for this gig');
      return next();
    } catch (error) {
      return deny(res, 500, 'Access check failed');
    }
  };
}

module.exports = { requireCompanyUser, guardGigOwnership, idString };
