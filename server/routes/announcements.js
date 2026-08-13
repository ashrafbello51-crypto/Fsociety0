// server/routes/announcements.js
const express = require('express');
const router = express.Router();
const z = require('zod');
const db = require('../db');
const { requireAuth, requirePermission } = require('../middleware');
const { isMember } = require('./communities');
const { notifyCommunity } = require('../notify');

const createSchema = z.object({
  communityId: z.number().int().positive(),
  title: z.string().min(3).max(160),
  body: z.string().min(1).max(5000),
  imageStorageKey: z.string().max(255).optional(),
  status: z.enum(['draft', 'published', 'archived']).default('draft'),
});

// List announcements for a community. Members see published; authorized roles see all.
router.get('/community/:id', requireAuth, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!isMember(id, req.user.id)) return res.status(403).json({ error: 'Join the community first' });
  const authorized = require('../rbac').userHasPermission(req.user.id, 'POST_ANNOUNCEMENTS') ||
    require('../rbac').userHasPermission(req.user.id, 'MANAGE_COMMUNITIES');
  const rows = db
    .prepare(
      `SELECT a.id, a.community_id, a.author_id, a.title, a.body, a.image_storage_key, a.status, a.published_at, a.created_at,
              u.username AS author_name
       FROM announcements a JOIN users u ON u.id = a.author_id
       WHERE a.community_id = ? ${authorized ? '' : "AND a.status = 'published'"}
       ORDER BY a.published_at DESC, a.created_at DESC`
    )
    .all(id);
  res.json({ announcements: rows });
});

// Create announcement (authorized roles only).
router.post('/', requireAuth, requirePermission('POST_ANNOUNCEMENTS'), (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });
  const { communityId, title, body, imageStorageKey, status } = parsed.data;
  if (!isMember(communityId, req.user.id)) return res.status(403).json({ error: 'Must be a community member' });

  const published = status === 'published';
  const info = db.prepare(
    `INSERT INTO announcements (community_id, author_id, title, body, image_storage_key, status, published_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(communityId, req.user.id, title, body, imageStorageKey || null, status, published ? new Date().toISOString() : null);

  if (published) {
    notifyCommunity(communityId, 'announcement', { announcementId: info.lastInsertRowid, communityId, title }, req.user.id);
  }
  const row = db.prepare(`SELECT * FROM announcements WHERE id = ?`).get(info.lastInsertRowid);
  res.status(201).json({ announcement: row });
});

// Update (author or MANAGE_COMMUNITIES). Publishing transitions notify members once.
router.patch('/:id', requireAuth, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const ann = db.prepare(`SELECT * FROM announcements WHERE id = ?`).get(id);
  if (!ann) return res.status(404).json({ error: 'Not found' });
  const canManage = require('../rbac').userHasPermission(req.user.id, 'MANAGE_COMMUNITIES');
  if (ann.author_id !== req.user.id && !canManage) return res.status(403).json({ error: 'Forbidden' });

  const title = req.body.title !== undefined ? String(req.body.title).slice(0, 160) : ann.title;
  const body = req.body.body !== undefined ? String(req.body.body).slice(0, 5000) : ann.body;
  let status = ann.status;
  if (req.body.status && ['draft', 'published', 'archived'].includes(req.body.status)) status = req.body.status;
  const publishedAt = status === 'published' && ann.status !== 'published' ? new Date().toISOString() : ann.published_at;

  db.prepare(`UPDATE announcements SET title = ?, body = ?, status = ?, published_at = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(title, body, status, publishedAt, id);

  if (status === 'published' && ann.status !== 'published') {
    notifyCommunity(ann.community_id, 'announcement', { announcementId: id, communityId: ann.community_id, title }, ann.author_id);
  }
  res.json({ announcement: db.prepare(`SELECT * FROM announcements WHERE id = ?`).get(id) });
});

router.delete('/:id', requireAuth, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const ann = db.prepare(`SELECT * FROM announcements WHERE id = ?`).get(id);
  if (!ann) return res.status(404).json({ error: 'Not found' });
  const canManage = require('../rbac').userHasPermission(req.user.id, 'MANAGE_COMMUNITIES');
  if (ann.author_id !== req.user.id && !canManage) return res.status(403).json({ error: 'Forbidden' });
  db.prepare(`DELETE FROM announcements WHERE id = ?`).run(id);
  res.json({ ok: true });
});

module.exports = router;
