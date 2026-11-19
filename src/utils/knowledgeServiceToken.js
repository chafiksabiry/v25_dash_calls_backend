const jwt = require('jsonwebtoken');

/**
 * Jeton de service court pour lire le service de connaissance (scripts d'un gig, requête RAG), signé avec le
 * secret partagé JWT_SECRET. Le service de connaissance n'accepte la portée « kb-read » que sur ces lectures.
 * Retourne des en-têtes vides si JWT_SECRET manque (l'appel sera alors refusé, sans secret de repli).
 */
function knowledgeReadHeaders() {
  const secret = process.env.JWT_SECRET;
  if (!secret) return {};
  return { Authorization: `Bearer ${jwt.sign({ scope: 'kb-read' }, secret, { expiresIn: '2m' })}` };
}

module.exports = { knowledgeReadHeaders };
