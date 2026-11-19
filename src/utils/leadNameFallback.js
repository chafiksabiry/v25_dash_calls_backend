/**
 * Appels sans lead : l'interlocuteur affiché est le numéro appelant (entrant) ou appelé (sortant).
 * Sources concernées : appels du portail du centre (`center_portal`) et jambes d'appels transférés inscrites par
 * l'orchestrateur pour la facturation (`transfer`, jambe vers la fiche de l'annuaire ou reste du correspondant).
 */
const NUMBER_FALLBACK_SOURCES = ['center_portal', 'transfer'];

/** Étape d'agrégation : `leadName` vide + source sans lead -> numéro de l'interlocuteur. */
function leadNameFallbackStage() {
  return {
    $addFields: {
      leadName: {
        $cond: [
          {
            $and: [
              { $eq: ['$leadName', ''] },
              { $in: ['$source', NUMBER_FALLBACK_SOURCES] }
            ]
          },
          {
            $cond: [
              { $regexMatch: { input: { $toLower: { $ifNull: ['$direction', ''] } }, regex: '^inbound' } },
              { $ifNull: ['$from', '$to'] },
              { $ifNull: ['$to', '$from'] }
            ]
          },
          '$leadName'
        ]
      }
    }
  };
}

module.exports = { NUMBER_FALLBACK_SOURCES, leadNameFallbackStage };
