// server/middleware.js
const db = require('./db');
const auth = require('./auth');
const { getPermissions } = require('./rbac');

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
function applyExpiry(user) {
  if (!user) return user;
  if ((user.status === 'muted' || user.status === 'suspended') && user.expires_at) {
    if (new Date(user.expires_at).getTime() <= Date.now()) {
      try {
        db.prepare(`UPDATE users SET status = 'active', expires_at = NULL, status_note = NULL WHERE id = ?`).run(user.id);
      } catch {}
      user.status = 'active';
      user.expires_at = null;
    }
  }
  return user;
}

// Attach req.user when a valid token/session is present (does not reject).
function attachUser(req, res, next) {
  try {
    let accessPayload = null;
    const cookieToken = req.cookies && req.cookies.fs_access;
    const bearer = req.headers.authorization && req.headers.authorization.startsWith('Bearer ')
      ? req.headers.authorization.slice(7)
      : null;

    if (cookieToken) accessPayload = auth.verifyAccessToken(cookieToken);
    if (!accessPayload && bearer) accessPayload = auth.verifyAccessToken(bearer);

    if (accessPayload) {
      const user = db.prepare(`SELECT id, email, username, status, email_verified, expires_at FROM users WHERE id = ?`).get(accessPayload.sub);
      if (user && user.status !== 'banned') {
        req.user = applyExpiry(user);
        return next();
      }
    }

    // Attempt refresh via httpOnly cookie.
    const refresh = req.cookies && req.cookies.fs_refresh;
    if (refresh) {
      const refreshed = auth.getSessionByToken(refresh);
      if (refreshed && refreshed.status !== 'banned') {
        req.user = applyExpiry(refreshed);
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
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });
    const perms = getPermissions(req.user.id);
    if (!perms.has(permission)) {
      return res.status(403).json({ error: 'Insufficient permissions', permission });
    }
    next();
  };
}

// Convenience: load full user + permissions onto req for handlers that need it.
function withPermissions(req, res, next) {
  if (req.user) req.permissions = getPermissions(req.user.id);
  next();
}

const config = require('./config');

module.exports = { parseCookies, attachUser, requireAuth, requirePermission, withPermissions, COOKIE_OPTS };
