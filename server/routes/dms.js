// server/routes/dms.js
// Direct Messages (1:1 conversations). Only permitted between users who share a community.
const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const z = require('zod');
const db = require('../db');
const { requireAuth } = require('../middleware');
const realtime = require('../realtime');
const notify = require('../notify');
const uploads = require('./uploads');

// Per-user rate limit on DM posting (abuse/spam protection).
const DM_LIMITER = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => String(req.user ? req.user.id : req.ip),
  message: { error: 'Too many messages, slow down' },
});

function memberOf(conversationId, userId) {
  return db.prepare(`SELECT 1 FROM conversation_members WHERE conversation_id = ? AND user_id = ?`).get(conversationId, userId);
}

function shareCommunity(a, b) {
  return db.prepare(
    `SELECT 1 FROM community_members cm1 JOIN community_members cm2 ON cm1.community_id = cm2.community_id WHERE cm1.user_id = ? AND cm2.user_id = ? LIMIT 1`
  ).get(a, b);
}

function getPresence(userId) {
  const row = db.prepare(`SELECT state, last_seen FROM presence WHERE user_id = ?`).get(userId);
  return row ? { state: row.state, lastSeen: row.last_seen } : { state: 'offline', lastSeen: null };
}

// Build a conversation object for a given viewer (other participant + last message + unread).
function buildConversation(conversationId, viewerId) {
  const other = db.prepare(
    `SELECT u.id, u.username, u.display_name, p.avatar_storage_key AS avatar
     FROM conversation_members cm
     JOIN users u ON u.id = cm.user_id
     LEFT JOIN profiles p ON p.user_id = u.id
     WHERE cm.conversation_id = ? AND cm.user_id <> ?`
  ).get(conversationId, viewerId);
  if (!other) return null;

  const last = db.prepare(
    `SELECT id, body, author_id, created_at FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT 1`
  ).get(conversationId);

  const unread = db.prepare(
    `SELECT COUNT(*) AS n FROM messages m
     WHERE m.conversation_id = ? AND m.author_id <> ? AND m.deleted = 0
       AND NOT EXISTS (SELECT 1 FROM message_reads mr WHERE mr.message_id = m.id AND mr.user_id = ?)`
  ).get(conversationId, viewerId, viewerId).n;

  const presence = getPresence(other.id);

  return {
    id: conversationId,
    other: {
      id: other.id,
      username: other.username,
      displayName: other.display_name,
      avatar: other.avatar,
      presence,
    },
    lastMessage: last ? { body: last.body, authorId: last.author_id, createdAt: last.created_at } : null,
    unread,
  };
}

// List my conversations.
router.get('/', requireAuth, (req, res) => {
  const rows = db.prepare(
    `SELECT c.id FROM conversations c
     JOIN conversation_members cm ON cm.conversation_id = c.id
     WHERE cm.user_id = ?`
  ).all(req.user.id);

  const list = rows.map((r) => buildConversation(r.id, req.user.id)).filter(Boolean);
  list.sort((a, b) => (b.lastMessage?.createdAt || '').localeCompare(a.lastMessage?.createdAt || ''));
  res.json({ conversations: list });
});

// Start or open a 1:1 conversation with another user.
const startSchema = z.object({ targetUserId: z.number().int().positive() });
router.post('/', requireAuth, (req, res) => {
  const parsed = startSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Validation failed' });
  const targetId = parsed.data.targetUserId;
  if (targetId === req.user.id) return res.status(400).json({ error: 'Cannot start a conversation with yourself' });

  const target = db.prepare(`SELECT id, username, status FROM users WHERE id = ?`).get(targetId);
  if (!target || target.status !== 'active') return res.status(404).json({ error: 'User not available' });
  if (!shareCommunity(req.user.id, targetId)) {
    return res.status(403).json({ error: 'You can only message users who share a community with you' });
  }

  // Reuse an existing 1:1 conversation if present.
  const existing = db.prepare(
    `SELECT c.id FROM conversations c
     JOIN conversation_members cm1 ON cm1.conversation_id = c.id
     JOIN conversation_members cm2 ON cm2.conversation_id = c.id
     WHERE cm1.user_id = ? AND cm2.user_id = ? AND (SELECT COUNT(*) FROM conversation_members cm WHERE cm.conversation_id = c.id) = 2`
  ).get(req.user.id, targetId);

  let conversationId;
  if (existing) {
    conversationId = existing.id;
  } else {
    const r = db.prepare(`INSERT INTO conversations DEFAULT VALUES`).run();
    conversationId = r.lastInsertRowid;
    db.prepare(`INSERT OR IGNORE INTO conversation_members (conversation_id, user_id) VALUES (?, ?)`).run(conversationId, req.user.id);
    db.prepare(`INSERT OR IGNORE INTO conversation_members (conversation_id, user_id) VALUES (?, ?)`).run(conversationId, targetId);
  }

  const conv = buildConversation(conversationId, req.user.id);
  res.status(201).json({ conversation: conv });
});

