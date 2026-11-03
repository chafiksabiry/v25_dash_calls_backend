process.env.OPENAI_API_KEY = 'sk-test-not-real';
jest.mock('openai', () => jest.fn().mockImplementation(() => ({})));

const { buildSuggestPrompt } = require('../services/voiceMenuAi');

// La seule mention autorisée de ces mots est l'interdiction explicite donnée à l'IA.
const stripBan = (p) => p.replace(/Ne parle jamais de centre, d'équipe, de conseillers ni d'entreprise\./g, '');
const FORBIDDEN = /\b(nous|notre|nos|équipe|conseillers?|centre|entreprise)\b/i;

describe('buildSuggestPrompt - audience person (Nomad Solo)', () => {
  const base = { tone: 'chaleureux', language: 'fr', personName: 'Chafik Sabiry', companyName: 'Centre X', operationName: 'Op Y' };

  test.each(['greeting', 'voicemail'])('%s : première personne, interdiction explicite, aucun centre/équipe/nous', (kind) => {
    const p = buildSuggestPrompt({ ...base, kind, audience: 'person' });
    expect(p).toMatch(/première personne/);
    expect(p).toMatch(/Ne parle jamais de centre, d'équipe, de conseillers ni d'entreprise/);
    expect(p).toMatch(/Nom de la personne: Chafik Sabiry/);
    expect(stripBan(p)).not.toMatch(FORBIDDEN);
    expect(p).not.toMatch(/Centre X|Op Y|Nom du centre|Opération/);
  });

  test('sans nom : ne pas inventer', () => {
    const p = buildSuggestPrompt({ ...base, personName: undefined, kind: 'voicemail', audience: 'person' });
    expect(p).toMatch(/non fourni, ne pas en inventer/);
  });

  test('audience centre inchangée (défaut)', () => {
    const p = buildSuggestPrompt({ ...base, kind: 'greeting' });
    expect(p).toMatch(/Nom du centre: Centre X/);
  });

  test.each(['person', 'center'])('répondeur (%s) : mention obligatoire de l\'enregistrement du message', (audience) => {
    const p = buildSuggestPrompt({ ...base, kind: 'voicemail', audience });
    expect(p).toMatch(/message sera enregistré/);
  });
});
