// server/routes/moderation.js
// Reporting, moderation queue, user-moderation actions, and audit logs.
// Authorization is entirely server-side via RBAC permissions.
const express = require('express');
const z = require('zod');
const rateLimit = require('express-rate-limit');
const db = require('../db');
const { requireAuth, requirePermission } = require('../middleware');
const { userHasPermission } = require('../rbac');
const { audit } = require('../audit');
const notify = require('../notify');

const router = express.Router();

const REPORT_LIMITER = rateLimit({
  windowMs: 60 * 1000, max: 15, standardHeaders: true, legacyHeaders: false,
  keyGenerator: (req) => String(req.user ? req.user.id : req.ip),
  message: { error: 'Too many reports, slow down' },
});
const ACTION_LIMITER = rateLimit({
  windowMs: 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false,
  keyGenerator: (req) => String(req.user ? req.user.id : req.ip),
  message: { error: 'Too many actions, slow down' },
});

const REPORT_REASONS = ['SPAM', 'HARASSMENT', 'INAPPROPRIATE_CONTENT', 'SCAM', 'ABUSE', 'OTHER'];
const VALID_STATUSES = ['open', 'reviewing', 'resolved', 'dismissed'];
const REPORTABLE = ['message', 'user', 'community', 'channel'];

function validTarget(type, id) {
  if (type === 'message') return db.prepare(`SELECT 1 FROM messages WHERE id = ?`).get(id);
  if (type === 'user') return db.prepare(`SELECT 1 FROM users WHERE id = ?`).get(id);
  if (type === 'community') return db.prepare(`SELECT 1 FROM communities WHERE id = ?`).get(id);
  if (type === 'channel') return db.prepare(`SELECT 1 FROM channels WHERE id = ?`).get(id);
  return null;
}

function userSummary(id) {
  if (!id) return null;
  const u = db.prepare(`SELECT id, username, display_name FROM users WHERE id = ?`).get(id);
  return u ? { id: u.id, username: u.username, displayName: u.display_name } : null;
}

function targetSummary(type, id) {
  if (type === 'message') {
    const m = db.prepare(
       `SELECT m.id, m.body, m.author_id, u.username AS author, c.id AS channelId, c.name AS channelName, cm.id AS communityId
       FROM messages m JOIN users u ON u.id = m.author_id
       JOIN channels c ON c.id = m.channel_id JOIN communities cm ON cm.id = c.community_id
       WHERE m.id = ?`
    ).get(id);
    if (!m) return { type, id, missing: true };
    return { type, id, preview: (m.body || '').slice(0, 200), authorId: m.author_id, authorName: m.author, channelId: m.channelId, channelName: m.channelName, communityId: m.communityId };
  }
  if (type === 'user') {
    const u = db.prepare(`SELECT id, username, display_name FROM users WHERE id = ?`).get(id);
    return u ? { type, id, username: u.username, displayName: u.display_name } : { type, id, missing: true };
  }
  if (type === 'community') {
    const c = db.prepare(`SELECT id, name FROM communities WHERE id = ?`).get(id);
    return c ? { type, id, name: c.name } : { type, id, missing: true };
  }
  if (type === 'channel') {
    const ch = db.prepare(
      `SELECT ch.id, ch.name, cm.id AS communityId, cm.name AS communityName FROM channels ch JOIN communities cm ON cm.id = ch.community_id WHERE ch.id = ?`
    ).get(id);
    return ch ? { type, id, name: ch.name, communityId: ch.communityId, communityName: ch.communityName } : { type, id, missing: true };
  }
  return { type, id };
}

function serializeReport(row) {
  return {
    id: row.id,
    targetType: row.target_type,
    targetId: row.target_id,
    reason: row.reason,
    description: row.description,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    resolvedAt: row.resolved_at,
    reporter: userSummary(row.reporter_id),
    assigned: userSummary(row.assigned_to),
    resolvedBy: userSummary(row.resolved_by),
    target: targetSummary(row.target_type, row.target_id),
  };
}

// ---- Create a report ----
const reportSchema = z.object({
  targetType: z.enum(REPORTABLE),
  targetId: z.number().int().positive(),
  reason: z.enum(REPORT_REASONS),
  description: z.string().max(2000).optional().default(''),
});