function serializeDM(row) {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    channelId: null,
    authorId: row.author_id,
    authorName: row.author_name,
    authorAvatar: row.author_avatar,
    body: row.body,
    attachment: row.att_id
      ? {
          id: row.att_id,
          storageKey: row.att_key,
          url: `/api/uploads/${row.att_id}`,
          originalFilename: row.att_name,
          mimeType: row.att_mime,
          size: row.att_size,
          width: row.att_width,
          height: row.att_height,
        }
      : null,
    edited: !!row.edited,
    deleted: !!row.deleted,
    createdAt: row.created_at,
    reactions: row.reactions ? JSON.parse(row.reactions) : {},
    readByMe: !!row.read_by_me,
  };
}

// List messages in a conversation (newest first, capped + paginated).
router.get('/:id/messages', requireAuth, (req, res) => {
  const conversationId = parseInt(req.params.id, 10);
  if (!memberOf(conversationId, req.user.id)) return res.status(403).json({ error: 'Forbidden' });

  const limit = Math.min(parseInt(req.query.limit || '50', 10), 100);
  const before = req.query.before ? parseInt(req.query.before, 10) : null;

  let rows = db.prepare(
    `SELECT m.id, m.conversation_id, m.author_id, m.body, m.edited, m.deleted, m.created_at,
            u.username AS author_name, p.avatar_storage_key AS author_avatar,
            att.id AS att_id, so.storage_key AS att_key, so.original_filename AS att_name,
            so.mime AS att_mime, so.size AS att_size, so.width AS att_width, so.height AS att_height,
            (SELECT COUNT(*) FROM message_reads mr WHERE mr.message_id = m.id AND mr.user_id = ?) AS read_by_me
     FROM messages m
     JOIN users u ON u.id = m.author_id
     LEFT JOIN profiles p ON p.user_id = u.id
     LEFT JOIN attachments att ON att.message_id = m.id
     LEFT JOIN storage_objects so ON so.storage_key = att.storage_key
     WHERE m.conversation_id = ? ${before ? 'AND m.id < ?' : ''}
     ORDER BY m.id DESC LIMIT ?`
  ).all(req.user.id, conversationId, ...(before ? [before] : []), limit);

  const ids = rows.map((r) => r.id);
  let reactionMap = {};
  if (ids.length) {
    const placeholders = ids.map(() => '?').join(',');
    const reacts = db.prepare(
      `SELECT message_id, emoji, COUNT(*) AS count, SUM(user_id = ?) AS mine
       FROM message_reactions WHERE message_id IN (${placeholders}) GROUP BY message_id, emoji`
    ).all(req.user.id, ...ids);
    reacts.forEach((r) => {
      reactionMap[r.message_id] = reactionMap[r.message_id] || {};
      reactionMap[r.message_id][r.emoji] = { count: r.count, mine: !!r.mine };
    });
  }
  rows = rows.map((r) => ({ ...r, reactions: JSON.stringify(reactionMap[r.id] || {}) }));

  res.json({ messages: rows.map(serializeDM).reverse() });
});

const messageSchema = z.object({
  body: z.string().max(4000).optional().default(''),
  attachmentId: z.number().int().positive().optional(),
}).refine((d) => (d.body && d.body.trim().length > 0) || d.attachmentId, {
  message: 'Message must contain text or an attachment',
});

