const WebSocket = require('ws');
const { activeCalls } = require('./audioServer');
// const { alawToMulaw, mulawToAlaw } = require('./g711'); // Conversion désactivée car on demande PCMU

let io; // Référence Socket.IO
let telnyxStreams = new Map(); // Map des streams Telnyx par call_control_id

// Gérer le Media Stream de Telnyx (audio bidirectionnel)
function handleTelnyxMediaStream(ws, req) {
  console.log('🎵 Telnyx Media Stream connecté');
  
  let currentCallId = null;
  
  // Fonction pour traiter les messages JSON
  function handleJsonMessage(data) {
    switch(data.event) {
      case 'connected':
        // Première connexion établie - attendre le message "start"
        console.log(`✅ Connexion Media Stream établie (version: ${data.version})`);
        break;
        
      case 'start':
        // Telnyx envoie le call_control_id dans le message start
        currentCallId = data.call_control_id || data.callControlId || data.metadata?.call_control_id || data.start?.call_control_id;
        
        if (currentCallId) {
          telnyxStreams.set(currentCallId, ws);
          console.log(`🎤 Stream démarré pour call: ${currentCallId}`);
          
          // Log du format média négocié
          if (data.start && data.start.media_format) {
             console.log('ℹ️ Format média Telnyx négocié:', JSON.stringify(data.start.media_format));
          }
        } else {
          console.error('❌ Pas de call_control_id dans le message start:', JSON.stringify(data, null, 2));
        }
        break;
        
      case 'media':
        // Audio reçu de Telnyx (voix du receiver)
        // On a demandé PCMU, donc on reçoit du u-Law directement.
        // On transfère tel quel au frontend qui attend du u-Law.
        if (currentCallId && data.media && data.media.payload) {
          sendAudioToFrontend(currentCallId, data.media.payload);
        } else if (data.media && !currentCallId) {
          // console.log('⚠️ Media reçu mais pas de currentCallId');
        }
        break;
        
      case 'stop':
        console.log(`🔇 Stream terminé pour call: ${currentCallId}`);
        telnyxStreams.delete(currentCallId); // Retirer le stream
        break;
        
      default:
        // Ignorer les autres événements pour ne pas polluer
        // console.log(`⚠️ Événement Telnyx non géré: ${data.event}`);
        break;
    }
  }

  let receivedPacketCount = 0;
  
  ws.on('message', (message) => {
    try {
      // Vérifier si c'est un message binaire ou JSON
      if (Buffer.isBuffer(message)) {
        // Essayer de parser en JSON d'abord
        const strMessage = message.toString('utf8');
        
        // Si ça ressemble à du JSON, essayer de le parser
        if (strMessage.startsWith('{')) {
          const data = JSON.parse(strMessage);
          
          // Log pour debug (uniquement start/stop ou erreur)
          if (data.event !== 'media') {
            console.log('📨 Message JSON Telnyx:', JSON.stringify(data, null, 2));
          } else {
             if (receivedPacketCount === 0) console.log('🎧 PREMIER AUDIO REÇU (JSON)');
             receivedPacketCount++;
          }
          
          handleJsonMessage(data);
          return;
        }
        
        // Sinon, c'est de l'audio binaire (Raw PCMU car demandé)
        if (currentCallId) {
          const audioBase64 = message.toString('base64');
          sendAudioToFrontend(currentCallId, audioBase64);
          
          if (receivedPacketCount === 0) console.log('🎧 PREMIER AUDIO REÇU (BINAIRE)');
          receivedPacketCount++;
        }
        return;
      }

      // Message JSON string
      const data = JSON.parse(message.toString());
      if (data.event !== 'media') {
        console.log('📨 Message JSON Telnyx:', JSON.stringify(data, null, 2));
      } else {
         if (receivedPacketCount === 0) console.log('🎧 PREMIER AUDIO REÇU (STRING)');
         receivedPacketCount++;
      }
      handleJsonMessage(data);
    } catch (error) {
      console.error('❌ Erreur parsing message Telnyx:', error);
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
let frontendSentCount = 0;
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
      
      if (frontendSentCount % 50 === 0) { // Moins de logs
        console.log(`📤 Audio envoyé au frontend (#${frontendSentCount}, ${audioPayload.length} chars)`);
      }
      frontendSentCount++;
    }
  }
}

// Envoyer l'audio du frontend vers Telnyx
let sentPacketCount = 0;
function sendAudioToTelnyx(callControlId, audioPayload) {
  const telnyxWs = telnyxStreams.get(callControlId);
  
  if (telnyxWs && telnyxWs.readyState === WebSocket.OPEN) {
    // CONVERSION : Frontend envoie u-Law (PCMU), Telnyx attend A-Law (PCMA)
    const ulawBuffer = Buffer.from(audioPayload, 'base64');
    const alawBuffer = mulawToAlaw(ulawBuffer);
    const alawPayload = alawBuffer.toString('base64');
    
    telnyxWs.send(JSON.stringify({
      event: 'media',
      media: {
        payload: alawPayload
      }
    }));
    
    if (sentPacketCount % 50 === 0) { // Moins de logs
      console.log(`🎵 Audio envoyé vers Telnyx (${audioPayload.length} chars -> converted)`);
    }
    sentPacketCount++;
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