router.post('/reports', requireAuth, REPORT_LIMITER, (req, res) => {
  const parsed = reportSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });
  const { targetType, targetId, reason, description } = parsed.data;

  if (!validTarget(targetType, targetId)) return res.status(404).json({ error: 'Report target not found' });
  if (targetType === 'user' && targetId === req.user.id) return res.status(400).json({ error: 'You cannot report yourself' });

  // Prevent duplicate *active* reports from the same user for the same target.
  const dup = db.prepare(
    `SELECT id FROM reports WHERE reporter_id = ? AND target_type = ? AND target_id = ? AND status IN ('open','reviewing')`
  ).get(req.user.id, targetType, targetId);
  if (dup) return res.status(409).json({ error: 'You have already reported this item', reportId: dup.id });

  const r = db.prepare(
    `INSERT INTO reports (reporter_id, target_type, target_id, reason, description, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'open', datetime('now'), datetime('now'))`
  ).run(req.user.id, targetType, targetId, reason, description);

  res.status(201).json({ id: r.lastInsertRowid, status: 'open' });
});

// ---- List the moderation queue ----
router.get('/reports', requireAuth, requirePermission('VIEW_REPORTS'), (req, res) => {
  const status = req.query.status;
  const params = [];
  let where = '';
  if (status && VALID_STATUSES.includes(status)) { where = 'WHERE r.status = ?'; params.push(status); }
  const rows = db.prepare(
    `SELECT r.* FROM reports r ${where} ORDER BY
       CASE r.status WHEN 'open' THEN 0 WHEN 'reviewing' THEN 1 ELSE 2 END, r.created_at DESC LIMIT 200`
  ).all(...params);
  res.json({ reports: rows.map(serializeReport) });
});

router.get('/reports/:id', requireAuth, requirePermission('VIEW_REPORTS'), (req, res) => {
  const id = parseInt(req.params.id, 10);
  const row = db.prepare(`SELECT * FROM reports WHERE id = ?`).get(id);
  if (!row) return res.status(404).json({ error: 'Report not found' });
  res.json(serializeReport(row));
});

// ---- Claim / assign to self (sets to reviewing) ----
router.post('/reports/:id/claim', requireAuth, requirePermission('VIEW_REPORTS'), (req, res) => {
  const id = parseInt(req.params.id, 10);
  const row = db.prepare(`SELECT * FROM reports WHERE id = ?`).get(id);
  if (!row) return res.status(404).json({ error: 'Report not found' });
  db.prepare(`UPDATE reports SET assigned_to = ?, status = 'reviewing', updated_at = datetime('now') WHERE id = ?`).run(req.user.id, id);
  res.json({ ok: true });
});

// ---- Resolve / dismiss (privileged) ----
function closeReport(req, res, resolution) {
  const id = parseInt(req.params.id, 10);
  const row = db.prepare(`SELECT * FROM reports WHERE id = ?`).get(id);
  if (!row) return res.status(404).json({ error: 'Report not found' });

  db.prepare(
    `UPDATE reports SET status = ?, resolved_by = ?, resolved_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`
  ).run(resolution, req.user.id, id);

  const action = resolution === 'resolved' ? 'REPORT_RESOLVED' : 'REPORT_DISMISSED';
  const meta = { reportId: id, targetType: row.target_type, targetId: row.target_id };
  // If the report is about a community/channel, record that context in moderation_actions too.
  if (row.target_type === 'community' || row.target_type === 'channel') {
    db.prepare(
      `INSERT INTO moderation_actions (moderator_id, target_user_id, action, reason, target_community_id, target_channel_id)
       VALUES (?, 0, ?, ?, ?, ?)`
    ).run(req.user.id, action, resolution, row.target_type === 'community' ? row.target_id : null, row.target_type === 'channel' ? row.target_id : null);
  }
  audit({ actorId: req.user.id, action, entityType: 'report', entityId: id, metadata: meta, ip: res.locals.ip });
  res.json({ ok: true, status: resolution });
}

router.post('/reports/:id/resolve', requireAuth, requirePermission('RESOLVE_REPORTS'), ACTION_LIMITER, (req, res) => closeReport(req, res, 'resolved'));
router.post('/reports/:id/dismiss', requireAuth, requirePermission('RESOLVE_REPORTS'), ACTION_LIMITER, (req, res) => closeReport(req, res, 'dismissed'));

