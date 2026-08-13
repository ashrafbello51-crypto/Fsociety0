// server/routes/auth.js
const express = require('express');
const router = express.Router();
const z = require('zod');
const db = require('../db');
const auth = require('../auth');
const config = require('../config');
const { COOKIE_OPTS } = require('../middleware');

const RESERVED_USERNAMES = new Set([
  'admin', 'root', 'system', 'f_society', 'fsociety', 'moderator', 'support',
  'official', 'security', 'api', 'www', 'mail', 'administrator', 'superadmin',
]);

function setAuthCookies(res, user) {
  const access = auth.generateAccessToken(user);
  const refresh = auth.createSession(user.id, {
    ip: res.locals && res.locals.ip,
    userAgent: res.locals && res.locals.ua,
  });
  res.cookie('fs_access', access, { ...COOKIE_OPTS(config.cookieSecure), maxAge: 15 * 60 * 1000 });
  res.cookie('fs_refresh', refresh, { ...COOKIE_OPTS(config.cookieSecure), maxAge: config.jwtRefreshTtlDays * 864e5 });
}

const registerSchema = z.object({
  email: z.string().email().max(254),
  username: z.string().regex(/^[a-zA-Z0-9_]{3,20}$/, '3-20 chars: letters, numbers, underscore'),
  displayName: z.string().min(1).max(50),
  password: z.string().min(8).max(128),
  confirmPassword: z.string(),
  experienceLevel: z.enum(['beginner', 'intermediate', 'advanced', 'elite']).optional(),
  interests: z.array(z.string().max(40)).max(20).optional(),
}).refine((d) => d.password === d.confirmPassword, { message: 'Passwords do not match', path: ['confirmPassword'] });

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const resetRequestSchema = z.object({ email: z.string().email() });
const resetSchema = z.object({
  token: z.string().min(10),
  password: z.string().min(8).max(128),
  confirmPassword: z.string(),
}).refine((d) => d.password === d.confirmPassword, { message: 'Passwords do not match' });

router.post('/register', (req, res) => {
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });
  const { email, username, displayName, password, experienceLevel, interests } = parsed.data;

  if (RESERVED_USERNAMES.has(username.toLowerCase())) {
    return res.status(400).json({ error: 'That username is reserved' });
  }
  const existing = db.prepare(`SELECT id FROM users WHERE email = ? OR username = ?`).get(email.toLowerCase(), username);
  if (existing) return res.status(409).json({ error: 'Email or username already registered' });

  const hash = auth.hashPassword(password);
  db.exec('BEGIN');
  let info;
  try {
    const r = db.prepare(
      `INSERT INTO users (email, username, password_hash, display_name, email_verified) VALUES (?, ?, ?, ?, 0)`
    ).run(email.toLowerCase(), username, hash, displayName);
    const userId = r.lastInsertRowid;
    db.prepare(
      `INSERT INTO profiles (user_id, experience_level, interests) VALUES (?, ?, ?)`
    ).run(userId, experienceLevel || null, JSON.stringify(interests || []));
    const memberRole = db.prepare(`SELECT id FROM roles WHERE name = 'MEMBER'`).get();
    if (memberRole) db.prepare(`INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)`).run(userId, memberRole.id);
    db.prepare(`INSERT INTO presence (user_id, state) VALUES (?, 'offline')`).run(userId);
    info = userId;
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch {}
    throw e;
  }

  const user = db.prepare(`SELECT id, email, username, status, email_verified FROM users WHERE id = ?`).get(info);
  setAuthCookies(res, user);

  let verifyToken = null;
  if (config.devBypassEmail) {
    verifyToken = auth.createAuthToken(user.id, 'email_verify', 1440);
  } else {
    auth.createAuthToken(user.id, 'email_verify', 1440);
    // Production: send email here.
  }

  res.status(201).json({
    user: { id: user.id, email: user.email, username: user.username, emailVerified: false },
    devVerifyToken: config.devBypassEmail ? verifyToken : undefined,
  });
});

router.get('/verify-email', (req, res) => {
  const token = req.query.token;
  if (!token) return res.status(400).json({ error: 'Missing token' });
  const userId = auth.consumeAuthToken(token, 'email_verify');
  if (!userId) return res.status(400).json({ error: 'Invalid or expired token' });
  db.prepare(`UPDATE users SET email_verified = 1, updated_at = datetime('now') WHERE id = ?`).run(userId);
  res.json({ ok: true });
});

router.post('/login', (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Validation failed' });
  const { email, password } = parsed.data;
  const user = db.prepare(`SELECT * FROM users WHERE email = ?`).get(email.toLowerCase());
  if (!user || !auth.verifyPassword(password, user.password_hash)) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  if (user.status === 'banned') return res.status(403).json({ error: 'Account banned' });
  if (user.status === 'suspended') return res.status(403).json({ error: 'Account suspended' });
  const safe = { id: user.id, email: user.email, username: user.username, status: user.status, email_verified: user.email_verified };
  setAuthCookies(res, safe);
  res.json({ user: safe });
});

router.post('/logout', (req, res) => {
  const refresh = req.cookies && req.cookies.fs_refresh;
  if (refresh) auth.revokeSession(refresh);
  res.clearCookie('fs_access');
  res.clearCookie('fs_refresh');
  res.json({ ok: true });
});

router.post('/forgot-password', (req, res) => {
  const parsed = resetRequestSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid email' });
  const user = db.prepare(`SELECT id FROM users WHERE email = ?`).get(parsed.data.email.toLowerCase());
  // Always return 200 to avoid user enumeration.
  if (user) {
    if (config.devBypassEmail) {
      const t = auth.createAuthToken(user.id, 'password_reset', 60);
      return res.json({ ok: true, devResetToken: t });
    }
    auth.createAuthToken(user.id, 'password_reset', 60);
    // Production: send email.
  }
  res.json({ ok: true });
});

router.post('/reset-password', (req, res) => {
  const parsed = resetSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Validation failed' });
  const userId = auth.consumeAuthToken(parsed.data.token, 'password_reset');
  if (!userId) return res.status(400).json({ error: 'Invalid or expired token' });
  const hash = auth.hashPassword(parsed.data.password);
  db.prepare(`UPDATE users SET password_hash = ?, updated_at = datetime('now') WHERE id = ?`).run(hash, userId);
  db.prepare(`DELETE FROM sessions WHERE user_id = ?`).run(userId); // revoke all sessions
  res.json({ ok: true });
});

router.get('/me', (req, res) => {
  const uid = req.user && req.user.id;
  if (!uid) return res.status(401).json({ error: 'Authentication required' });
  const user = db.prepare(`SELECT id, email, username, status, email_verified, created_at FROM users WHERE id = ?`).get(uid);
  const profile = db.prepare(`SELECT bio, avatar_storage_key, experience_level, interests, skills, xp FROM profiles WHERE user_id = ?`).get(uid);
  const roles = db.prepare(`SELECT r.name, r.display_name FROM roles r JOIN user_roles ur ON ur.role_id = r.id WHERE ur.user_id = ?`).all(uid).map((r) => r.name);
  const permissions = require('../rbac').getPermissions(uid);
  res.json({
    user,
    profile: profile || {},
    roles,
    permissions: Array.from(permissions),
  });
});

module.exports = router;
