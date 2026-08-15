// server/routes/search.js
// Global, authorized search across users, communities, channels, and messages.
// Authorization is enforced in every query (membership / visibility), never on the frontend.
const express = require('express');
const rateLimit = require('express-rate-limit');
const db = require('../db');
const { requireAuth } = require('../middleware');

const router = express.Router();

const SEARCH_LIMITER = rateLimit({
  windowMs: 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false,
  keyGenerator: (req) => String(req.user ? req.user.id : req.ip),
  message: { error: 'Too many searches, slow down' },
});

// Escape LIKE wildcards so user input is matched literally.
function likeEscape(s) {
  return s.replace(/[\\%_]/g, (c) => '\\' + c);
}

const TYPES = ['users', 'communities', 'channels', 'messages'];

router.get('/', requireAuth, SEARCH_LIMITER, async (req, res) => {
  const q = (req.query.q || '').trim();
  if (q.length < 2 || q.length > 100) {
    return res.json({ query: q, users: [], communities: [], channels: [], messages: [] });
  }
  const like = `%${likeEscape(q)}%`;
  const typesParam = (req.query.types || 'users,communities,channels,messages')
    .split(',').map((t) => t.trim()).filter((t) => TYPES.includes(t));
  const types = typesParam.length ? typesParam : TYPES;
  const limit = Math.min(parseInt(req.query.limit || '10', 10), 25);
  const offset = Math.max(parseInt(req.query.offset || '0', 10), 0);
  const uid = req.user.id;

  const out = { query: q, users: [], communities: [], channels: [], messages: [] };

  if (types.includes('users')) {
    out.users = (await db.prepare(
      `SELECT DISTINCT u.id, u.username, u.display_name AS displayName, p.avatar_storage_key AS avatar, pr.state AS presence
       FROM users u
       LEFT JOIN profiles p ON p.user_id = u.id
       LEFT JOIN presence pr ON pr.user_id = u.id
       WHERE u.status = 'active' AND u.id <> ?
         AND (u.username LIKE ? ESCAPE '\\' OR u.display_name LIKE ? ESCAPE '\\')
         AND EXISTS (SELECT 1 FROM community_members cm1 JOIN community_members cm2 ON cm1.community_id = cm2.community_id WHERE cm1.user_id = ? AND cm2.user_id = u.id)
       LIMIT ? OFFSET ?`
    ).all(uid, like, like, uid, limit, offset)).map((r) => ({
      id: r.id, username: r.username, displayName: r.displayName, avatar: r.avatar, presence: r.presence || 'offline',
    }));
  }

  if (types.includes('communities')) {
    out.communities = (await db.prepare(
      `SELECT c.id, c.name, c.description, c.slug,
              (SELECT COUNT(*) FROM community_members cm WHERE cm.community_id = c.id) AS memberCount,
              (SELECT COUNT(*) FROM community_members cm JOIN presence pr ON pr.user_id = cm.user_id WHERE cm.community_id = c.id AND pr.state = 'online') AS onlineCount
       FROM communities c
       WHERE (c.is_public = 1 OR EXISTS (SELECT 1 FROM community_members cm WHERE cm.community_id = c.id AND cm.user_id = ?))
         AND (c.name LIKE ? ESCAPE '\\' OR c.description LIKE ? ESCAPE '\\')
       LIMIT ? OFFSET ?`
    ).all(uid, like, like, limit, offset)).map((r) => ({
      id: r.id, name: r.name, description: r.description, slug: r.slug,
      memberCount: r.memberCount, onlineCount: r.onlineCount,
    }));
  }

  if (types.includes('channels')) {
    out.channels = (await db.prepare(
      `SELECT ch.id, ch.name, ch.slug, ch.topic, c.id AS communityId, c.name AS communityName
       FROM channels ch
       JOIN communities c ON c.id = ch.community_id
       JOIN community_members cm ON cm.community_id = c.id
       WHERE cm.user_id = ? AND (ch.name LIKE ? ESCAPE '\\' OR ch.topic LIKE ? ESCAPE '\\')
       LIMIT ? OFFSET ?`
    ).all(uid, like, like, limit, offset)).map((r) => ({
      id: r.id, name: r.name, slug: r.slug, topic: r.topic, communityId: r.communityId, communityName: r.communityName,
    }));
  }

  // DMs (conversation_id IS NOT NULL) are explicitly excluded — private messages never appear in global search.
  if (types.includes('messages')) {
    out.messages = (await db.prepare(
      `SELECT m.id, m.body, m.created_at, m.author_id, u.username AS authorName,
              ch.id AS channelId, ch.name AS channelName, c.id AS communityId, c.name AS communityName
       FROM messages m
       JOIN channels ch ON ch.id = m.channel_id
       JOIN communities c ON c.id = ch.community_id
       JOIN community_members cm ON cm.community_id = c.id
       JOIN users u ON u.id = m.author_id
       WHERE cm.user_id = ? AND m.conversation_id IS NULL AND m.deleted = 0 AND m.body LIKE ? ESCAPE '\\'
       ORDER BY m.id DESC
       LIMIT ? OFFSET ?`
    ).all(uid, like, limit, offset)).map((r) => ({
      id: r.id, preview: (r.body || '').slice(0, 240), body: r.body, createdAt: r.createdAt,
      authorId: r.author_id, authorName: r.authorName,
      channelId: r.channelId, channelName: r.channelName, communityId: r.communityId, communityName: r.communityName,
    }));
  }

  res.json(out);
});

module.exports = router;
