// server/routes/uploads.js
// Upload endpoint (creates a storage object) + authorized download route.
// The binary is stored by the storage backend; the DB keeps metadata only.
const express = require('express');
const multer = require('multer');
const rateLimit = require('express-rate-limit');
const db = require('../db');
const { requireAuth } = require('../middleware');
const { isMember } = require('./communities');
const { createStorage, assertSafeKey } = require('../storage');
const { validateAndProcess } = require('../uploads');
const config = require('../config');

const router = express.Router();
const storage = createStorage();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: Math.max(config.maxImageBytes, config.maxDocBytes),
    files: 1,
    fields: 0,
  },
});

// Per-user upload rate limiting (abuse protection).
const uploadLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req.user ? String(req.user.id) : req.ip),
  message: { error: 'Too many uploads, slow down' },
});

function sanitizeForHeader(name) {
  return String(name || 'file').replace(/["\r\n]/g, '');
}

// Determine whether a user may view an attachment tied to a given message.
async function authorizeAttachment(user, att) {
  if (att.channel_id) {
    const ch = await db.prepare(`SELECT community_id FROM channels WHERE id = ?`).get(att.channel_id);
    if (!ch) return false;
    return isMember(ch.community_id, user.id);
  }
  if (att.conversation_id) {
    return !!(await db.prepare(`SELECT 1 FROM conversation_members WHERE conversation_id = ? AND user_id = ?`).get(att.conversation_id, user.id));
  }
  return false;
}

// POST /api/uploads — authenticated users may upload; target authorization is
// enforced later when the object is attached to a message.
router.post('/', requireAuth, uploadLimiter, upload.single('file'), async (req, res) => {
  let processed;
  try {
    if (!req.file) return res.status(400).json({ error: 'No file provided' });
    processed = await validateAndProcess(req.file.buffer, req.file.originalname, req.file.mimetype, req.user.id);
    const r = await db.prepare(
      `INSERT INTO storage_objects (storage_key, owner_id, mime, size, width, height, original_filename, checksum) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(processed.storageKey, req.user.id, processed.mimeType, processed.size, processed.width, processed.height, processed.originalFilename, processed.checksum);
    try {
      await storage.save(processed.buffer, { storageKey: processed.storageKey });
    } catch (saveErr) {
      await db.prepare(`DELETE FROM storage_objects WHERE id = ?`).run(r.lastInsertRowid);
      throw saveErr;
    }
    res.status(201).json({
      id: r.lastInsertRowid,
      storageKey: processed.storageKey,
      url: `/api/uploads/${r.lastInsertRowid}`,
      originalFilename: processed.originalFilename,
      mimeType: processed.mimeType,
      size: processed.size,
      width: processed.width,
      height: processed.height,
    });
  } catch (e) {
    if (processed && processed.storageKey) { try { await storage.delete(processed.storageKey); } catch {} }
    const status = e.status || 400;
    res.status(status).json({ error: e.message || 'Upload failed' });
  }
});

// GET /api/uploads/:id — authorized download/view. :id is the attachment id.
router.get('/:id', requireAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid id' });
  const att = await db.prepare(
    `SELECT a.storage_key, a.owner_id, so.mime, so.size, so.original_filename, m.channel_id, m.conversation_id, m.deleted
     FROM attachments a
     JOIN messages m ON m.id = a.message_id
     JOIN storage_objects so ON so.storage_key = a.storage_key
     WHERE a.id = ?`
  ).get(id);
  if (!att) return res.status(404).json({ error: 'Not found' });
  if (!(await authorizeAttachment(req.user, att))) return res.status(403).json({ error: 'Forbidden' });

  try {
    const buf = await storage.read(att.storage_key);
    res.set('Content-Type', att.mime);
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Content-Disposition', att.mime.startsWith('image/') ? 'inline' : `attachment; filename="${sanitizeForHeader(att.original_filename)}"`);
    res.send(buf);
  } catch {
    res.status(404).json({ error: 'Not found' });
  }
});

// Remove a storage object + its metadata row (used on failed message link).
async function discardStorageObject(storageKey) {
  assertSafeKey(storageKey);
  try { await storage.delete(storageKey); } catch {}
  await db.prepare(`DELETE FROM storage_objects WHERE storage_key = ?`).run(storageKey);
}

// Periodic cleanup: orphaned objects (uploaded but never attached) and
// attachments of long-deleted messages.
async function cleanupOrphaned() {
  try {
    const orphans = await db.prepare(
      `SELECT so.storage_key FROM storage_objects so
       WHERE NOT EXISTS (SELECT 1 FROM attachments a WHERE a.storage_key = so.storage_key)
         AND so.created_at < datetime('now', '-1 hour')`
    ).all();
    for (const o of orphans) { try { await storage.delete(o.storage_key); } catch {} await db.prepare(`DELETE FROM storage_objects WHERE storage_key = ?`).run(o.storage_key); }

    const stale = await db.prepare(
      `SELECT a.storage_key FROM attachments a JOIN messages m ON m.id = a.message_id
       WHERE m.deleted = 1 AND m.updated_at < datetime('now', '-30 days')`
    ).all();
    for (const o of stale) {
      try { await storage.delete(o.storage_key); } catch {}
      await db.prepare(`DELETE FROM storage_objects WHERE storage_key = ?`).run(o.storage_key);
      await db.prepare(`DELETE FROM attachments WHERE storage_key = ?`).run(o.storage_key);
    }
  } catch (e) {
    console.error('[cleanup] storage cleanup error:', e.message);
  }
}

// Multer / validation errors -> clean JSON.
router.use((err, req, res, next) => {
  if (err) {
    const status = err.code === 'LIMIT_FILE_SIZE' ? 413 : (err.status || 400);
    return res.status(status).json({ error: err.message || 'Upload error' });
  }
  next();
});

// Run a cleanup pass at boot (fire-and-forget).
cleanupOrphaned().catch(() => {});

router.discardStorageObject = discardStorageObject;
router.cleanupOrphaned = cleanupOrphaned;
module.exports = router;
