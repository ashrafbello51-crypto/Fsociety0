// server/config.js
require('dotenv').config();

const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  host: process.env.HOST || '0.0.0.0',
  env: process.env.NODE_ENV || 'development',
  databaseUrl: process.env.DATABASE_URL || null,
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
  devBypassEmail: process.env.DEV_BYPASS_EMAIL ? process.env.DEV_BYPASS_EMAIL === 'true' : false,
  cookieSecure: (process.env.COOKIE_SECURE || 'false') === 'true',
  bcryptRounds: parseInt(process.env.BCRYPT_ROUNDS || '12', 10),
};

const DEFAULT_JWT = 'dev-insecure-change-me';
if (config.env === 'production') {
  const problems = [];
  if (!config.databaseUrl) problems.push('DATABASE_URL is not set');
  if (config.jwtSecret === DEFAULT_JWT) problems.push('JWT_SECRET is the default insecure value');
  if (config.devBypassEmail) problems.push('DEV_BYPASS_EMAIL must not be enabled in production');
  if (problems.length) {
    throw new Error('[SECURITY] Refusing to start in production: ' + problems.join('; '));
  }
} else if (config.jwtSecret === DEFAULT_JWT) {
  console.warn('[SECURITY] JWT_SECRET is using the default insecure value. Set it via env.');
}

module.exports = config;
