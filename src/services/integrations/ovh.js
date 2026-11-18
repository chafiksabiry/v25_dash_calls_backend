const ovh = require('ovh');
require('dotenv').config();

// Client créé au premier appel : une variable manquante donne une erreur claire au lieu d'arrêter le service au chargement.
let client = null;
function getOvhClient() {
    if (client) return client;
    const appKey = process.env.OVH_APP_KEY || process.env.OVH_APPLICATION_KEY;
    const appSecret = process.env.OVH_APP_SECRET || process.env.OVH_APPLICATION_SECRET;
    const consumerKey = process.env.OVH_CONSUMER_KEY;
    const missing = [!appKey && 'OVH_APP_KEY', !appSecret && 'OVH_APP_SECRET', !consumerKey && 'OVH_CONSUMER_KEY'].filter(Boolean);
    if (missing.length) throw new Error(`Intégration OVH non configurée : variable(s) ${missing.join(', ')} absente(s).`);
    client = ovh({ endpoint: 'ovh-eu', appKey, appSecret, consumerKey });
    return client;
}
const ovhClient = { requestPromised: (...args) => getOvhClient().requestPromised(...args) };

// Création du Dialplan
exports.createDialplan = async (callerNumber, calleeNumber) => {
    try {
        const result = await ovhClient.requestPromised('POST', 
            `/telephony/${process.env.OVH_BILLING_ACCOUNT}/ovhPabx/${process.env.OVH_SERVICE_NAME}/dialplan`, 
            {
                caller: callerNumber,
                callee: calleeNumber
            }
        );
        return result;
    } catch (error) {
        console.error('Erreur dans createDialplan Service:', error);
        throw new Error('Erreur lors de la création du Dialplan');
    }
};

// Lancer un appel sortant
exports.launchOutboundCall = async (callerNumber, calleeNumber) => {
    try {
        const result = await ovhClient.requestPromised('POST', 
            `/telephony/${process.env.OVH_BILLING_ACCOUNT}/ovhPabx/${process.env.OVH_SERVICE_NAME}/dialplan/actions`, 
            {
                action: 'call',
                caller: callerNumber,
                callee: calleeNumber
            }
        );
        return result;
    } catch (error) {
        console.error('Erreur dans launchOutboundCall Service:', error);
        throw new Error('Erreur lors du lancement de l\'appel');
    }
};

// Suivre l'état de l'appel
exports.trackCallStatus = async (callId) => {
    try {
        const result = await ovhClient.requestPromised('GET', 
            `/telephony/${process.env.OVH_BILLING_ACCOUNT}/ovhPabx/${process.env.OVH_SERVICE_NAME}/calls/${callId}/status`
        );
        return result;
    } catch (error) {
        console.error('Erreur dans trackCallStatus Service:', error);
        throw new Error('Erreur lors du suivi de l\'appel');
    }
};
