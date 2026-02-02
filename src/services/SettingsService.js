const { SettingsRepository } = require('../repositories/SettingsRepository');

class SettingsService {
  constructor() {
    this.repository = new SettingsRepository();
  }

  async getSettings() {
    return this.repository.findOrCreate();
  }

  async updateSettings(data) {
    const settings = await this.repository.findOrCreate();
    return this.repository.update(settings._id, data);
  }

  async updateLogo(logo) {
    return this.repository.updateLogo(logo);
  }
}

module.exports = { SettingsService };