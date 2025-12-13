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
const { initializeAudioServer, updateCallStatus, speakOnCall, activeCalls } = require('./audioServer');
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
  '+33188480991',
  '+33659060538'
];

// Stockage des appels (en mémoire pour la démo)
let callHistory = [];

// Fonction pour ajouter un appel à l'historique (utilisée par audioServer.js)
function addToCallHistory(callRecord) {
  callHistory.push(callRecord);
}

// Exporter callHistory et la fonction pour l'ajouter
module.exports.callHistory = callHistory;
module.exports.addToCallHistory = addToCallHistory;

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

    // Récupérer le socketId depuis activeCalls si disponible
    const { activeCalls } = require('./audioServer');
    const activeCall = activeCalls.get(call.data.call_control_id);
    
    // Ajouter à l'historique avec le socketId pour pouvoir envoyer des événements plus tard
    const callRecord = {
      id: call.data.call_control_id,
      to: to,
      from: TELNYX_NUMBER,
      status: 'initiated',
      timestamp: new Date().toISOString(),
      socketId: activeCall ? activeCall.socketId : null, // Stocker le socketId dès le début
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
app.post('/webhook', async (req, res) => {
  const event = req.body;
  
  const eventType = event.data?.event_type;
  const callControlId = event.data?.payload?.call_control_id;
  const state = event.data?.payload?.state;
  
  // Répondre immédiatement à Telnyx pour éviter les timeouts
  // (on traite l'événement de manière asynchrone après)
  res.sendStatus(200);
  
  console.log('📞 Événement Telnyx reçu:', {
    event_type: eventType,
    call_control_id: callControlId,
    state: state,
    timestamp: new Date().toISOString()
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
      case 'call.active': // Ou quand l'appel est répondu
      case 'call.answered':
        status = 'active';
        
        // Log pour voir si les deux événements sont reçus
        console.log(`🔔 Événement ${eventType} reçu pour ${callControlId}`);
        
        // Vérifier si l'enregistrement/stream n'a pas déjà été démarré pour éviter les doublons
        // Utiliser un Set global pour tracker les streams démarrés (plus fiable que callHistory)
        if (!global.startedStreams) {
          global.startedStreams = new Set();
        }
        
        if (global.startedStreams.has(callControlId)) {
          console.log(`⚠️ Stream déjà démarré pour ${callControlId} (événement: ${eventType}), ignoré (évite doublons)`);
          break;
        }
        
        // Marquer comme démarré IMMÉDIATEMENT pour éviter les race conditions
        global.startedStreams.add(callControlId);
        console.log(`✅ Stream marqué comme démarré pour ${callControlId} (événement: ${eventType}, total: ${global.startedStreams.size})`);
        
        // L'appel est actif, démarrer l'enregistrement et le Media Stream maintenant
        console.log(`✅ Appel répondu (${eventType}) - Démarrage de l'enregistrement et du Media Stream...`);

        // 1. Démarrer l'enregistrement (seulement si pas déjà démarré)
        // Telnyx ne permet pas de démarrer l'enregistrement avant que l'appel soit répondu
        // Mais une fois démarré, il capture tout jusqu'à la fin de l'appel
        if (!global.startedRecordings) {
          global.startedRecordings = new Set();
        }
        
        if (!global.startedRecordings.has(callControlId)) {
          global.startedRecordings.add(callControlId);
          console.log(`🎙️ Démarrage enregistrement pour ${callControlId} (événement: ${eventType})`);
          
          // Utiliser 'single' channel pour éviter les problèmes
          axios.post(`https://api.telnyx.com/v2/calls/${callControlId}/actions/record_start`, {
            format: 'mp3',
            channels: 'single'
          }, {
            headers: {
              'Authorization': `Bearer ${process.env.TELNYX_API_KEY}`,
              'Content-Type': 'application/json'
            }
          }).then(() => {
            console.log(`🎙️ Enregistrement démarré avec succès pour ${callControlId}`);
            
            // Stocker l'heure de début pour calculer la durée plus tard
            if (!global.callStartTimes) {
              global.callStartTimes = {};
            }
            global.callStartTimes[callControlId] = Date.now();
            console.log(`⏱️ Heure de début enregistrement stockée pour ${callControlId}`);
          }).catch(err => {
            console.error(`❌ Erreur démarrage enregistrement:`, err.response?.data || err.message);
            // Retirer du Set en cas d'erreur
            global.startedRecordings.delete(callControlId);
          });
        } else {
          console.log(`⚠️ Enregistrement déjà démarré pour ${callControlId}, ignoré`);
        }
        
        // 2. Démarrer le streaming audio bidirectionnel
        // Utiliser 'both_tracks' pour recevoir l'audio de l'interlocuteur ET envoyer le vôtre
        // Demander explicitement du PCMA (A-Law) pour l'Europe
        axios.post(`https://api.telnyx.com/v2/calls/${callControlId}/actions/streaming_start`, {
          stream_url: 'wss://api-calls.harx.ai/audio-stream',
          stream_track: 'both_tracks', // CHANGED: both_tracks pour audio bidirectionnel complet
          media_format: {
            encoding: 'PCMA', // PCMA pour A-Law (Europe)
            sample_rate: 8000,
            channels: 1
          },
          enable_dialogflow: false,
          client_state: Buffer.from(JSON.stringify({ callControlId })).toString('base64')
        }, {
          headers: {
            'Authorization': `Bearer ${process.env.TELNYX_API_KEY}`,
            'Content-Type': 'application/json'
          }
        }).then(response => {
          console.log(`🎵 Media Stream démarré pour ${callControlId}`, JSON.stringify(response.data, null, 2));
        }).catch(err => {
          console.error('❌ Erreur démarrage stream:', err.response?.data || err.message);
          if (err.response?.data) {
            console.error('Details:', JSON.stringify(err.response.data, null, 2));
          }
        });
        break;
      case 'call.hangup':
        status = 'ended';
        
        // Calculer la durée si on a l'heure de début
        if (global.callStartTimes && global.callStartTimes[callControlId]) {
          const startTime = global.callStartTimes[callControlId];
          const duration = Math.floor((Date.now() - startTime) / 1000);
          console.log(`⏱️ Durée appel calculée: ${duration} secondes pour ${callControlId}`);
          
          // Stocker la durée dans l'historique
          const callIndex = callHistory.findIndex(call => call.id === callControlId);
          if (callIndex !== -1) {
            callHistory[callIndex].duration = duration;
            callHistory[callIndex].lastUpdate = new Date().toISOString();
          }
          
          // Nettoyer
          delete global.callStartTimes[callControlId];
        }
        
        // Nettoyer les flags de stream et enregistrement démarrés
        if (global.startedStreams) {
          global.startedStreams.delete(callControlId);
        }
        if (global.startedRecordings) {
          global.startedRecordings.delete(callControlId);
        }
        // L'enregistrement s'arrêtera automatiquement quand l'appel se termine
        // Pas besoin d'appeler record_stop explicitement ici
        break;
      case 'call.recording.saved':
        // L'enregistrement est sauvegardé, récupérer l'URL et l'envoyer au frontend
        console.log(`💾 Événement call.recording.saved reçu pour ${callControlId}`);
        console.log(`📋 Données complètes de l'événement:`, JSON.stringify(event.data?.payload || event.data, null, 2));
        
        const recordingId = event.data?.payload?.recording_id || event.data?.payload?.id || event.data?.id;
        const recordingUrl = event.data?.payload?.recording_urls?.mp3 || event.data?.payload?.download_url || event.data?.download_url;
        
        console.log(`💾 Enregistrement sauvegardé pour ${callControlId}:`, {
          recordingId,
          recordingUrl,
          fullPayload: event.data?.payload
        });
        
        if (recordingUrl) {
          // Envoyer l'URL de l'enregistrement au frontend via WebSocket
          console.log(`📤 Envoi URL enregistrement au frontend pour ${callControlId}: ${recordingUrl.substring(0, 100)}...`);
          
          // Essayer d'abord avec activeCalls
          const call = activeCalls.get(callControlId);
          if (call && call.socketId && audioIO) {
            const socket = audioIO.sockets.sockets.get(call.socketId);
            if (socket) {
              socket.emit('call-status', {
                callControlId,
                status: 'recording-saved',
                recordingId,
                recordingUrl,
                originalEvent: eventType
              });
              console.log(`✅ URL enregistrement envoyée au frontend via activeCalls pour ${callControlId}`);
            } else {
              console.warn(`⚠️ Socket non trouvé pour ${callControlId} (socketId: ${call.socketId})`);
            }
          } else {
            // Si l'appel n'est plus dans activeCalls, chercher dans callHistory
            console.log(`⚠️ Appel ${callControlId} non trouvé dans activeCalls, recherche dans callHistory...`);
            const callIndex = callHistory.findIndex(c => c.id === callControlId);
            if (callIndex !== -1) {
              console.log(`📋 Appel trouvé dans callHistory à l'index ${callIndex}, socketId: ${callHistory[callIndex].socketId}`);
              if (callHistory[callIndex].socketId && audioIO) {
                const socket = audioIO.sockets.sockets.get(callHistory[callIndex].socketId);
                if (socket) {
                  socket.emit('call-status', {
                    callControlId,
                    status: 'recording-saved',
                    recordingId,
                    recordingUrl,
                    originalEvent: eventType
                  });
                  console.log(`✅ URL enregistrement envoyée au frontend via callHistory pour ${callControlId}`);
                } else {
                  console.warn(`⚠️ Socket non trouvé dans callHistory pour ${callControlId} (socketId: ${callHistory[callIndex].socketId})`);
                  console.log(`📋 Sockets disponibles:`, Array.from(audioIO.sockets.sockets.keys()));
                  // En dernier recours, utiliser updateCallStatus
                  updateCallStatus(callControlId, 'recording-saved', {
                    recordingId,
                    recordingUrl,
                    originalEvent: eventType
                  });
                  console.log(`✅ URL enregistrement envoyée au frontend via updateCallStatus (fallback) pour ${callControlId}`);
                }
              } else {
                console.warn(`⚠️ Pas de socketId dans callHistory pour ${callControlId}`);
                // En dernier recours, utiliser updateCallStatus
                updateCallStatus(callControlId, 'recording-saved', {
                  recordingId,
                  recordingUrl,
                  originalEvent: eventType
                });
                console.log(`✅ URL enregistrement envoyée au frontend via updateCallStatus (fallback) pour ${callControlId}`);
              }
            } else {
              console.warn(`⚠️ Appel ${callControlId} non trouvé dans callHistory non plus`);
              // En dernier recours, utiliser updateCallStatus
              updateCallStatus(callControlId, 'recording-saved', {
                recordingId,
                recordingUrl,
                originalEvent: eventType
              });
              console.log(`✅ URL enregistrement envoyée au frontend via updateCallStatus (dernier recours) pour ${callControlId}`);
            }
          }
        } else {
          console.warn(`⚠️ Pas d'URL d'enregistrement dans l'événement pour ${callControlId}`);
          // Essayer de récupérer l'enregistrement via l'API Telnyx
          if (recordingId) {
            axios.get(`https://api.telnyx.com/v2/recordings/${recordingId}`, {
              headers: {
                'Authorization': `Bearer ${process.env.TELNYX_API_KEY}`
              }
            }).then(response => {
              const downloadUrl = response.data?.data?.download_url || response.data?.data?.recording_urls?.mp3;
              if (downloadUrl) {
                console.log(`✅ URL d'enregistrement récupérée via API: ${downloadUrl}`);
                updateCallStatus(callControlId, 'recording-saved', {
                  recordingId,
                  recordingUrl: downloadUrl,
                  originalEvent: eventType
                });
              }
            }).catch(err => {
              console.error(`❌ Erreur récupération enregistrement via API:`, err.response?.data || err.message);
            });
          }
        }
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
      
      // Stocker le socketId si disponible pour pouvoir envoyer des événements après la fin de l'appel
      const { activeCalls } = require('./audioServer');
      const activeCall = activeCalls.get(callControlId);
      if (activeCall && activeCall.socketId) {
        callHistory[callIndex].socketId = activeCall.socketId;
      }
      
      // Calculer la durée si l'appel se termine
      if (status === 'ended') {
        const startTime = new Date(callHistory[callIndex].timestamp);
        const endTime = new Date();
        const durationSeconds = Math.floor((endTime - startTime) / 1000);
        callHistory[callIndex].duration = durationSeconds;
        console.log(`⏱️ Durée appel calculée: ${durationSeconds} secondes`);
      }
    }
  }
  
  // Note: On répond déjà au début du handler pour éviter les timeouts
  // Pas besoin de répondre à nouveau ici
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

