// server/middleware.js
const db = require('./db');
const auth = require('./auth');
const { getPermissions } = require('./rbac');
const config = require('./config');

// Minimal cookie parser (no extra dependency).
function parseCookies(req, res, next) {
  const header = req.headers.cookie;
  req.cookies = {};
  if (header) {
    header.split(';').forEach((part) => {
      const idx = part.indexOf('=');
      if (idx === -1) return;
      const k = part.slice(0, idx).trim();
      const v = part.slice(idx + 1).trim();
      if (k) req.cookies[k] = decodeURIComponent(v);
    });
  }
  next();
}

function COOKIE_OPTS(secure) {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: !!secure,
    path: '/',
  };
}

// Revert a timed mute/suspension once its expiry has passed.
async function applyExpiry(user) {
  if (!user) return user;
  if ((user.status === 'muted' || user.status === 'suspended') && user.expires_at) {
    if (new Date(user.expires_at).getTime() <= Date.now()) {
      try {
        await db.prepare(`UPDATE users SET status = 'active', expires_at = NULL, status_note = NULL WHERE id = ?`).run(user.id);
      } catch {}
      user.status = 'active';
      user.expires_at = null;
    }
  }
  return user;
}

// Attach req.user when a valid token/session is present (does not reject).
async function attachUser(req, res, next) {
  try {
    let accessPayload = null;
    const cookieToken = req.cookies && req.cookies.fs_access;
    const bearer = req.headers.authorization && req.headers.authorization.startsWith('Bearer ')
      ? req.headers.authorization.slice(7)
      : null;

    if (cookieToken) accessPayload = auth.verifyAccessToken ? auth.verifyAccessToken(cookieToken) : null;
    if (!accessPayload && bearer) accessPayload = auth.verifyAccessToken(bearer);

    if (accessPayload) {
      const user = await db.prepare(`SELECT id, email, username, status, email_verified, expires_at FROM users WHERE id = ?`).get(accessPayload.sub);
      if (user && user.status !== 'banned') {
        req.user = await applyExpiry(user);
        return next();
      }
    }

    // Attempt refresh via httpOnly cookie.
    const refresh = req.cookies && req.cookies.fs_refresh;
    if (refresh) {
      const refreshed = await auth.getSessionByToken(refresh);
      if (refreshed && refreshed.status !== 'banned') {
        req.user = await applyExpiry(refreshed);
        const access = auth.generateAccessToken(refreshed);
        res.cookie('fs_access', access, COOKIE_OPTS(req.secure || config.cookieSecure));
        return next();
      }
    }
    next();
  } catch (e) {
    next();
  }
}

// Require an authenticated, non-banned user.
function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Authentication required' });
  if (req.user.status === 'suspended') return res.status(403).json({ error: 'Account suspended' });
  next();
}

// Require a specific permission (RBAC, not role name).
function requirePermission(permission) {
  return async (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });
    try {
      const perms = await getPermissions(req.user.id);
      if (!perms.has(permission)) {
        return res.status(403).json({ error: 'Insufficient permissions', permission });
      }
      next();
    } catch (e) {
      next(e);
    }
  };
}

// Convenience: load full user + permissions onto req for handlers that need it.
async function withPermissions(req, res, next) {
  if (req.user) req.permissions = await getPermissions(req.user.id);
  next();
}

module.exports = { parseCookies, attachUser, requireAuth, requirePermission, withPermissions, COOKIE_OPTS };
