const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');

/**
 * Lecture des appels et contacts d'un centre, et import de contacts d'un CRM, pour l'orchestrateur (API publique du centre
 * et écran Intégrations). Jeton de service HS256 de portée `center-data`, expiration obligatoire ; jamais un jeton utilisateur.
 */
const SCOPE = 'center-data';
const fail = (res, status, message) => res.status(status).json({ success: false, message });
const oid = (v) => (/^[0-9a-fA-F]{24}$/.test(String(v || '')) ? new mongoose.Types.ObjectId(String(v)) : null);

function authenticateCenterService(req, res, next) {
  const secret = process.env.JWT_SECRET;
  if (!secret) return fail(res, 500, "L'authentification n'est pas configurée.");
  const h = req.headers && req.headers.authorization;
  const token = h && h.startsWith('Bearer ') ? h.slice(7).trim() : '';
  if (!token) return fail(res, 401, 'Authentification requise.');
  try {
    const d = jwt.verify(token, secret, { algorithms: ['HS256'] });
    if (typeof d.exp !== 'number' || d.scope !== SCOPE) throw new Error('bad token');
    return next();
  } catch (_e) {
    return fail(res, 401, 'Jeton de service invalide ou expiré.');
  }
}

/** `companyId` peut être stocké en ObjectId ou en texte selon l'origine de la ligne. */
const companyFilter = (companyId) => ({ $in: [companyId, String(companyId)] });

function pageOf(req) {
  const limit = Math.min(100, Math.max(1, Math.floor(Number(req.query.limit)) || 25));
  const filter = {};
  const cursor = oid(req.query.cursor);
  if (cursor) filter._id = { $lt: cursor };
  return { limit, filter };
}

function done(res, rows, limit, shape) {
  const more = rows.length > limit;
  const page = rows.slice(0, limit);
  res.json({ success: true, data: page.map(shape), nextCursor: more ? String(page[page.length - 1]._id) : null });
}

async function listCalls(req, res) {
  const companyId = oid(req.params.companyId);
  if (!companyId) return fail(res, 400, 'companyId invalide.');
  try {
    const Call = require('../models/Call');
    const { limit, filter } = pageOf(req);
    filter.companyId = companyFilter(companyId);
    filter.isTest = { $ne: true };
    if (req.query.since && !Number.isNaN(Date.parse(req.query.since))) filter.startTime = { $gte: new Date(req.query.since) };
    const rows = await Call.find(filter).sort({ _id: -1 }).limit(limit + 1)
      .select('sid direction status from to duration startTime endTime gigId handledBy.name').lean();
    done(res, rows, limit, (c) => ({
      sid: c.sid || String(c._id), direction: c.direction, status: c.status, from: c.from, to: c.to, duration: c.duration,
      startTime: c.startTime, endTime: c.endTime, gigId: c.gigId ? String(c.gigId) : null, handledByName: c.handledBy && c.handledBy.name,
    }));
  } catch (e) {
    console.error('internal-center calls:', e.message);
    fail(res, 500, 'Lecture impossible.');
  }
}

const split = (name) => { const [f, ...r] = String(name || '').trim().split(/\s+/); return [f || '', r.join(' ')]; };

async function listContacts(req, res) {
  const companyId = oid(req.params.companyId);
  if (!companyId) return fail(res, 400, 'companyId invalide.');
  try {
    const { Lead } = require('../models/Lead');
    const { limit, filter } = pageOf(req);
    filter.companyId = companyFilter(companyId);
    const rows = await Lead.find(filter).sort({ _id: -1 }).limit(limit + 1)
      .select('First_Name Last_Name name Email_1 email Phone phone gigId createdAt').lean();
    done(res, rows, limit, (l) => {
      const [f, last] = split(l.name);
      return { id: String(l._id), firstName: l.First_Name || f, lastName: l.Last_Name || last, email: l.Email_1 || l.email || '', phone: l.Phone || l.phone || '', gigId: l.gigId ? String(l.gigId) : null, createdAt: l.createdAt };
    });
  } catch (e) {
    console.error('internal-center contacts:', e.message);
    fail(res, 500, 'Lecture impossible.');
  }
}

const norm = (p) => String(p || '').replace(/[^\d+]/g, '');
const MAX_IMPORT = 2000;

/**
 * Importe des contacts d'un CRM dans les prospects d'une opération du centre. Utilise les champs existants du prospect
 * (First_Name, Last_Name, Email_1, Phone, gigId, companyId) : aucun schéma nouveau. Les contacts déjà présents dans
 * l'opération (même téléphone ou même e-mail) sont ignorés.
 */
async function importLeads(req, res) {
  const companyId = oid(req.params.companyId);
  const gigId = oid(req.body && req.body.gigId);
  if (!companyId || !gigId) return fail(res, 400, 'companyId et gigId requis.');
  const input = Array.isArray(req.body.contacts) ? req.body.contacts.slice(0, MAX_IMPORT) : [];
  const source = String(req.body.source || 'crm').replace(/[^a-z0-9_-]/gi, '').slice(0, 20) || 'crm';
  try {
    const Gig = require('../models/Gig');
    const { Lead } = require('../models/Lead');
    const gig = await Gig.findOne({ _id: gigId, companyId: companyFilter(companyId) }).select('_id').lean();
    if (!gig) return fail(res, 404, 'Opération introuvable pour ce centre.');
    const existing = await Lead.find({ gigId }).select('Email_1 email Phone phone').lean();
    const seenPhones = new Set(existing.map((l) => norm(l.Phone || l.phone)).filter(Boolean));
    const seenEmails = new Set(existing.map((l) => String(l.Email_1 || l.email || '').toLowerCase()).filter(Boolean));
    const docs = [];
    let skipped = 0;
    for (const c of input) {
      const email = String((c && c.email) || '').trim().toLowerCase().slice(0, 200);
      const phone = String((c && c.phone) || '').trim().slice(0, 40);
      const p = norm(phone);
      if ((!email && !p) || (email && seenEmails.has(email)) || (p && seenPhones.has(p))) { skipped += 1; continue; }
      if (email) seenEmails.add(email);
      if (p) seenPhones.add(p);
      docs.push({
        First_Name: String(c.firstName || '').trim().slice(0, 100), Last_Name: String(c.lastName || '').trim().slice(0, 100),
        Email_1: email, Phone: phone, gigId, companyId, source: `crm:${source}`, status: 'new',
      });
    }
    if (docs.length) await Lead.insertMany(docs, { ordered: false });
    res.json({ success: true, data: { created: docs.length, skipped } });
  } catch (e) {
    console.error('internal-center import:', e.message);
    fail(res, 500, 'Import impossible.');
  }
}

module.exports = { authenticateCenterService, listCalls, listContacts, importLeads, SCOPE };
