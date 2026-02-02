const { BaseRepository } = require('./BaseRepository');
const { Settings } = require('../models/Settings');

class SettingsRepository extends BaseRepository {
  constructor() {
    super(Settings);
  }

  async findOrCreate(data = {}) {
    let settings = await this.model.findOne();
    if (!settings) {
      settings = await this.model.create(data);
    }
    return settings;
  }

  async updateLogo(logo) {
    let settings = await this.findOrCreate();
    settings.company.logo = logo;
    return settings.save();
  }
}

module.exports = { SettingsRepository };