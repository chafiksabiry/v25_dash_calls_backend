const { Server } = require('socket.io');
const telnyx = require('telnyx')(process.env.TELNYX_API_KEY);

let io;
let activeCalls = new Map(); // Stocker les appels actifs

// Initialiser le serveur WebSocket
function initializeAudioServer(server) {
  io = new Server(server, {
    cors: {
      origin: '*',
      methods: ['GET', 'POST']
    }
  });

  io.on('connection', (socket) => {
    console.log('Client connecte:', socket.id);

    // Événement : Initier un appel
    socket.on('initiate-call', async (data) => {
      const { to, from } = data;
      console.log('Initiation appel:', from, '->', to);

      try {
        // Créer l'appel avec Telnyx Call Control (sans stream pour l'instant)
        const call = await telnyx.calls.create({
          connection_id: process.env.TELNYX_APPLICATION_ID || process.env.TELNYX_CONNECTION_ID,
          to: to,
          from: from,
          webhook_url: process.env.WEBHOOK_URL || 'https://api-calls.harx.ai/webhook',
          webhook_url_method: 'POST'
          // Note : Le stream sera démarré quand l'appel sera répondu (call.answered)
        });

        const callControlId = call.data.call_control_id;
        
        // Stocker l'appel actif
        activeCalls.set(callControlId, {
          socketId: socket.id,
          to,
          from,
          status: 'initiated',
          callControlId
        });

        // Ajouter à l'historique dans server.js pour que le socketId soit disponible pour les événements post-appel
        try {
          const { addToCallHistory } = require('./server');
          const callRecord = {
            id: callControlId,
            to: to,
            from: from,
            status: 'initiated',
            timestamp: new Date().toISOString(),
            socketId: socket.id, // Stocker le socketId dès le début
            raw: call.data
          };
          addToCallHistory(callRecord);
          console.log(`📝 Appel ajouté à callHistory avec socketId: ${socket.id}`);
        } catch (error) {
          console.warn('⚠️ Erreur ajout à callHistory:', error.message);
        }

        // Envoyer la confirmation au client
        socket.emit('call-initiated', {
          success: true,
          callControlId,
          status: 'initiated'
        });

        console.log('Appel cree:', callControlId);

      } catch (error) {
        console.error('Erreur creation appel:', error);
        console.error('Details:', error.raw?.errors);
        socket.emit('call-error', {
          error: error.message || 'Erreur lors de la creation de l\'appel',
          details: error.raw?.errors?.[0]?.detail || error.message
        });
      }
    });

    // Événement : Recevoir de l'audio du frontend (microphone)
    let audioPacketCount = 0;
    socket.on('audio-data', (data) => {
      const { callControlId, audioChunk } = data;
      
      // Log tous les 50 packets (environ toutes les 2 secondes)
      if (audioPacketCount % 50 === 0) {
        console.log(`📨 Audio reçu du frontend: ${audioChunk ? audioChunk.length : 0} bytes pour ${callControlId}`);
      }
      audioPacketCount++;
      
      // Transférer l'audio vers Telnyx via Media Stream
      if (activeCalls.has(callControlId)) {
        const { sendAudioToTelnyx } = require('./telnyxMediaStream');
        sendAudioToTelnyx(callControlId, audioChunk);
      } else {
        if (audioPacketCount % 50 === 0) {
          console.log(`⚠️ Appel ${callControlId} non trouvé dans activeCalls`);
        }
      }
    });

    // Événement : Terminer l'appel
    socket.on('hangup-call', async (data) => {
      const { callControlId } = data;
      console.log('📴 Terminer appel:', callControlId);

      // Retirer immédiatement de la liste pour éviter les doublons (race condition avec disconnect)
      const call = activeCalls.get(callControlId);
      if (call) {
        activeCalls.delete(callControlId);
      } else {
        // Déjà traité ou inexistant
        return;
      }

      try {
        const axios = require('axios');
        
        // 1. Terminer l'appel via Telnyx (l'enregistrement s'arrêtera automatiquement)
        // Ne pas appeler record_stop ici car cela peut causer des problèmes de timing
        await telnyx.calls.hangup({
          call_control_id: callControlId
        });
        
        socket.emit('call-ended', {
          callControlId,
          status: 'ended'
        });

      } catch (error) {
        // Ignorer l'erreur si l'appel est déjà terminé (404 ou 422)
        if (error.raw?.statusCode === 404 || error.raw?.statusCode === 422) {
            console.log(`⚠️ Hangup ignoré (appel déjà terminé ou invalide): ${error.raw?.statusCode}`);
        } else {
            console.error('Erreur hangup:', error.message);
        }
      }
    });

    // Événement : Mute/Unmute
    socket.on('toggle-mute', async (data) => {
      const { callControlId, muted } = data;
      
      try {
        const axios = require('axios');
        const url = `https://api.telnyx.com/v2/calls/${callControlId}/actions/${muted ? 'mute' : 'unmute'}`;
        
        await axios.post(url, {}, {
          headers: {
            'Authorization': `Bearer ${process.env.TELNYX_API_KEY}`,
            'Content-Type': 'application/json'
          }
        });
        
        socket.emit('mute-status', { callControlId, muted });
        console.log(`🔇 Mute: ${muted} pour call ${callControlId}`);
        
      } catch (error) {
        console.error('Erreur mute/unmute:', error.response?.data || error.message);
      }
    });

    socket.on('disconnect', () => {
      console.log('Client deconnecte:', socket.id);
      
      // Terminer tous les appels actifs de ce client
      for (const [callControlId, call] of activeCalls.entries()) {
        if (call.socketId === socket.id) {
          telnyx.calls.hangup({
            call_control_id: callControlId
          }).catch(console.error);
          activeCalls.delete(callControlId);
        }
      }
    });
  });

  console.log('Serveur audio WebSocket initialise');
  
  return io; // Retourner l'instance pour utilisation ailleurs
}

