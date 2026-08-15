// server/routes/realtime.js
// Exposes the realtime mode to the browser and issues subscribe-scoped Ably tokens.
const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware');
const realtime = require('../realtime');

// Tells the client whether to use the native WebSocket hub ('ws') or Ably ('ably').
router.get('/config', (req, res) => {
  res.json({ mode: realtime.getMode() });
});

// Returns an Ably token scoped to exactly the channels/conversations the caller may
// see. The browser uses this token (via authCallback) to subscribe; it can never
// publish, and it can only subscribe to channels it is a member of.
router.post('/token', requireAuth, async (req, res) => {
  const channels = Array.isArray(req.body.channels)
    ? req.body.channels.map(Number).filter((n) => !Number.isNaN(n)) : [];
  const conversations = Array.isArray(req.body.conversations)
    ? req.body.conversations.map(Number).filter((n) => !Number.isNaN(n)) : [];

  const capability = {
    ['user:' + req.user.id]: ['subscribe'],
    'global:presence': ['subscribe', 'presence'],
  };
  for (const id of channels) {
    if (await realtime.canJoinChannel(req.user.id, id)) capability['channel:' + id] = ['subscribe'];
  }
  for (const id of conversations) {
    if (await realtime.canJoinConversation(req.user.id, id)) capability['conv:' + id] = ['subscribe'];
  }

  try {
    const token = await realtime.requestToken(req.user.id, capability);
    res.json(token);
  } catch (e) {
    console.error('[realtime] token failed', e.message);
    res.status(500).json({ error: 'token_failed' });
  }
});

module.exports = router;