// Send a message in a conversation.
router.post('/:id/messages', requireAuth, DM_LIMITER, (req, res) => {
  const conversationId = parseInt(req.params.id, 10);
  if (!memberOf(conversationId, req.user.id)) return res.status(403).json({ error: 'Forbidden' });
  if (req.user.status === 'muted') return res.status(403).json({ error: 'Your account is muted' });
  const parsed = messageSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Validation failed' });

  // Resolve and claim the uploaded object (prevents IDOR / reuse).
  let storageRow = null;
  if (parsed.data.attachmentId) {
    storageRow = db.prepare(`SELECT * FROM storage_objects WHERE id = ? AND owner_id = ?`).get(parsed.data.attachmentId, req.user.id);
    if (!storageRow) return res.status(400).json({ error: 'Invalid attachment' });
    const used = db.prepare(`SELECT 1 FROM attachments WHERE storage_key = ?`).get(storageRow.storage_key);
    if (used) return res.status(409).json({ error: 'Attachment already used' });
  }

  let messageId;
  try {
    messageId = db.tx((d) => {
      const r = d.prepare(`INSERT INTO messages (conversation_id, author_id, body) VALUES (?, ?, ?)`).run(
        conversationId, req.user.id, parsed.data.body || ''
      );
      const mid = r.lastInsertRowid;
      d.prepare(`INSERT OR IGNORE INTO message_reads (message_id, user_id) VALUES (?, ?)`).run(mid, req.user.id);
      if (storageRow) {
        d.prepare(`INSERT INTO attachments (message_id, storage_key, owner_id) VALUES (?, ?, ?)`).run(mid, storageRow.storage_key, req.user.id);
      }
      return mid;
    });
  } catch (e) {
    if (storageRow) uploads.discardStorageObject(storageRow.storage_key).catch(() => {});
    throw e;
  }

  const row = db.prepare(
    `SELECT m.id, m.conversation_id, m.author_id, m.body, m.edited, m.deleted, m.created_at,
            u.username AS author_name, p.avatar_storage_key AS author_avatar,
            att.id AS att_id, so.storage_key AS att_key, so.original_filename AS att_name,
            so.mime AS att_mime, so.size AS att_size, so.width AS att_width, so.height AS att_height
     FROM messages m JOIN users u ON u.id = m.author_id LEFT JOIN profiles p ON p.user_id = u.id
     LEFT JOIN attachments att ON att.message_id = m.id
     LEFT JOIN storage_objects so ON so.storage_key = att.storage_key
     WHERE m.id = ?`
  ).get(messageId);

  const msg = serializeDM(row);
  msg.reactions = {};
  msg.readByMe = true;

  realtime.publishConversation(conversationId, { type: 'dm:new', conversationId, message: msg });

  // Notify the other participant only if they aren't actively viewing this conversation.
  const other = db.prepare(`SELECT user_id FROM conversation_members WHERE conversation_id = ? AND user_id <> ?`).get(conversationId, req.user.id);
  if (other && !realtime.userInConversation(conversationId, other.user_id)) {
    notify.createNotification(other.user_id, 'dm', {
      conversationId,
      from: req.user.id,
      fromName: req.user.username,
      preview: (parsed.data.body && parsed.data.body.trim()) ? parsed.data.body.slice(0, 140) : '📎 Attachment',
    });
  }

  res.status(201).json({ message: msg });
});

// Mark all messages in a conversation as read by the current user.
router.post('/:id/read', requireAuth, (req, res) => {
  const conversationId = parseInt(req.params.id, 10);
  if (!memberOf(conversationId, req.user.id)) return res.status(403).json({ error: 'Forbidden' });

  db.prepare(
    `INSERT OR IGNORE INTO message_reads (message_id, user_id)
     SELECT m.id, ? FROM messages m
     WHERE m.conversation_id = ? AND m.author_id <> ? AND m.deleted = 0
       AND NOT EXISTS (SELECT 1 FROM message_reads mr WHERE mr.message_id = m.id AND mr.user_id = ?)`
  ).run(req.user.id, conversationId, req.user.id, req.user.id);

  // Let the other participant know their messages were read.
  const other = db.prepare(`SELECT user_id FROM conversation_members WHERE conversation_id = ? AND user_id <> ?`).get(conversationId, req.user.id);
  if (other) realtime.publishUser(other.user_id, { type: 'dm:read', conversationId, by: req.user.id });

  res.json({ ok: true });
});

module.exports = router;
