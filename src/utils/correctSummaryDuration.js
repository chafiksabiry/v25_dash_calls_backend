/**
 * Strip invented call-duration claims from AI summaries.
 * Duration lives in telephony/UI — the model must not state it.
 */

function stripDurationClaims(text) {
  if (!text || typeof text !== 'string') return text;
  let out = text;

  // Full opening sentences about duration.
  out = out.replace(
    /L['’]appel a duré\s+\d+\s*minutes?\b(?:\s+et\s+\d+\s*secondes?\b)?[.!]?\s*/gi,
    ''
  );
  out = out.replace(
    /The call lasted\s+\d+\s*minutes?\b(?:\s+and\s+\d+\s*seconds?\b)?[.!]?\s*/gi,
    ''
  );
  out = out.replace(
    /(?:La\s+)?durée(?:\s+réelle)?(?:\s+de\s+l['’]appel)?\s*(?:est|était|:)?\s*\d+\s*min(?:utes?)?\b(?:\s+et\s+\d+\s*s(?:econdes?)?\b)?[.!]?\s*/gi,
    ''
  );
  out = out.replace(
    /(?:The\s+)?call duration(?:\s+is|\s+was|:)?\s*\d+\s*min(?:utes?)?\b(?:\s+and\s+\d+\s*s(?:econds?)?\b)?[.!]?\s*/gi,
    ''
  );

  // Mid-sentence fragments.
  out = out.replace(/\ba duré\s+\d+\s*minutes?\b(?:\s+et\s+\d+\s*secondes?\b)?/gi, '');
  out = out.replace(/\blasted\s+\d+\s*minutes?\b(?:\s+and\s+\d+\s*seconds?\b)?/gi, '');
  out = out.replace(/\b\d+\s*minutes?\s+et\s+\d+\s*secondes?\b/gi, '');
  out = out.replace(/\b\d+\s*minutes?\s+and\s+\d+\s*seconds?\b/gi, '');

  // Cleanup leftover punctuation / spaces.
  out = out.replace(/\s{2,}/g, ' ');
  out = out.replace(/\s+([.,;:!?])/g, '$1');
  out = out.replace(/^[,:;.\-\s]+/, '');
  out = out.replace(/\(\s*\)/g, '');
  out = out.trim();

  // Capitalize first letter if we stripped the opening sentence.
  if (out && /^[a-zàâäéèêëïîôùûüç]/.test(out)) {
    out = out.charAt(0).toUpperCase() + out.slice(1);
  }

  return out;
}

/** @deprecated name kept for call sites — strips duration, does not rewrite it. */
function correctDurationInText(text, _durationSec, _lang = 'auto') {
  return stripDurationClaims(text);
}

/**
 * Mutates scores feedback fields (and returns scores).
 * @param {object} scores
 * @param {number} [_durationSec] unused — kept for call-site compatibility
 */
function correctScoresDuration(scores, _durationSec) {
  if (!scores || typeof scores !== 'object') return scores;

  const patchFeedback = (node) => {
    if (!node || typeof node !== 'object') return;
    if (typeof node.feedback === 'string') {
      node.feedback = stripDurationClaims(node.feedback);
    }
    if (typeof node.feedback_fr === 'string') {
      node.feedback_fr = stripDurationClaims(node.feedback_fr);
    }
    if (typeof node.feedback_en === 'string') {
      node.feedback_en = stripDurationClaims(node.feedback_en);
    }
  };

  patchFeedback(scores.overall);
  for (const value of Object.values(scores)) {
    if (value && typeof value === 'object' && ('feedback' in value || 'feedback_fr' in value)) {
      patchFeedback(value);
    }
  }
  return scores;
}

module.exports = {
  stripDurationClaims,
  correctDurationInText,
  correctScoresDuration,
};
