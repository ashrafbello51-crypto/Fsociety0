// server/realtime.js
// Pub/sub for channel messages, DM conversations, reactions, presence.
// Two modes:
//   - 'ws'   : in-memory WebSocket hub (local dev / self-hosted Node). Used when
//              ABLY_API_KEY is not set. This is what the integration harness exercises.
//   - 'ably' : serverless-friendly publish via Ably (https://ably.com). The server
//              only PUBLISHES; browser clients subscribe directly to Ably channels.
//              Enabled automatically when ABLY_API_KEY is present (e.g. on Vercel).
const auth = require('./auth');
const db = require('./db');

let Ably = null;
let ably = null; // Ably.Rest client — used to publish + issue client tokens
let mode = 'ws';

const state = {
  wss: null,
  channelSockets: new Map(),   // channelId -> Set(ws)
  userSockets: new Map(),      // userId -> Set(ws)
  conversationSockets: new Map(), // conversationId -> Set(ws)
};

function init(wss) {
  if (process.env.ABLY_API_KEY) {
    mode = 'ably';
    // Required lazily so the Ably package is not needed for local dev / the harness.
    Ably = require('ably');
    ably = new Ably.Rest(process.env.ABLY_API_KEY);
  } else {
    mode = 'ws';
    state.wss = wss;
  }
}

function getMode() { return mode; }

function publishAbly(channel, event) {
  if (!ably) return;
  ably.channels.get(channel).publish('event', event)
    .catch((e) => console.error('[ably] publish failed', channel, e.message));
}

// ---- authorization helpers (also used by the token endpoint) ----
async function canJoinChannel(userId, channelId) {
  const ch = await db.prepare(`SELECT community_id FROM channels WHERE id = ?`).get(channelId);
  if (!ch) return false;
  if (await db.prepare(`SELECT 1 FROM community_members WHERE community_id = ? AND user_id = ?`).get(ch.community_id, userId)) return true;
  return !!(await db.prepare(`SELECT 1 FROM communities WHERE id = ? AND is_public = 1`).get(ch.community_id));
}

async function canJoinConversation(userId, conversationId) {
  return !!(await db.prepare(`SELECT 1 FROM conversation_members WHERE conversation_id = ? AND user_id = ?`).get(conversationId, userId));
}

// Issue a subscribe-scoped Ably token for the authenticated user. Capabilities are
// constrained to channels/conversations the user is actually a member of, so a client
// cannot subscribe to (and therefore receive) traffic it shouldn't see.
async function requestToken(clientId, capability) {
  if (!ably) throw new Error('realtime not configured');
  return new Promise((resolve, reject) => {
    ably.auth.requestToken(
      { clientId: String(clientId), capability, ttl: 60 * 60 * 1000 },
      (err, token) => (err ? reject(err) : resolve(token))
    );
  });
}

// ---------- WebSocket-mode helpers (unused in 'ably' mode) ----------
function register(ws, userId) {
  if (!state.userSockets.has(userId)) state.userSockets.set(userId, new Set());
  state.userSockets.get(userId).add(ws);
}
function unregister(ws, userId) {
  if (userId && state.userSockets.has(userId)) state.userSockets.get(userId).delete(ws);
  state.channelSockets.forEach((set) => set.delete(ws));
  state.conversationSockets.forEach((set) => set.delete(ws));
}
function userHasOpenSocket(userId) {
  const set = state.userSockets.get(userId);
  return !!(set && set.size > 0);
}
async function joinChannel(ws, channelId) {
  if (!(await canJoinChannel(ws.userId, channelId))) return false;
  if (!state.channelSockets.has(channelId)) state.channelSockets.set(channelId, new Set());
  state.channelSockets.get(channelId).add(ws);
  return true;
}
function leaveChannel(ws, channelId) {
  if (state.channelSockets.has(channelId)) state.channelSockets.get(channelId).delete(ws);
}
async function joinConversation(ws, conversationId) {
  if (!(await canJoinConversation(ws.userId, conversationId))) return false;
  if (!state.conversationSockets.has(conversationId)) state.conversationSockets.set(conversationId, new Set());
  state.conversationSockets.get(conversationId).add(ws);
  return true;
}
function leaveConversation(ws, conversationId) {
  if (state.conversationSockets.has(conversationId)) state.conversationSockets.get(conversationId).delete(ws);
}
function userInConversation(conversationId, userId) {
  const set = state.conversationSockets.get(conversationId);
  if (!set) return false;
  let found = false;
  set.forEach((ws) => { if (ws.userId === userId) found = true; });
  return found;
}

// ---------- publish (mode-aware) ----------
function publish(channelId, event) {
  if (mode === 'ably') return publishAbly('channel:' + channelId, event);
  const set = state.channelSockets.get(channelId);
  if (!set) return;
  const data = JSON.stringify(event);
  set.forEach((ws) => { if (ws.readyState === 1) ws.send(data); });
}

function publishConversation(conversationId, event, excludeWs) {
  if (mode === 'ably') return publishAbly('conv:' + conversationId, event);
  const set = state.conversationSockets.get(conversationId);
  if (!set) return;
  const data = JSON.stringify(event);
  set.forEach((ws) => { if (ws.readyState === 1 && ws !== excludeWs) ws.send(data); });
}

function publishUser(userId, event) {
  if (mode === 'ably') return publishAbly('user:' + userId, event);
  const set = state.userSockets.get(userId);
  if (!set) return;
  const data = JSON.stringify(event);
  set.forEach((ws) => { if (ws.readyState === 1) ws.send(data); });
}

// Presence is client-driven via Ably's presence feature in 'ably' mode; no-op here.
function broadcastPresence(userId, presenceState) {
  if (mode === 'ably') return;
  const data = JSON.stringify({ type: 'presence', userId, state: presenceState });
  state.userSockets.forEach((set, uid) => {
    if (uid === userId) return;
    set.forEach((ws) => { if (ws.readyState === 1) ws.send(data); });
  });
}
function sendPresenceSnapshot(ws, userId) {
  if (mode === 'ably') return;
  if (ws.readyState !== 1) return;
  state.userSockets.forEach((set, uid) => {
    if (uid === userId) return;
    if (set.size > 0) ws.send(JSON.stringify({ type: 'presence', userId: uid, state: 'online' }));
  });
}

async function userFromWs(req) {
  const header = req.headers.cookie || '';
  let refresh = null;
  header.split(';').forEach((p) => {
    const i = p.indexOf('=');
    if (i > -1 && p.slice(0, i).trim() === 'fs_refresh') refresh = decodeURIComponent(p.slice(i + 1).trim());
  });
  if (refresh) {
    const u = await auth.getSessionByToken(refresh);
    if (u && u.status !== 'banned') {
      if ((u.status === 'muted' || u.status === 'suspended') && u.expires_at) {
        if (new Date(u.expires_at).getTime() <= Date.now()) u.status = 'active';
      }
      return u;
    }
  }
  return null;
}

module.exports = {
  init, getMode, register, unregister, userHasOpenSocket,
  joinChannel, leaveChannel, publish, publishUser,
  joinConversation, leaveConversation, publishConversation, userInConversation,
  broadcastPresence, sendPresenceSnapshot, userFromWs, canJoinChannel, canJoinConversation,
  requestToken,
};
