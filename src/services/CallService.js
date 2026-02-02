
const { CallRepository } = require('../repositories/CallRepository');
const { OVHService } = require('./integrations/OVHService');
const { Integration } = require('../models/Integration');
require('dotenv').config();
class CallService {
  constructor() {
    this.repository = new CallRepository();
  }

  async getAllCalls() {
    return this.repository.findAll({}, ['agent', 'lead']);
  }

  async getCallById(id) {
    return this.repository.findById(id, ['agent', 'lead']);
  }

  
  
  async initiateCall(agentId, phoneNumber) {
    console.log("we are in initiatecallservice");
    try {
      // Vérifier si les configurations nécessaires sont dans .env
      const {
        OVH_APPLICATION_KEY,
        OVH_APPLICATION_SECRET,
        OVH_CONSUMER_KEY,
        OVH_DEFAULT_NUMBER,
        OVH_SERVICE_NAME,
        OVH_BILLING_ACCOUNT
      } = process.env;
  
      if (!OVH_APPLICATION_KEY || !OVH_APPLICATION_SECRET || !OVH_DEFAULT_NUMBER) {
        throw new Error('Les configurations OVH sont manquantes dans le fichier .env');
      }
      console.log("before initialize  ovhservice");
      // Initialiser le service OVH avec les configurations depuis .env
      const ovhService = new OVHService(
        OVH_APPLICATION_KEY,
        OVH_APPLICATION_SECRET,
        OVH_CONSUMER_KEY
      );
      console.log("ovhService",ovhService);
  
      // Créer l'appel dans la base de données
      const call = await this.repository.create({
        agent: agentId,
        phone_number: phoneNumber,
        direction: 'outbound',
        status: 'active'
      });
      console.log('call in db', call);
  
      // Initier l'appel via OVH
      const ovhCall = await ovhService.makeCall(
        phoneNumber,
        OVH_DEFAULT_NUMBER,
      );
      console.log("ovhCall",ovhCall);
  
      // Mettre à jour l'appel avec les informations OVH
     /*  return this.repository.update(call._id, {
        ovh_call_id: ovhCall.id
      }); */
      return;
    } catch (error) {
      throw new Error(`Failed to initiate call: ${error.message}`);
    }
  }
  

  async endCall(id, duration) {
    return this.repository.endCall(id, duration);
  }

  async addNote(id, note) {
    return this.repository.update(id, { notes: note });
  }

  async updateQualityScore(id, score) {
    return this.repository.updateQualityScore(id, score);
  }

}



module.exports = { CallService };