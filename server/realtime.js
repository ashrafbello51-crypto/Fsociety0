// server/realtime.js
// Lightweight pub/sub over WebSocket for channel messages, DM conversations, reactions, presence.
const auth = require('./auth');
const db = require('./db');

const state = {
  wss: null,
  // channelId -> Set(ws)
  channelSockets: new Map(),
  // userId -> Set(ws)
  userSockets: new Map(),
  // conversationId -> Set(ws)
  conversationSockets: new Map(),
};

function init(wss) {
  state.wss = wss;
}

function register(ws, userId) {
  if (!state.userSockets.has(userId)) state.userSockets.set(userId, new Set());
  state.userSockets.get(userId).add(ws);
}

function unregister(ws, userId) {
  if (userId && state.userSockets.has(userId)) {
    state.userSockets.get(userId).delete(ws);
  }
  state.channelSockets.forEach((set) => set.delete(ws));
  state.conversationSockets.forEach((set) => set.delete(ws));
}

function userHasOpenSocket(userId) {
  const set = state.userSockets.get(userId);
  return !!(set && set.size > 0);
}

// Authorization helpers — a socket may only subscribe to channels/conversations
// it is legitimately entitled to see. Without this check, any client could join
// an arbitrary channel/conversation by id and receive messages it shouldn't.
function canJoinChannel(userId, channelId) {
  const ch = db.prepare(`SELECT community_id FROM channels WHERE id = ?`).get(channelId);
  if (!ch) return false;
  if (db.prepare(`SELECT 1 FROM community_members WHERE community_id = ? AND user_id = ?`).get(ch.community_id, userId)) return true;
  return !!db.prepare(`SELECT 1 FROM communities WHERE id = ? AND is_public = 1`).get(ch.community_id);
}

function canJoinConversation(userId, conversationId) {
  return !!db.prepare(`SELECT 1 FROM conversation_members WHERE conversation_id = ? AND user_id = ?`).get(conversationId, userId);
}

// ---- channels ----
function joinChannel(ws, channelId) {
  if (!canJoinChannel(ws.userId, channelId)) return false;
  if (!state.channelSockets.has(channelId)) state.channelSockets.set(channelId, new Set());
  state.channelSockets.get(channelId).add(ws);
  return true;
}

function leaveChannel(ws, channelId) {
  if (state.channelSockets.has(channelId)) state.channelSockets.get(channelId).delete(ws);
}

function publish(channelId, event) {
  const set = state.channelSockets.get(channelId);
  if (!set) return;
  const data = JSON.stringify(event);
  set.forEach((ws) => {
    if (ws.readyState === 1) ws.send(data);
  });
}

// ---- conversations (DMs) ----
function joinConversation(ws, conversationId) {
  if (!canJoinConversation(ws.userId, conversationId)) return false;
  if (!state.conversationSockets.has(conversationId)) state.conversationSockets.set(conversationId, new Set());
  state.conversationSockets.get(conversationId).add(ws);
  return true;
}

function leaveConversation(ws, conversationId) {
  if (state.conversationSockets.has(conversationId)) state.conversationSockets.get(conversationId).delete(ws);
}

// Deliver to every socket subscribed to the conversation, optionally excluding one (e.g. the sender).
function publishConversation(conversationId, event, excludeWs) {
  const set = state.conversationSockets.get(conversationId);
  if (!set) return;
  const data = JSON.stringify(event);
  set.forEach((ws) => {
    if (ws.readyState === 1 && ws !== excludeWs) ws.send(data);
  });
}

// Is a given user currently subscribed (has a socket) to this conversation?
function userInConversation(conversationId, userId) {
  const set = state.conversationSockets.get(conversationId);
  if (!set) return false;
  let found = false;
  set.forEach((ws) => { if (ws.userId === userId) found = true; });
  return found;
}

function publishUser(userId, event) {
  const set = state.userSockets.get(userId);
  if (!set) return;
  const data = JSON.stringify(event);
  set.forEach((ws) => {
    if (ws.readyState === 1) ws.send(data);
  });
}

// Broadcast a presence change to every *other* connected, authenticated user.
function broadcastPresence(userId, presenceState) {
  const data = JSON.stringify({ type: 'presence', userId, state: presenceState });
  state.userSockets.forEach((set, uid) => {
    if (uid === userId) return;
    set.forEach((ws) => { if (ws.readyState === 1) ws.send(data); });
  });
}

// Authenticate a websocket connection from its cookies.
function userFromWs(req) {
  const header = req.headers.cookie || '';
  let refresh = null;
  header.split(';').forEach((p) => {
    const i = p.indexOf('=');
    if (i > -1 && p.slice(0, i).trim() === 'fs_refresh') refresh = decodeURIComponent(p.slice(i + 1).trim());
  });
  if (refresh) {
    const u = auth.getSessionByToken(refresh);
    if (u && u.status !== 'banned') {
      // Revert a timed mute/suspension whose expiry has passed.
      if ((u.status === 'muted' || u.status === 'suspended') && u.expires_at) {
        if (new Date(u.expires_at).getTime() <= Date.now()) u.status = 'active';
      }
      return u;
    }
  }
  return null;
}

module.exports = {
  init, register, unregister, userHasOpenSocket,
  joinChannel, leaveChannel, publish, publishUser,
  joinConversation, leaveConversation, publishConversation, userInConversation,
  broadcastPresence, userFromWs, canJoinChannel, canJoinConversation,
};
