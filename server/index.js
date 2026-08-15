// server/index.js
const path = require('path');
const http = require('http');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { WebSocketServer } = require('ws');

const config = require('./config');
const db = require('./db');
const { attachUser, parseCookies, requireAuth, withPermissions, COOKIE_OPTS } = require('./middleware');
const realtime = require('./realtime');
const { seed } = require('./seed');

const authRouter = require('./routes/auth');
const communitiesRouter = require('./routes/communities');
const channelsRouter = require('./routes/channels');
const messagesRouter = require('./routes/messages');
const announcementsRouter = require('./routes/announcements');
const notificationsRouter = require('./routes/notifications');
const dmsRouter = require('./routes/dms');
const usersRouter = require('./routes/users');
const uploadsRouter = require('./routes/uploads');
const adminRouter = require('./routes/admin');
const moderationRouter = require('./routes/moderation');
const searchRouter = require('./routes/search');

const app = express();

// ---- Security headers ----
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'", "https://cdn.tailwindcss.com"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com", "https://fonts.googleapis.com"],
      imgSrc: ["'self'", 'data:', 'https:', 'blob:'],
      connectSrc: ["'self'", 'wss:', 'ws:'],
      frameSrc: ["'none'"],
    },
  },
  crossOriginResourcePolicy: { policy: 'cross-origin' },
}));

app.use(cors({ origin: config.appUrl, credentials: true }));
app.use(express.json({ limit: '1mb' }));
app.use(parseCookies);

// Attach client metadata for session creation.
app.use((req, res, next) => {
  res.locals.ip = req.ip || req.socket.remoteAddress;
  res.locals.ua = req.headers['user-agent'] || '';
  next();
});

app.use(attachUser);
app.use(withPermissions);

// Rate limiting on auth endpoints.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api/auth', authLimiter);

// No-cache for HTML/JS/CSS so updates always take effect.
app.use((req, res, next) => {
  const ext = path.extname(req.path).toLowerCase();
  if (ext === '.html' || ext === '.js' || ext === '.css') {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
  }
  next();
});

const publicDir = path.join(__dirname, '..', 'public');
app.use(express.static(publicDir));

// ---- API ----
app.get('/api/health', (req, res) => res.json({ ok: true, env: config.env }));
app.use('/api/auth', authRouter);
app.use('/api/communities', communitiesRouter);
app.use('/api/channels', channelsRouter);
app.use('/api/messages', messagesRouter);
app.use('/api/announcements', announcementsRouter);
app.use('/api/notifications', notificationsRouter);
app.use('/api/conversations', dmsRouter);
app.use('/api/dms', dmsRouter);
app.use('/api/users', usersRouter);
app.use('/api/uploads', uploadsRouter);
app.use('/api/admin', adminRouter);
app.use('/api/moderation', moderationRouter);
app.use('/api/search', searchRouter);

// 404 for unknown API
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});

// ---- Error handler (no stack traces leaked) ----
app.use((err, req, res, next) => {
  if (config.env !== 'production') console.error(err);
  res.status(err.status || 500).json({ error: config.env === 'production' ? 'Internal error' : err.message });
});

// ---- WebSocket (real-time) ----
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });
realtime.init(wss);

wss.on('connection', (ws, req) => {
  ws.userId = null;
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  // Buffer inbound frames until authentication completes. The auth step awaits
  // a DB call (slow on a cold Neon connection); if the client sends a `join`
  // immediately after opening, the message would otherwise arrive before the
  // handler below is attached and be silently dropped.
  const pending = [];
  let authed = false;
  const drain = () => { while (pending.length) handle(pending.shift()); };
  ws.on('message', (raw) => { pending.push(raw); if (authed) drain(); });

  async function handle(raw) {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.type === 'join' && msg.channelId) {
      const cid = parseInt(msg.channelId, 10);
      if (!(await realtime.joinChannel(ws, cid))) ws.send(JSON.stringify({ type: 'error', message: 'Forbidden' }));
    } else if (msg.type === 'leave' && msg.channelId) {
      realtime.leaveChannel(ws, parseInt(msg.channelId, 10));
    } else if (msg.type === 'dm:join' && msg.conversationId) {
      const cid = parseInt(msg.conversationId, 10);
      if (!(await realtime.joinConversation(ws, cid))) ws.send(JSON.stringify({ type: 'error', message: 'Forbidden' }));
    } else if (msg.type === 'dm:leave' && msg.conversationId) {
      realtime.leaveConversation(ws, parseInt(msg.conversationId, 10));
    } else if (msg.type === 'dm:typing' && msg.conversationId) {
      const cid = parseInt(msg.conversationId, 10);
      if (await realtime.canJoinConversation(ws.userId, cid)) {
        realtime.publishConversation(
          cid,
          { type: 'dm:typing', conversationId: cid, userId: ws.userId, typing: !!msg.typing },
          ws
        );
      }
    }
  }

  realtime.userFromWs(req).then(async (user) => {
    if (!user) { ws.close(4001, 'unauthorized'); return; }
    ws.userId = user.id;
    realtime.register(ws, user.id);
    await db.prepare(`INSERT OR REPLACE INTO presence (user_id, state, last_seen) VALUES (?, 'online', datetime('now'))`).run(user.id);
    realtime.broadcastPresence(user.id, 'online');
    realtime.sendPresenceSnapshot(ws, user.id);
    authed = true;
    drain();
  }).catch(() => { try { ws.close(4001, 'unauthorized'); } catch {} });

  ws.on('close', async () => {
    realtime.unregister(ws, ws.userId);
    const stillOnline = ws.userId ? realtime.userHasOpenSocket(ws.userId) : false;
    if (ws.userId) {
      if (!stillOnline) {
        await db.prepare(`UPDATE presence SET state = 'offline', last_seen = datetime('now') WHERE user_id = ?`).run(ws.userId);
      }
      realtime.broadcastPresence(ws.userId, stillOnline ? 'online' : 'offline');
    }
  });
});

// Heartbeat: terminate sockets that stop responding to pings (dead/reconnecting clients).
const heartbeat = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    try { ws.ping(); } catch { /* ignore */ }
  });
}, 30000);
wss.on('close', () => clearInterval(heartbeat));

// Seed on boot (idempotent).
seed().catch((e) => console.error('Seed error:', e.message));

// Vercel runs this file as a serverless function (no persistent port). Only
// start a long-lived listener when running as a normal Node process (local/dev).
if (!process.env.VERCEL) {
  server.listen(config.port, config.host, () => {
    console.log(`F SOCIETY running on http://${config.host}:${config.port} (${config.env})`);
  });
}

module.exports = app;
