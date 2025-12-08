const ovh = require('ovh');
require('dotenv').config();

// Lazy initialization of OVH client - only create if credentials are available
let ovhClient = null;

const getOvhClient = () => {
    if (!ovhClient) {
        if (!process.env.OVH_APP_KEY || !process.env.OVH_APP_SECRET) {
            throw new Error('OVH credentials are not configured. Please set OVH_APP_KEY and OVH_APP_SECRET environment variables.');
        }
        ovhClient = ovh({
            endpoint: 'ovh-eu',
            appKey: process.env.OVH_APP_KEY,
            appSecret: process.env.OVH_APP_SECRET,
            consumerKey: process.env.OVH_CONSUMER_KEY
        });
    }
    return ovhClient;
};

// Création du Dialplan
exports.createDialplan = async (callerNumber, calleeNumber) => {
    try {
        const client = getOvhClient();
        const result = await client.requestPromised('POST', 
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
        const client = getOvhClient();
        const result = await client.requestPromised('POST', 
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
        const client = getOvhClient();
        const result = await client.requestPromised('GET', 
            `/telephony/${process.env.OVH_BILLING_ACCOUNT}/ovhPabx/${process.env.OVH_SERVICE_NAME}/calls/${callId}/status`
        );
        return result;
    } catch (error) {
        console.error('Erreur dans trackCallStatus Service:', error);
        throw new Error('Erreur lors du suivi de l\'appel');
    }
};
