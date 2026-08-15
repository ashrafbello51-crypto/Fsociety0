// server/routes/users.js
// User discovery, scoped to people who share at least one community with the requester.
const express = require('express');
const router = express.Router();
const db = require('../db');
const { requireAuth } = require('../middleware');

router.get('/search', requireAuth, async (req, res) => {
  const q = (req.query.q || '').trim();
  if (q.length < 2) return res.json({ users: [] });
  const like = `%${q}%`;
  const rows = await db.prepare(
    `SELECT DISTINCT u.id, u.username, u.display_name, p.avatar_storage_key AS avatar
     FROM users u
     LEFT JOIN profiles p ON p.user_id = u.id
     WHERE u.status = 'active'
       AND u.id <> ?
       AND (u.username LIKE ? OR u.display_name LIKE ?)
       AND EXISTS (
         SELECT 1 FROM community_members cm1
         JOIN community_members cm2 ON cm1.community_id = cm2.community_id
         WHERE cm1.user_id = ? AND cm2.user_id = u.id
       )
     LIMIT 20`
  ).all(req.user.id, like, like, req.user.id);

  res.json({
    users: rows.map((r) => ({ id: r.id, username: r.username, displayName: r.display_name, avatar: r.avatar })),
  });
});

// Public profile for a single user (used by search -> profile and moderation).
router.get('/:id', requireAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid id' });
  const row = await db.prepare(
    `SELECT u.id, u.username, u.display_name, u.status, u.created_at,
            p.bio, p.avatar_storage_key AS avatar, p.experience_level AS experienceLevel, p.interests,
            pr.state AS presence
     FROM users u
     LEFT JOIN profiles p ON p.user_id = u.id
     LEFT JOIN presence pr ON pr.user_id = u.id
     WHERE u.id = ?`
  ).get(id);
  if (!row) return res.status(404).json({ error: 'User not found' });
  const mutual = (await db.prepare(
    `SELECT COUNT(*) AS n FROM community_members cm1
     JOIN community_members cm2 ON cm1.community_id = cm2.community_id
     WHERE cm1.user_id = ? AND cm2.user_id = ?`
  ).get(req.user.id, id)).n;
  res.json({
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    status: row.status,
    avatar: row.avatar,
    bio: row.bio,
    experienceLevel: row.experienceLevel,
    interests: row.interests ? JSON.parse(row.interests || '[]') : [],
    presence: row.presence || 'offline',
    sharesCommunity: mutual > 0,
    createdAt: row.created_at,
  });
});

module.exports = router;
