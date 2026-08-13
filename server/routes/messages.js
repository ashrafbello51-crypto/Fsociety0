// server/routes/messages.js
const express = require('express');
const router = express.Router();
const z = require('zod');
const db = require('../db');
const { requireAuth, requirePermission } = require('../middleware');
const { audit } = require('../audit');
const realtime = require('../realtime');

function messageChannel(messageId) {
  return db.prepare(`SELECT channel_id FROM messages WHERE id = ?`).get(messageId);
}

// Ensure the current user may interact with the given message (channel
// membership, or membership in the DM conversation, or moderation rights).
function canInteract(user, msg) {
  if (!msg) return false;
  if (require('../rbac').userHasPermission(user.id, 'MODERATE_CONTENT')) return true;
  if (msg.channel_id) {
    const ch = db.prepare(`SELECT community_id FROM channels WHERE id = ?`).get(msg.channel_id);
    if (!ch) return false;
    return !!db.prepare(`SELECT 1 FROM community_members WHERE community_id = ? AND user_id = ?`).get(ch.community_id, user.id);
  }
  if (msg.conversation_id) {
    return !!db.prepare(`SELECT 1 FROM conversation_members WHERE conversation_id = ? AND user_id = ?`).get(msg.conversation_id, user.id);
  }
  return false;
}

// Toggle a reaction.
router.post('/:id/react', requireAuth, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const emoji = (req.body && req.body.emoji) || '👍';
  if (typeof emoji !== 'string' || emoji.length > 8) return res.status(400).json({ error: 'Invalid emoji' });
  const msg = db.prepare(`SELECT id, channel_id, conversation_id, author_id FROM messages WHERE id = ? AND deleted = 0`).get(id);
  if (!msg) return res.status(404).json({ error: 'Message not found' });
  if (!canInteract(req.user, msg)) return res.status(403).json({ error: 'Forbidden' });

  const existing = db.prepare(`SELECT 1 FROM message_reactions WHERE message_id = ? AND user_id = ? AND emoji = ?`).get(id, req.user.id, emoji);
  if (existing) {
    db.prepare(`DELETE FROM message_reactions WHERE message_id = ? AND user_id = ? AND emoji = ?`).run(id, req.user.id, emoji);
  } else {
    db.prepare(`INSERT INTO message_reactions (message_id, user_id, emoji) VALUES (?, ?, ?)`).run(id, req.user.id, emoji);
  }

  const reacts = db
    .prepare(`SELECT emoji, COUNT(*) AS count, SUM(user_id = ?) AS mine FROM message_reactions WHERE message_id = ? GROUP BY emoji`)
    .all(req.user.id, id);
  const map = {};
  reacts.forEach((r) => (map[r.emoji] = { count: r.count, mine: !!r.mine }));

  if (msg.channel_id) realtime.publish(msg.channel_id, { type: 'message:reaction', channelId: msg.channel_id, messageId: id, reactions: map });
  if (msg.conversation_id) realtime.publishConversation(msg.conversation_id, { type: 'dm:reaction', conversationId: msg.conversation_id, messageId: id, reactions: map });
  res.json({ reactions: map });
});

// Soft-delete (author or moderator).
router.delete('/:id', requireAuth, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const msg = db.prepare(`SELECT id, channel_id, conversation_id, author_id FROM messages WHERE id = ?`).get(id);
  if (!msg) return res.status(404).json({ error: 'Message not found' });
  const isAuthor = msg.author_id === req.user.id;
  const canModerate = require('../rbac').userHasPermission(req.user.id, 'MODERATE_CONTENT');
  if (!isAuthor && !canModerate) return res.status(403).json({ error: 'Forbidden' });
  db.prepare(`UPDATE messages SET deleted = 1, body = '', updated_at = datetime('now') WHERE id = ?`).run(id);
  if (canModerate && !isAuthor) {
    audit({
      actorId: req.user.id, action: 'MESSAGE_DELETED', entityType: 'message', entityId: id,
      metadata: { channelId: msg.channel_id, conversationId: msg.conversation_id, authorId: msg.author_id },
      ip: res.locals.ip,
    });
  }
  if (msg.channel_id) realtime.publish(msg.channel_id, { type: 'message:delete', channelId: msg.channel_id, messageId: id });
  if (msg.conversation_id) realtime.publishConversation(msg.conversation_id, { type: 'dm:delete', conversationId: msg.conversation_id, messageId: id });
  res.json({ ok: true });
});

// Mark as read.
router.post('/:id/read', requireAuth, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const msg = db.prepare(`SELECT id, channel_id, conversation_id FROM messages WHERE id = ?`).get(id);
  if (!msg) return res.status(404).json({ error: 'Message not found' });
  if (!canInteract(req.user, msg)) return res.status(403).json({ error: 'Forbidden' });
  db.prepare(`INSERT OR IGNORE INTO message_reads (message_id, user_id) VALUES (?, ?)`).run(id, req.user.id);
  res.json({ ok: true });
});

module.exports = router;
