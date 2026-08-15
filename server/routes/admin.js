// server/routes/admin.js
// Platform administration — storage visibility only (no file browser).
const express = require('express');
const router = express.Router();
const db = require('../db');
const { requireAuth, requirePermission } = require('../middleware');
const uploads = require('./uploads');

// Storage usage metadata (admin oversight only).
router.get('/storage', requireAuth, requirePermission('MANAGE_PLATFORM'), async (req, res) => {
  const total = await db.prepare(`SELECT COALESCE(SUM(so.size), 0) AS bytes, COUNT(*) AS objects FROM storage_objects so`).get();
  const attached = (await db.prepare(`SELECT COUNT(*) AS n FROM attachments`).get()).n;
  const orphans = (await db.prepare(
    `SELECT COUNT(*) AS n FROM storage_objects so WHERE NOT EXISTS (SELECT 1 FROM attachments a WHERE a.storage_key = so.storage_key)`
  ).get()).n;
  const largest = await db.prepare(
    `SELECT so.original_filename AS originalFilename, so.mime AS mimeType, so.size AS size, u.username AS owner
     FROM storage_objects so LEFT JOIN users u ON u.id = so.owner_id ORDER BY so.size DESC LIMIT 10`
  ).all();
  res.json({
    totalBytes: total.bytes,
    objectCount: total.objects,
    attachedCount: attached,
    orphanCount: orphans,
    largest,
  });
});

// Trigger orphaned-object cleanup.
router.post('/storage/cleanup', requireAuth, requirePermission('MANAGE_PLATFORM'), async (req, res) => {
  await uploads.cleanupOrphaned();
  res.json({ ok: true });
});

module.exports = router;
