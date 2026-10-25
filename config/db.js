'use strict';

const mongoose = require('mongoose');
const config = require('./env');
const logger = require('../utils/logger');

// Connects to MongoDB. First it sets up listeners that log when the connection drops, comes back, or has an error,
// then it connects. If MongoDB can't be reached within 8 seconds, it throws and the server won't start.
async function connectDB() {
  mongoose.connection.on('disconnected', () => logger.warn('MongoDB disconnected'));
  mongoose.connection.on('reconnected', () => logger.info('MongoDB reconnected'));
  mongoose.connection.on('error', (err) => logger.error('MongoDB connection error', err));

  await mongoose.connect(config.mongoUri, { serverSelectionTimeoutMS: 8000 });
  logger.info(`MongoDB connected (${mongoose.connection.name})`);
}

module.exports = connectDB;
