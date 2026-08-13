// server/auth.js
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('./db');
const config = require('./config');

function hashPassword(plain) {
  return bcrypt.hashSync(plain, config.bcryptRounds);
}
function verifyPassword(plain, hash) {
  return bcrypt.compareSync(plain, hash);
}

function generateAccessToken(user) {
  // user: { id, email, username }
  return jwt.sign(
    { sub: user.id, email: user.email, username: user.username },
    config.jwtSecret,
    { expiresIn: config.jwtAccessTtl }
  );
}

function verifyAccessToken(token) {
  try {
    return jwt.verify(token, config.jwtSecret);
  } catch {
    return null;
  }
}

// ---- Refresh sessions (server-side, revocable) ----
function createSession(userId, { ip, userAgent } = {}) {
  const plain = crypto.randomBytes(40).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(plain).digest('hex');
  const expiresAt = new Date(Date.now() + config.jwtRefreshTtlDays * 864e5).toISOString();
  db.prepare(
    `INSERT INTO sessions (user_id, token_hash, ip, user_agent, expires_at) VALUES (?, ?, ?, ?, ?)`
  ).run(userId, tokenHash, ip || null, userAgent || null, expiresAt);
  return plain;
}

function getSessionByToken(plain) {
  const tokenHash = crypto.createHash('sha256').update(plain).digest('hex');
  const row = db.prepare(`SELECT * FROM sessions WHERE token_hash = ? AND expires_at > datetime('now')`).get(tokenHash);
  if (!row) return null;
  return db.prepare(`SELECT id, email, username, status, email_verified, expires_at FROM users WHERE id = ?`).get(row.user_id);
}

function revokeSession(plain) {
  const tokenHash = crypto.createHash('sha256').update(plain).digest('hex');
  db.prepare(`DELETE FROM sessions WHERE token_hash = ?`).run(tokenHash);
}

// ---- One-time auth tokens (email verify / password reset) ----
function createAuthToken(userId, purpose, ttlMinutes = 60) {
  const plain = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(plain).digest('hex');
  const expiresAt = new Date(Date.now() + ttlMinutes * 6e4).toISOString();
  db.prepare(`DELETE FROM auth_tokens WHERE user_id = ? AND purpose = ?`).run(userId, purpose);
  db.prepare(`INSERT INTO auth_tokens (user_id, purpose, token_hash, expires_at) VALUES (?, ?, ?, ?)`).run(
    userId, purpose, tokenHash, expiresAt
  );
  return plain;
}

function consumeAuthToken(plain, purpose) {
  const tokenHash = crypto.createHash('sha256').update(plain).digest('hex');
  const row = db.prepare(`SELECT * FROM auth_tokens WHERE token_hash = ? AND purpose = ? AND expires_at > datetime('now')`).get(tokenHash, purpose);
  if (!row) return null;
  db.prepare(`DELETE FROM auth_tokens WHERE id = ?`).run(row.id);
  return row.user_id;
}

module.exports = {
  hashPassword,
  verifyPassword,
  generateAccessToken,
  verifyAccessToken,
  createSession,
  getSessionByToken,
  revokeSession,
  createAuthToken,
  consumeAuthToken,
};
