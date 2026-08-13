// server/routes/communities.js
const express = require('express');
const router = express.Router();
const z = require('zod');
const db = require('../db');
const { requireAuth } = require('../middleware');

function isMember(communityId, userId) {
  return !!db.prepare(`SELECT 1 FROM community_members WHERE community_id = ? AND user_id = ?`).get(communityId, userId);
}

const createSchema = z.object({
  name: z.string().min(2).max(60),
  description: z.string().max(500).optional(),
});

router.get('/', requireAuth, (req, res) => {
  const rows = db
    .prepare(
      `SELECT c.id, c.name, c.slug, c.description, c.icon_storage_key,
              (SELECT COUNT(*) FROM community_members cm WHERE cm.community_id = c.id) AS member_count,
              (SELECT COUNT(*) FROM community_members cm WHERE cm.community_id = c.id AND cm.user_id = ?) AS joined
       FROM communities c ORDER BY c.name`
    )
    .all(req.user.id);
  res.json({ communities: rows });
});

router.post('/', requireAuth, (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Validation failed' });
  const slug = parsed.data.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  try {
    const r = db.prepare(`INSERT INTO communities (name, slug, description, owner_id) VALUES (?, ?, ?, ?)`).run(
      parsed.data.name, slug, parsed.data.description || '', req.user.id
    );
    const cid = r.lastInsertRowid;
    db.prepare(`INSERT INTO community_members (community_id, user_id, role) VALUES (?, ?, 'owner')`).run(cid, req.user.id);
    res.status(201).json({ id: cid, name: parsed.data.name, slug });
  } catch (e) {
    res.status(409).json({ error: 'Community name already exists' });
  }
});

router.post('/:id/join', requireAuth, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const exists = db.prepare(`SELECT id FROM communities WHERE id = ?`).get(id);
  if (!exists) return res.status(404).json({ error: 'Community not found' });
  if (isMember(id, req.user.id)) return res.json({ ok: true });
  db.prepare(`INSERT OR IGNORE INTO community_members (community_id, user_id, role) VALUES (?, ?, 'member')`).run(id, req.user.id);
  res.json({ ok: true });
});

router.post('/:id/leave', requireAuth, (req, res) => {
  const id = parseInt(req.params.id, 10);
  db.prepare(`DELETE FROM community_members WHERE community_id = ? AND user_id = ?`).run(id, req.user.id);
  res.json({ ok: true });
});

// Channels within a community (requires membership).
router.get('/:id/channels', requireAuth, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!isMember(id, req.user.id)) return res.status(403).json({ error: 'Join the community first' });
  const rows = db
    .prepare(`SELECT id, name, slug, kind, topic, position FROM channels WHERE community_id = ? ORDER BY position, name`)
    .all(id);
  res.json({ channels: rows });
});

module.exports = router;
module.exports.isMember = isMember;
