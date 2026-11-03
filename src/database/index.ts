import mongoose from 'mongoose';
import { config } from '../config/env';
import { logger } from '../config/logger';

let isConnected = false;

export async function connectDatabase(): Promise<boolean> {
  if (!config.MONGODB_URI) {
    logger.warn('MONGODB_URI is not set. MongoDB features will be disabled or running in mock mode.');
    return false;
  }

  try {
    mongoose.connection.on('connected', () => {
      isConnected = true;
      logger.info('Connected to MongoDB successfully.');
    });

    mongoose.connection.on('error', (err) => {
      isConnected = false;
      logger.error('MongoDB connection error:', err);
    });

    mongoose.connection.on('disconnected', () => {
      isConnected = false;
      logger.warn('MongoDB disconnected. Attempting reconnection...');
    });

    await mongoose.connect(config.MONGODB_URI, {
      serverSelectionTimeoutMS: 5000,
    });

    isConnected = true;
    return true;
  } catch (error) {
    logger.error('Initial MongoDB connection failed:', error);
    return false;
  }
}

export function isDbConnected(): boolean {
  return isConnected && mongoose.connection.readyState === 1;
}

export async function disconnectDatabase(): Promise<void> {
  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
    logger.info('MongoDB connection closed.');
  }
}
