// server/routes/channels.js
const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const z = require('zod');
const db = require('../db');
const { requireAuth } = require('../middleware');
const { isMember } = require('./communities');
const realtime = require('../realtime');
const uploads = require('./uploads');

// Per-user rate limit on message posting (abuse/spam protection).
const MESSAGE_LIMITER = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => String(req.user ? req.user.id : req.ip),
  message: { error: 'Too many messages, slow down' },
});

async function channelCommunity(channelId) {
  return db.prepare(`SELECT community_id FROM channels WHERE id = ?`).get(channelId);
}

function serializeMessage(row) {
  const attachment = row.att_id
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
    : null;
  return {
    id: row.id,
    channelId: row.channel_id,
    conversationId: row.conversation_id,
    authorId: row.author_id,
    authorName: row.author_name,
    authorAvatar: row.author_avatar,
    body: row.body,
    attachment,
    edited: !!row.edited,
    deleted: !!row.deleted,
    createdAt: row.created_at,
    reactions: row.reactions ? JSON.parse(row.reactions) : {},
    readByMe: !!row.read_by_me,
  };
}

const ATTACH_JOIN = `
  LEFT JOIN attachments att ON att.message_id = m.id
  LEFT JOIN storage_objects so ON so.storage_key = att.storage_key`;

// List messages with pagination (newest first, capped).
router.get('/:channelId/messages', requireAuth, async (req, res) => {
  const channelId = parseInt(req.params.channelId, 10);
  const ch = await channelCommunity(channelId);
  if (!ch) return res.status(404).json({ error: 'Channel not found' });
  if (!(await isMember(ch.community_id, req.user.id))) return res.status(403).json({ error: 'Forbidden' });

  const limit = Math.min(parseInt(req.query.limit || '50', 10), 100);
  const before = req.query.before ? parseInt(req.query.before, 10) : null;

  let rows = await db
    .prepare(
      `SELECT m.id, m.channel_id, m.conversation_id, m.author_id, m.body,
              m.edited, m.deleted, m.created_at,
              u.username AS author_name, p.avatar_storage_key AS author_avatar,
              att.id AS att_id, so.storage_key AS att_key, so.original_filename AS att_name,
              so.mime AS att_mime, so.size AS att_size, so.width AS att_width, so.height AS att_height,
              (SELECT COUNT(*) FROM message_reads mr WHERE mr.message_id = m.id AND mr.user_id = ?) AS read_by_me
       FROM messages m
       JOIN users u ON u.id = m.author_id
       LEFT JOIN profiles p ON p.user_id = u.id
       ${ATTACH_JOIN}
       WHERE m.channel_id = ? ${before ? 'AND m.id < ?' : ''}
       ORDER BY m.id DESC LIMIT ?`
    )
    .all(req.user.id, channelId, ...(before ? [before] : []), limit);

  const ids = rows.map((r) => r.id);
  let reactionMap = {};
  if (ids.length) {
    const placeholders = ids.map(() => '?').join(',');
    const reacts = await db
      .prepare(`SELECT message_id, emoji, COUNT(*) AS count, SUM((user_id = ?)::int) AS mine FROM message_reactions WHERE message_id IN (${placeholders}) GROUP BY message_id, emoji`)
      .all(req.user.id, ...ids);
    reacts.forEach((r) => {
      reactionMap[r.message_id] = reactionMap[r.message_id] || {};
      reactionMap[r.message_id][r.emoji] = { count: r.count, mine: !!r.mine };
    });
  }
  rows = rows.map((r) => ({ ...r, reactions: JSON.stringify(reactionMap[r.id] || {}) }));

  res.json({ messages: rows.map(serializeMessage).reverse() });
});

const messageSchema = z.object({
  body: z.string().max(4000).optional().default(''),
  attachmentId: z.number().int().positive().optional(),
}).refine((d) => (d.body && d.body.trim().length > 0) || d.attachmentId, {
  message: 'Message must contain text or an attachment',
});

router.post('/:channelId/messages', requireAuth, MESSAGE_LIMITER, async (req, res) => {
  const channelId = parseInt(req.params.channelId, 10);
  const ch = await channelCommunity(channelId);
  if (!ch) return res.status(404).json({ error: 'Channel not found' });
  if (!(await isMember(ch.community_id, req.user.id))) return res.status(403).json({ error: 'Forbidden' });
  if (req.user.status === 'muted') return res.status(403).json({ error: 'Your account is muted' });
  const parsed = messageSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });

  // Resolve and claim the uploaded object (prevents IDOR / reuse).
  let storageRow = null;
  if (parsed.data.attachmentId) {
    storageRow = await db.prepare(`SELECT * FROM storage_objects WHERE id = ? AND owner_id = ?`).get(parsed.data.attachmentId, req.user.id);
    if (!storageRow) return res.status(400).json({ error: 'Invalid attachment' });
    const used = await db.prepare(`SELECT 1 FROM attachments WHERE storage_key = ?`).get(storageRow.storage_key);
    if (used) return res.status(409).json({ error: 'Attachment already used' });
  }

  let messageId;
  try {
    messageId = await db.tx(async (d) => {
      const r = await d.prepare(`INSERT INTO messages (channel_id, author_id, body) VALUES (?, ?, ?)`).run(channelId, req.user.id, parsed.data.body || '');
      const mid = r.lastInsertRowid;
      if (storageRow) {
        await d.prepare(`INSERT INTO attachments (message_id, storage_key, owner_id) VALUES (?, ?, ?)`).run(mid, storageRow.storage_key, req.user.id);
      }
      return mid;
    });
  } catch (e) {
    if (storageRow) uploads.discardStorageObject(storageRow.storage_key).catch(() => {});
    throw e;
  }

  const row = await db
    .prepare(
      `SELECT m.id, m.channel_id, m.conversation_id, m.author_id, m.body, m.edited, m.deleted, m.created_at,
              u.username AS author_name, p.avatar_storage_key AS author_avatar,
              att.id AS att_id, so.storage_key AS att_key, so.original_filename AS att_name,
              so.mime AS att_mime, so.size AS att_size, so.width AS att_width, so.height AS att_height
       FROM messages m JOIN users u ON u.id = m.author_id LEFT JOIN profiles p ON p.user_id = u.id ${ATTACH_JOIN}
       WHERE m.id = ?`
    )
    .get(messageId);

  const msg = serializeMessage(row);
  msg.reactions = {};
  msg.readByMe = true;
  realtime.publish(channelId, { type: 'message:new', channelId, message: msg });
  res.status(201).json({ message: msg });
});

module.exports = router;
