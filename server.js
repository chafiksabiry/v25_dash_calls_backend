const express = require('express');
const cors = require('cors');
const http = require('http');
const WebSocket = require('ws');
const url = require('url');
const axios = require('axios');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json());

// Configuration Telnyx
const telnyx = require('telnyx')(process.env.TELNYX_API_KEY);

// Initialiser le serveur audio WebSocket (Socket.IO)
const { initializeAudioServer, updateCallStatus, speakOnCall } = require('./audioServer');
const audioIO = initializeAudioServer(server);

// Importer le handler Telnyx Media Stream
const { handleTelnyxMediaStream, setIO } = require('./telnyxMediaStream');
setIO(audioIO);

// Gérer les upgrade requests pour le Media Stream
server.on('upgrade', (request, socket, head) => {
  const pathname = url.parse(request.url).pathname;
  
  console.log('🔌 Upgrade request:', pathname);
  
  // Route /audio-stream vers le handler Telnyx Media Stream
  if (pathname === '/audio-stream') {
    const wss = new WebSocket.Server({ noServer: true });
    
    wss.handleUpgrade(request, socket, head, (ws) => {
      handleTelnyxMediaStream(ws, request);
    });
  }
  // Les autres routes (comme /socket.io/) sont gérées par Socket.IO automatiquement
});

// Numéro Telnyx
const TELNYX_NUMBER = '+33423340775';

// Liste des numéros français à appeler
const FRENCH_NUMBERS = [
  '+33623984708',
  '+33143204189',
  '+33142333820',
  '+33143549420',
  '+33155872140',
  '+33145746892',
  '+33188480991'
];

// Stockage des appels (en mémoire pour la démo)
let callHistory = [];

// Route pour obtenir la liste des numéros
app.get('/api/numbers', (req, res) => {
  res.json({
    telnyxNumber: TELNYX_NUMBER,
    frenchNumbers: FRENCH_NUMBERS
  });
});


// Route pour passer un appel
app.post('/api/call', async (req, res) => {
  const { to } = req.body;

  if (!to) {
    return res.status(400).json({ error: 'Le numéro de destination est requis' });
  }

  // Vérifier que les variables d'environnement sont configurées
  if (!process.env.TELNYX_API_KEY) {
    console.error('TELNYX_API_KEY non configurée');
    return res.status(500).json({
      error: 'Configuration serveur manquante',
      details: 'La clé API Telnyx n\'est pas configurée'
    });
  }

  const connectionId = process.env.TELNYX_APPLICATION_ID || process.env.TELNYX_CONNECTION_ID;
  if (!connectionId) {
    console.error('TELNYX_APPLICATION_ID ou TELNYX_CONNECTION_ID non configurée');
    return res.status(500).json({
      error: 'Configuration serveur manquante',
      details: 'L\'ID d\'application Telnyx n\'est pas configuré'
    });
  }

  try {
    console.log('🔄 Tentative d\'appel:', {
      from: TELNYX_NUMBER,
      to: to,
      connection_id: connectionId
    });

    const call = await telnyx.calls.create({
      connection_id: connectionId,
      to: to,
      from: TELNYX_NUMBER,
      webhook_url: process.env.WEBHOOK_URL || `http://localhost:${PORT}/webhook`,
      webhook_url_method: 'POST'
    });

    console.log('✅ Appel créé avec succès:', {
      call_control_id: call.data.call_control_id,
      call_leg_id: call.data.call_leg_id,
      call_session_id: call.data.call_session_id
    });

    // Ajouter à l'historique
    const callRecord = {
      id: call.data.call_control_id,
      to: to,
      from: TELNYX_NUMBER,
      status: 'initiated',
      timestamp: new Date().toISOString(),
      raw: call.data // Garder toutes les données pour debug
    };
    callHistory.push(callRecord);

    res.json({
      success: true,
      call: callRecord
    });
  } catch (error) {
    console.error('Erreur lors de l\'appel:', error);
    console.error('Détails de l\'erreur:', error.response?.data || error.message);
    res.status(500).json({
      error: 'Erreur lors de l\'initiation de l\'appel',
      details: error.response?.data?.errors?.[0]?.detail || error.message
    });
  }
});

// Route pour obtenir l'historique des appels
app.get('/api/call-history', (req, res) => {
  res.json({ calls: callHistory });
});

// Webhook pour recevoir les événements Telnyx
app.post('/webhook', (req, res) => {
  const event = req.body;
  
  const eventType = event.data?.event_type;
  const callControlId = event.data?.payload?.call_control_id;
  const state = event.data?.payload?.state;
  
  console.log('📞 Événement Telnyx reçu:', {
    event_type: eventType,
    call_control_id: callControlId,
    state: state
  });

  // Mettre à jour le statut via WebSocket
  if (callControlId) {
    // Mapper les événements Telnyx vers des statuts utilisateur
    let status = eventType;
    
    switch(eventType) {
      case 'call.initiated':
        status = 'calling';
        break;
      case 'call.ringing':
        status = 'ringing';
        break;
      case 'call.answered':
        status = 'active';
        // L'appel est actif, démarrer le Media Stream maintenant
        console.log('✅ Appel répondu - Démarrage du Media Stream...');
        
        // Démarrer le streaming audio bidirectionnel
        // Utiliser l'API HTTP directement car le SDK peut ne pas avoir cette méthode
        axios.post(`https://api.telnyx.com/v2/calls/${callControlId}/actions/streaming_start`, {
          stream_url: 'wss://api-calls.harx.ai/audio-stream',
          stream_track: 'both_tracks'
        }, {
          headers: {
            'Authorization': `Bearer ${process.env.TELNYX_API_KEY}`,
            'Content-Type': 'application/json'
          }
        }).then(response => {
          console.log(`🎵 Media Stream démarré pour ${callControlId}`);
        }).catch(err => {
          console.error('❌ Erreur démarrage stream:', err.response?.data || err.message);
        });
        break;
      case 'call.hangup':
        status = 'ended';
        break;
      case 'call.speak.ended':
        status = 'active';
        break;
    }
    
    // Notifier le client via WebSocket
    updateCallStatus(callControlId, status, { 
      originalEvent: eventType,
      state: state 
    });

    // Mettre à jour l'historique
    const callIndex = callHistory.findIndex(
      call => call.id === callControlId
    );
    
    if (callIndex !== -1) {
      callHistory[callIndex].status = status;
      callHistory[callIndex].state = state;
      callHistory[callIndex].lastUpdate = new Date().toISOString();
    }
  }

  res.sendStatus(200);
});

// Route de test
app.get('/api/health', (req, res) => {
  const config = {
    status: 'OK',
    message: 'Serveur Telnyx opérationnel',
    configuration: {
      apiKeyConfigured: !!process.env.TELNYX_API_KEY,
      applicationIdConfigured: !!(process.env.TELNYX_APPLICATION_ID || process.env.TELNYX_CONNECTION_ID),
      webhookUrlConfigured: !!process.env.WEBHOOK_URL,
      telnyxNumber: TELNYX_NUMBER
    }
  };
  
  res.json(config);
});

server.listen(PORT, () => {
  console.log(`🚀 Serveur démarré sur le port ${PORT}`);
  console.log(`📞 Numéro Telnyx: ${TELNYX_NUMBER}`);
  console.log(`📋 ${FRENCH_NUMBERS.length} numéros français disponibles`);
  console.log(`🎵 WebSocket audio prêt sur ws://localhost:${PORT}`);
});

