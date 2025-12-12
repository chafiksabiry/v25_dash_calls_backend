const WebSocket = require('ws');
const { activeCalls } = require('./audioServer');

let io; // Référence Socket.IO
let telnyxStreams = new Map(); // Map des streams Telnyx par call_control_id

// Gérer le Media Stream de Telnyx (audio bidirectionnel)
function handleTelnyxMediaStream(ws, req) {
  console.log('🎵 Telnyx Media Stream connecté');
  
  let currentCallId = null;
  
  // Fonction pour traiter les messages JSON
  function handleJsonMessage(data) {
    switch(data.event) {
      case 'start':
        // Telnyx envoie le call_control_id dans le message start
        currentCallId = data.call_control_id || data.callControlId || data.metadata?.call_control_id;
        
        if (currentCallId) {
          telnyxStreams.set(currentCallId, ws);
          console.log(`🎤 Stream démarré pour call: ${currentCallId}`);
        } else {
          console.error('❌ Pas de call_control_id dans le message start:', data);
        }
        break;
        
      case 'media':
        // Audio reçu de Telnyx (voix du receiver) au format JSON
        if (currentCallId && data.media && data.media.payload) {
          sendAudioToFrontend(currentCallId, data.media.payload);
        }
        break;
        
      case 'stop':
        console.log(`🔇 Stream terminé pour call: ${currentCallId}`);
        telnyxStreams.delete(currentCallId); // Retirer le stream
        break;
    }
  }

  ws.on('message', (message) => {
    console.log(`📩 Message reçu de Telnyx (type: ${Buffer.isBuffer(message) ? 'Buffer' : typeof message}, length: ${message.length})`);
    
    try {
      // Vérifier si c'est un message binaire ou JSON
      if (Buffer.isBuffer(message)) {
        // Essayer de parser en JSON d'abord
        const strMessage = message.toString('utf8');
        
        // Si ça ressemble à du JSON, essayer de le parser
        if (strMessage.startsWith('{')) {
          const data = JSON.parse(strMessage);
          console.log('📨 Message JSON Telnyx:', JSON.stringify(data, null, 2));
          
          // Traiter comme un message JSON
          handleJsonMessage(data);
          return;
        }
        
        // Sinon, c'est de l'audio binaire
        if (currentCallId) {
          const audioBase64 = message.toString('base64');
          sendAudioToFrontend(currentCallId, audioBase64);
        }
        return;
      }

      // Message JSON string
      const data = JSON.parse(message.toString());
      console.log('📨 Message JSON Telnyx:', JSON.stringify(data, null, 2));
      handleJsonMessage(data);
    } catch (error) {
      console.error('❌ Erreur parsing message Telnyx:', error);
      console.error('Message brut:', message.toString('utf8').substring(0, 200));
    }
  });

  ws.on('close', (code, reason) => {
    console.log(`🔌 Telnyx Media Stream déconnecté - Code: ${code}, Raison: ${reason}`);
    if (currentCallId) {
      telnyxStreams.delete(currentCallId);
    }
  });

  ws.on('error', (error) => {
    console.error('❌ Erreur WebSocket Media Stream:', error);
  });

  // Fonction pour envoyer audio du frontend vers Telnyx
  ws.sendAudioToTelnyx = (audioData) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        event: 'media',
        media: {
          payload: audioData
        }
      }));
    }
  };

  return ws;
}

// Envoyer l'audio au client frontend via Socket.IO
function sendAudioToFrontend(callControlId, audioPayload) {
  if (!io) return;
  
  const call = activeCalls.get(callControlId);
  if (call) {
    const socket = io.sockets.sockets.get(call.socketId);
    if (socket) {
      socket.emit('audio-received', {
        callControlId,
        audioChunk: audioPayload,
        timestamp: Date.now()
      });
    }
  }
}

// Envoyer l'audio du frontend vers Telnyx
function sendAudioToTelnyx(callControlId, audioPayload) {
  const telnyxWs = telnyxStreams.get(callControlId);
  
  if (telnyxWs && telnyxWs.readyState === WebSocket.OPEN) {
    telnyxWs.send(JSON.stringify({
      event: 'media',
      media: {
        payload: audioPayload
      }
    }));
    console.log(`🎵 Audio envoyé vers Telnyx (${audioPayload.length} bytes)`);
  } else {
    console.log(`⚠️ Impossible d'envoyer audio - Stream non disponible pour ${callControlId}`);
  }
}

function setIO(socketIO) {
  io = socketIO;
}

module.exports = {
  handleTelnyxMediaStream,
  sendAudioToTelnyx,
  setIO
};

