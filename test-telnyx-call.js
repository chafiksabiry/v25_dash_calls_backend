require('dotenv').config();
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const telnyxService = require('./src/services/integrations/telnyxService');

// Configuration de l'appel
const config = {
    callerNumber: '+33423340775',
    calleeNumber: '+33652411708',
    streamUrl: `wss://5f145e6a551c.ngrok-free.app/test-audio-stream`, // URL du serveur WebSocket local
    streamCodec: 'PCMU',
    streamSampleRate: '8000'
};

// Créer le dossier recordings s'il n'existe pas
const recordingsDir = path.join(__dirname, 'recordings');
if (!fs.existsSync(recordingsDir)) {
    fs.mkdirSync(recordingsDir);
}

// Fonction pour initier l'appel
async function makeTestCall() {
    try {
        console.log('🚀 Initialisation de l\'appel test...');
        
        // Créer l'appel avec Telnyx en utilisant la nouvelle méthode de test
        const call = await telnyxService.makeTestCall(
            config.calleeNumber,
            config.callerNumber,
            {
                streamUrl: config.streamUrl,
                streamCodec: config.streamCodec,
                streamSampleRate: config.streamSampleRate
            }
        );

        console.log('📞 Appel initié:', call);
        return call;
    } catch (error) {
        console.error('❌ Erreur lors de l\'initiation de l\'appel:', error);
        process.exit(1);
    }
}

// Lancer l'appel test
makeTestCall();