// ---- User moderation actions ----
const moderateSchema = z.object({
  action: z.enum(['warn', 'mute', 'suspend', 'ban', 'unmute', 'unsuspend', 'unban']),
  reason: z.string().max(1000).optional().default(''),
  durationHours: z.number().int().positive().max(24 * 365).optional(),
});

const ACTION_TO_STATUS = { mute: 'muted', suspend: 'suspended', ban: 'banned', unmute: 'active', unsuspend: 'active', unban: 'active' };
const ACTION_TO_AUDIT = {
  warn: 'USER_WARNED', mute: 'USER_MUTED', suspend: 'USER_SUSPENDED', ban: 'USER_BANNED',
  unmute: 'USER_UNMUTED', unsuspend: 'USER_UNSUSPENDED', unban: 'USER_UNBANNED',
};

router.post('/users/:id/moderate', requireAuth, requirePermission('MANAGE_USERS'), ACTION_LIMITER, (req, res) => {
  const parsed = moderateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });
  const { action, reason, durationHours } = parsed.data;

  const targetId = parseInt(req.params.id, 10);
  if (!Number.isInteger(targetId)) return res.status(400).json({ error: 'Invalid user id' });
  if (targetId === req.user.id) return res.status(400).json({ error: 'You cannot moderate yourself' });

  const target = db.prepare(`SELECT id, username, status FROM users WHERE id = ?`).get(targetId);
  if (!target) return res.status(404).json({ error: 'User not found' });

  // Never allow moderating a privileged account (any user holding MANAGE_USERS).
  if (userHasPermission(targetId, 'MANAGE_USERS')) {
    return res.status(403).json({ error: 'Cannot moderate a privileged account' });
  }

  const newStatus = ACTION_TO_STATUS[action];
  const isRestrictive = action === 'mute' || action === 'suspend' || action === 'ban';
  const expiresAt = (action === 'mute' || action === 'suspend') && durationHours
    ? new Date(Date.now() + durationHours * 3600e3).toISOString()
    : null;

  db.tx((d) => {
    d.prepare(`UPDATE users SET status = ?, expires_at = ?, status_note = ? WHERE id = ?`).run(
      newStatus, expiresAt, isRestrictive ? (reason || '').slice(0, 200) : null, targetId
    );
    d.prepare(
      `INSERT INTO moderation_actions (moderator_id, target_user_id, action, reason, expires_at) VALUES (?, ?, ?, ?, ?)`
    ).run(req.user.id, targetId, action, (reason || '').slice(0, 1000), expiresAt);
    // Force re-authentication for banned/suspended accounts.
    if (isRestrictive) d.prepare(`DELETE FROM sessions WHERE user_id = ?`).run(targetId);
  });

  audit({
    actorId: req.user.id, action: ACTION_TO_AUDIT[action], entityType: 'user', entityId: targetId,
    metadata: { targetUsername: target.username, reason: (reason || '').slice(0, 200), durationHours: expiresAt ? durationHours : null },
    ip: res.locals.ip,
  });

  // Notify the affected user (skip self; already the actor).
  if (isRestrictive || action === 'warn') {
    notify.createNotification(targetId, 'moderation', {
      action, reason: (reason || '').slice(0, 200), by: req.user.username, expiresAt,
    });
  }

  res.json({ ok: true, status: newStatus, action });
});

// ---- Audit log read (privileged) ----
router.get('/audit', requireAuth, requirePermission('VIEW_AUDIT_LOGS'), (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || '100', 10), 500);
  const rows = db.prepare(
    `SELECT a.id, a.actor_id, u.username AS actor, a.action, a.entity_type, a.entity_id, a.metadata, a.ip, a.created_at
     FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_id ORDER BY a.created_at DESC LIMIT ?`
  ).all(limit);
  res.json({ logs: rows.map((r) => ({
    id: r.id, actorId: r.actor_id, actor: r.actor, action: r.action,
    entityType: r.entity_type, entityId: r.entity_id, metadata: r.metadata ? JSON.parse(r.metadata) : null,
    ip: r.ip, createdAt: r.created_at,
  })) });
});

module.exports = router;