// Note: La fonction forwardAudioToTelnyx a été déplacée vers telnyxMediaStream.js
// L'audio est maintenant envoyé via le Media Stream WebSocket

// Recevoir de l'audio depuis Telnyx et l'envoyer au client
function receiveAudioFromTelnyx(callControlId, audioData) {
  const call = activeCalls.get(callControlId);
  
  if (call && io) {
    const socket = io.sockets.sockets.get(call.socketId);
    
    if (socket) {
      // Envoyer l'audio au client frontend via Socket.IO
      socket.emit('audio-received', {
        callControlId,
        audioChunk: audioData,
        timestamp: Date.now()
      });
      console.log('🎵 Audio envoyé au client:', audioData.length, 'bytes');
    }
  }
}

// Envoyer un message TTS à l'appelé quand il répond
async function speakOnCall(callControlId, message) {
  try {
    // Syntaxe correcte de l'API Telnyx pour speak
    await telnyx.calls.speak({
      call_control_id: callControlId,
      payload: message,
      voice: 'female',
      language: 'fr-FR'
    });
    console.log('🗣️ Message TTS envoyé:', message);
  } catch (error) {
    console.error('❌ Erreur TTS:', error);
    console.error('Détails:', error.message);
  }
}

// Mettre à jour le statut d'un appel
function updateCallStatus(callControlId, status, data = {}) {
  const call = activeCalls.get(callControlId);
  
  if (call && io) {
    call.status = status;
    
    const socket = io.sockets.sockets.get(call.socketId);
    
    if (socket) {
      socket.emit('call-status', {
        callControlId,
        status,
        ...data
      });
      
      console.log(`📤 Statut appel ${callControlId}: ${status} envoyé au socket ${call.socketId}`);
    } else {
      console.warn(`⚠️ Socket non trouvé pour ${callControlId} (socketId: ${call.socketId})`);
      console.log(`📋 Sockets disponibles:`, Array.from(io.sockets.sockets.keys()));
    }
  } else {
    console.warn(`⚠️ Appel ${callControlId} non trouvé dans activeCalls pour updateCallStatus`);
  }
}

// Obtenir la référence au serveur Socket.IO
function getIO() {
  return io;
}

module.exports = {
  initializeAudioServer,
  receiveAudioFromTelnyx,
  updateCallStatus,
  speakOnCall,
  activeCalls,
  getIO
};

