// server/routes/notifications.js
const express = require('express');
const router = express.Router();
const db = require('../db');
const { requireAuth } = require('../middleware');

// List current user's notifications (unread first).
router.get('/', requireAuth, (req, res) => {
  const rows = db
    .prepare(`SELECT id, type, payload, \`read\`, created_at FROM notifications WHERE user_id = ? ORDER BY \`read\` ASC, created_at DESC LIMIT 50`)
    .all(req.user.id);
  const unread = db.prepare(`SELECT COUNT(*) AS c FROM notifications WHERE user_id = ? AND \`read\` = 0`).get(req.user.id);
  res.json({ notifications: rows.map((n) => ({ ...n, payload: JSON.parse(n.payload || '{}') })), unread: unread.c });
});

router.post('/:id/read', requireAuth, (req, res) => {
  db.prepare(`UPDATE notifications SET \`read\` = 1 WHERE id = ? AND user_id = ?`).run(parseInt(req.params.id, 10), req.user.id);
  res.json({ ok: true });
});

router.post('/read-all', requireAuth, (req, res) => {
  db.prepare(`UPDATE notifications SET \`read\` = 1 WHERE user_id = ?`).run(req.user.id);
  res.json({ ok: true });
});

module.exports = router;
