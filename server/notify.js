// server/notify.js — notification creation + real-time push
const db = require('./db');
const realtime = require('./realtime');

// Create a notification for a user. payload is a JSON-serializable object.
function createNotification(userId, type, payload, { transactionDb } = {}) {
  const d = transactionDb || db;
  d.prepare(
    `INSERT INTO notifications (user_id, type, payload) VALUES (?, ?, ?)`
  ).run(userId, type, JSON.stringify(payload || {}));
  if (!transactionDb) {
    realtime.publishUser(userId, { type: 'notification:new', notification: { type, payload } });
  }
}

// Notify all members of a community (except excludeId) about an announcement.
function notifyCommunity(communityId, type, payload, excludeId) {
  const members = db
    .prepare(`SELECT user_id FROM community_members WHERE community_id = ?`)
    .all(communityId);
  members.forEach((m) => {
    if (m.user_id === excludeId) return;
    createNotification(m.user_id, type, payload);
  });
}

module.exports = { createNotification, notifyCommunity };
