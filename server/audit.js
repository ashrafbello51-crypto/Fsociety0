// server/audit.js
// Thin wrapper around the audit_logs table. Never logs secrets.
const db = require('./db');

// actorId: user id performing the action (may be null for system actions)
// action:  e.g. USER_WARNED, USER_MUTED, USER_SUSPENDED, USER_BANNED,
//          MESSAGE_DELETED, REPORT_RESOLVED, REPORT_DISMISSED, ROLE_CHANGED, PERMISSION_CHANGED
// entityType / entityId: the affected object (user, message, report, ...)
// metadata: plain object (no passwords/tokens)
async function audit({ actorId, action, entityType = null, entityId = null, metadata = null, ip = null }) {
  let meta = null;
  if (metadata != null) {
    try { meta = JSON.stringify(metadata); } catch { meta = null; }
  }
  try {
    await db.prepare(
      `INSERT INTO audit_logs (actor_id, action, entity_type, entity_id, metadata, ip) VALUES (?, ?, ?, ?, ?, ?)`
    ).run(actorId ?? null, action, entityType, entityId, meta, ip);
  } catch (e) {
    // Logging must never break the primary operation.
    if (config_env().env !== 'production') console.error('[audit] failed:', e.message);
  }
}

// Lazy require to avoid a require cycle warning at module load.
function config_env() {
  try { return require('./config'); } catch { return { env: 'development' }; }
}

module.exports = { audit };
