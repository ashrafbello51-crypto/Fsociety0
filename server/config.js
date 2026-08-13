// server/config.js
require('dotenv').config();

const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  host: process.env.HOST || '0.0.0.0',
  env: process.env.NODE_ENV || 'development',
  jwtSecret: process.env.JWT_SECRET || 'dev-insecure-change-me',
  jwtAccessTtl: process.env.JWT_ACCESS_TTL || '15m',
  jwtRefreshTtlDays: parseInt(process.env.JWT_REFRESH_TTL_DAYS || '30', 10),
  dbPath: process.env.DB_PATH || require('path').join(__dirname, '..', 'data', 'f_society.db'),
  uploadsDir: process.env.UPLOADS_DIR || require('path').join(__dirname, '..', 'uploads'),
  maxUploadBytes: parseInt(process.env.MAX_UPLOAD_BYTES || '8388608', 10), // 8MB
  maxImageBytes: parseInt(process.env.MAX_IMAGE_BYTES || '8388608', 10), // 8MB
  maxDocBytes: parseInt(process.env.MAX_DOC_BYTES || '15728640', 10), // 15MB
  // Storage backend: 'local' (development) or 's3' (production object storage).
  storageDriver: (process.env.STORAGE_DRIVER || 'local').toLowerCase(),
  appUrl: process.env.APP_URL || 'http://localhost:3000',
  // In development we surface verification/resets directly instead of emailing.
  devBypassEmail: (process.env.DEV_BYPASS_EMAIL || 'true') === 'true',
  cookieSecure: (process.env.COOKIE_SECURE || 'false') === 'true',
  bcryptRounds: parseInt(process.env.BCRYPT_ROUNDS || '12', 10),
};

if (config.env === 'production' && config.jwtSecret === 'dev-insecure-change-me') {
  // eslint-disable-next-line no-console
  console.warn('[SECURITY] JWT_SECRET is using the default insecure value in production. Set it via env.');
}

module.exports = config;
