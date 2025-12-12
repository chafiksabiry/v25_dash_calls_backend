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
        // Créer l'appel avec Telnyx Call Control
        const call = await telnyx.calls.create({
          connection_id: process.env.TELNYX_APPLICATION_ID || process.env.TELNYX_CONNECTION_ID,
          to: to,
          from: from,
          webhook_url: process.env.WEBHOOK_URL || 'https://api-calls.harx.ai/webhook',
          webhook_url_method: 'POST'
        });

        const callControlId = call.data.call_control_id;
        
        // Démarrer le Media Stream avec le call_control_id dans l'URL
        await telnyx.calls.streamStart({
          call_control_id: callControlId,
          stream_url: `wss://api-calls.harx.ai/audio-stream?callControlId=${callControlId}`,
          stream_track: 'both_tracks'
        });
        
        // Stocker l'appel actif
        activeCalls.set(callControlId, {
          socketId: socket.id,
          to,
          from,
          status: 'initiated',
          callControlId
        });

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
    socket.on('audio-data', (data) => {
      const { callControlId, audioChunk } = data;
      
      // Transférer l'audio vers Telnyx via Media Stream
      if (activeCalls.has(callControlId)) {
        const { sendAudioToTelnyx } = require('./telnyxMediaStream');
        sendAudioToTelnyx(callControlId, audioChunk);
      }
    });

    // Événement : Terminer l'appel
    socket.on('hangup-call', async (data) => {
      const { callControlId } = data;
      console.log('📴 Terminer appel:', callControlId);

      try {
        // Terminer l'appel via Telnyx (syntaxe correcte)
        await telnyx.calls.hangup({
          call_control_id: callControlId
        });
        
        activeCalls.delete(callControlId);
        
        socket.emit('call-ended', {
          callControlId,
          status: 'ended'
        });

      } catch (error) {
        console.error('Erreur hangup:', error);
      }
    });

    // Événement : Mute/Unmute
    socket.on('toggle-mute', async (data) => {
      const { callControlId, muted } = data;
      
      try {
        // Syntaxe correcte pour l'API Telnyx
        if (muted) {
          await telnyx.calls.mute({
            call_control_id: callControlId
          });
        } else {
          await telnyx.calls.unmute({
            call_control_id: callControlId
          });
        }
        
        socket.emit('mute-status', { callControlId, muted });
        console.log(`🔇 Mute: ${muted} pour call ${callControlId}`);
        
      } catch (error) {
        console.error('Erreur mute/unmute:', error);
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
      
      console.log('Statut appel', callControlId, ':', status);
    }
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

