class BaseRepository {
  constructor(model) {
    this.model = model;
  }

  async findAll(filter = {}, populate) {
    return this.model.find(filter).populate(populate || []);
  }

  async findById(id, populate) {
    return this.model.findById(id).populate(populate || []);
  }

  async create(data) {
    return this.model.create(data);
  }

  async update(id, data) {
    return this.model.findByIdAndUpdate(id, data, {
      new: true,
      runValidators: true
    });
  }

  async delete(id) {
    return this.model.findByIdAndDelete(id);
  }
}

module.exports = { BaseRepository };