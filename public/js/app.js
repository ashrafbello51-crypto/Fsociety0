// public/js/app.js — F SOCIETY SPA (preserves Stitch visual identity)
(() => {
  'use strict';

  const API = {
    async req(method, path, body, isForm) {
      const opts = { method, credentials: 'include', headers: {} };
      if (body) {
        if (isForm) { opts.body = body; }
        else { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
      }
      const res = await fetch('/api' + path, opts);
      let data = null;
      try { data = await res.json(); } catch {}
      if (!res.ok) {
        const err = new Error((data && data.error) || ('HTTP ' + res.status));
        err.status = res.status; err.data = data; throw err;
      }
      return data;
    },
    get: (p) => API.req('GET', p),
    post: (p, b) => API.req('POST', p, b),
    del: (p, b) => API.req('DELETE', p, b),
  };

  const state = {
    user: null,
    profile: null,
    roles: [],
    permissions: [],
    communities: [],
    activeCommunity: null,
    activeChannel: null,
    messages: [],
    conversations: [],
    activeConversation: null,
    dmMessages: [],
    presence: {},
    ws: null,
    route: location.hash || '#/',
  };

  // ---------- helpers ----------
  const $ = (sel, root = document) => root.querySelector(sel);
  const el = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; };
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const hasPerm = (p) => state.permissions.includes(p);

  // ---------- Realtime (native WebSocket locally, Ably on serverless) ----------
  const rt = { mode: 'ws', ably: null, connected: false, desiredChannels: new Set(), desiredConvs: new Set(), subs: new Map() };

  // Single dispatch path for both transports.
  function handleRealtimeEvent(msg) {
    if (!msg || !msg.type) return;
    if (msg.type === 'message:new' && state.activeChannel && msg.channelId === state.activeChannel.id) {
      if (state.messages.find((m) => m.id === msg.message.id)) return;
      state.messages.push(msg.message); appendMessage(msg.message); scrollMessages();
    } else if (msg.type === 'message:delete' && state.activeChannel && msg.channelId === state.activeChannel.id) {
      state.messages = state.messages.filter((m) => m.id !== msg.messageId);
      const node = document.getElementById('msg-' + msg.messageId); if (node) node.remove();
    } else if (msg.type === 'message:reaction' && state.activeChannel && msg.channelId === state.activeChannel.id) {
      const node = document.getElementById('msg-' + msg.messageId);
      if (node) { const r = $('.msg-reactions', node); if (r) r.innerHTML = renderReactions(msg.reactions); }
    } else if (msg.type === 'notification:new') {
      loadNotifications();
    } else if (msg.type === 'presence') {
      updatePresence(msg.userId, msg.state);
    } else if (msg.type === 'dm:new') {
      if (state.activeConversation && msg.conversationId === state.activeConversation.id) {
        if (state.dmMessages.find((m) => m.id === msg.message.id)) return;
        state.dmMessages.push(msg.message); appendDMMessage(msg.message); scrollDM();
        API.post(`/conversations/${state.activeConversation.id}/read`).catch(() => {});
      } else { refreshConversations(); }
    } else if (msg.type === 'dm:reaction' && state.activeConversation && msg.conversationId === state.activeConversation.id) {
      const node = document.getElementById('dm-' + msg.messageId);
      if (node) { const r = $('.msg-reactions', node); if (r) r.innerHTML = renderReactions(msg.reactions); }
    } else if (msg.type === 'dm:delete' && state.activeConversation && msg.conversationId === state.activeConversation.id) {
      const node = document.getElementById('dm-' + msg.messageId);
      if (node) { const body = $('.dm-body', node); if (body) { body.textContent = '[ deleted ]'; body.classList.add('opacity-40', 'italic'); } }
    } else if (msg.type === 'dm:typing' && state.activeConversation && msg.conversationId === state.activeConversation.id) {
      showTyping(msg.userId, msg.typing);
    } else if (msg.type === 'dm:read' && state.activeConversation && msg.conversationId === state.activeConversation.id) {
      refreshConversations();
    }
  }

  async function connectRealtime() {
    if (!state.user) return;
    let cfg = { mode: 'ws' };
    try { cfg = await API.get('/realtime/config'); } catch {}
    rt.mode = cfg.mode || 'ws';
    if (rt.mode === 'ably' && window.Ably) await connectAbly();
    else connectWS();
  }

  function connectWS() {
    if (state.ws && state.ws.readyState === 1) return;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    state.ws = ws;
    ws.onopen = () => { rt.connected = true; };
    ws.onmessage = (ev) => { let msg; try { msg = JSON.parse(ev.data); } catch { return; } handleRealtimeEvent(msg); };
    ws.onclose = () => { rt.connected = false; setTimeout(() => { if (state.user) connectRealtime(); }, 2000); };
  }

  async function connectAbly() {
    rt.ably = new Ably.Realtime({ clientId: String(state.user.id), authCallback: ablyAuth });
    rt.ably.connection.on('connected', () => {
      rt.connected = true;
      subscribeAbly('user:' + state.user.id);
      subscribeAbly('global:presence');
      enterPresence();
    });
    rt.ably.connection.on('failed', () => { rt.connected = false; });
    rt.ably.connection.on('closed', () => { rt.connected = false; });
  }

  async function ablyAuth(params, callback) {
    try {
      const tok = await API.post('/realtime/token', {
        channels: Array.from(rt.desiredChannels),
        conversations: Array.from(rt.desiredConvs),
      });
      callback(null, tok);
    } catch (e) { callback(e); }
  }

  function subscribeAbly(name) {
    if (!rt.ably || rt.subs.has(name)) return;
    if (name.startsWith('channel:')) rt.desiredChannels.add(parseInt(name.slice(8), 10));
    else if (name.startsWith('conv:')) rt.desiredConvs.add(parseInt(name.slice(5), 10));
    if (rt.ably.auth.isAuthorized) rt.ably.auth.authorize().catch(() => {});
    const ch = rt.ably.channels.get(name);
    ch.subscribe((message) => handleRealtimeEvent(message.data)).catch(() => {});
    rt.subs.set(name, ch);
  }

  function unsubscribeAbly(name) {
    if (!rt.subs.has(name)) return;
    rt.subs.get(name).unsubscribe().catch(() => {});
    rt.subs.delete(name);
  }

  function enterPresence() {
    const pc = rt.ably.channels.get('global:presence');
    pc.presence.enter().catch(() => {});
    pc.presence.subscribe('enter', (m) => updatePresence(parseInt(m.clientId, 10), 'online'));
    pc.presence.subscribe('leave', (m) => updatePresence(parseInt(m.clientId, 10), 'offline'));
    pc.presence.subscribe('update', (m) => updatePresence(parseInt(m.clientId, 10), (m.data && m.data.state) || 'online'));
  }

  // Send-side. In Ably mode the only client->server realtime action is the typing
  // indicator (everything else is published by the server after an authorized REST call).
  function wsSend(obj) {
    if (rt.mode === 'ably') {
      if (obj.type === 'dm:typing' && obj.conversationId) {
        API.post(`/conversations/${obj.conversationId}/typing`, { typing: !!obj.typing }).catch(() => {});
      }
      return;
    }
    if (state.ws && state.ws.readyState === 1) state.ws.send(JSON.stringify(obj));
  }

  function joinChannelRealtime(id) {
    if (rt.mode === 'ably') subscribeAbly('channel:' + id);
    else joinChannelRealtime(id);
  }
  function leaveChannelRealtime(id) {
    if (rt.mode === 'ably') unsubscribeAbly('channel:' + id);
    else wsSend({ type: 'leave', channelId: id });
  }
  function joinConvRealtime(id) {
    if (rt.mode === 'ably') subscribeAbly('conv:' + id);
    else joinConvRealtime(id);
  }
  function leaveConvRealtime(id) {
    if (rt.mode === 'ably') unsubscribeAbly('conv:' + id);
    else leaveConvRealtime(id);
  }
  function disconnectRealtime() {
    if (rt.mode === 'ably' && rt.ably) {
      rt.ably.channels.get('global:presence').presence.leave().catch(() => {});
      rt.ably.close();
    } else if (state.ws) { state.ws.close(); }
  }

  // ---------- notifications ----------
  state.notifications = [];
  async function loadNotifications() {
    try {
      const data = await API.get('/notifications');
      state.notifications = data.notifications;
      const badge = $('#notif-badge');
      if (badge) {
        if (data.unread > 0) { badge.textContent = data.unread > 9 ? '9+' : String(data.unread); badge.classList.remove('hidden'); }
        else badge.classList.add('hidden');
      }
    } catch {}
  }
  function renderNotificationPanel() {
    const panel = $('#notif-panel');
    if (!panel) return;
    if (!state.notifications.length) {
      panel.innerHTML = `<div class="font-mono-label text-on-surface-variant p-4 text-center">NO TRANSMISSIONS</div>`;
      return;
    }
    panel.innerHTML = state.notifications.map((n) => `
      <div class="border-b border-outline-variant px-4 py-3 flex flex-col gap-1 ${n.read ? 'opacity-60' : ''}">
        <div class="flex justify-between"><span class="font-mono-label text-mono-label text-primary-fixed-dim uppercase">${esc(n.type)}</span>${n.read ? '' : '<span class="w-2 h-2 bg-primary-container rounded-full"></span>'}</div>
        <div class="font-body-sm text-on-surface">${esc((n.payload && n.payload.title) || n.type)}</div>
        <div class="font-mono-label text-outline text-[10px]">${esc(n.created_at)}</div>
      </div>`).join('');
  }
  function toggleNotifications() {
    const panel = $('#notif-panel');
    if (!panel) return;
    if (panel.classList.contains('hidden')) {
      loadNotifications().then(() => { renderNotificationPanel(); panel.classList.remove('hidden'); });
    } else {
      panel.classList.add('hidden');
    }
  }

  // ---------- announcements ----------
  state.announcements = [];
  async function loadAnnouncements(communityId) {
    try {
      const data = await API.get(`/announcements/community/${communityId}`);
      state.announcements = data.announcements;
      renderAnnouncements();
    } catch {}
  }
  function renderAnnouncements() {
    const box = $('#announcements');
    if (!box) return;
    if (!state.announcements.length) {
      box.innerHTML = `<div class="font-mono-label text-on-surface-variant text-mono-label">NO ACTIVE DIRECTIVES</div>`;
      return;
    }
    box.innerHTML = state.announcements.map((a) => `
      <div class="border border-outline-variant bg-surface-container-low p-4 flex flex-col gap-2">
        <div class="flex justify-between items-center">
          <span class="font-headline-md text-on-surface">${esc(a.title)}</span>
          <span class="font-mono-label text-mono-label text-primary-fixed-dim uppercase">${esc(a.status)}</span>
        </div>
        <p class="font-body-sm text-on-surface-variant">${esc(a.body)}</p>
        <div class="font-mono-label text-outline text-[10px]">BY ${esc(a.author_name)} // ${esc(a.published_at || a.created_at)}</div>
      </div>`).join('');
  }
  function openAnnouncementForm() {
    const c = state.activeCommunity;
    if (!c) return;
    const overlay = document.createElement('div');
    overlay.className = 'fixed inset-0 z-[200] bg-black/70 flex items-center justify-center p-4';
    overlay.innerHTML = `
      <div class="border border-outline-variant bg-surface-container-low w-full max-w-lg p-6">
        <div class="font-mono-label text-primary-fixed-dim mb-2">[NEW_DIRECTIVE]</div>
        <h2 class="font-headline-md text-on-surface mb-4">PUBLISH ANNOUNCEMENT</h2>
        <form id="ann-form" class="flex flex-col gap-stack-md">
          <input name="title" required maxlength="160" placeholder="Title" class="border-glow-primary bg-surface-container-lowest border border-outline-variant rounded px-3 py-2 text-on-surface font-body-sm focus:outline-none" />
          <textarea name="body" required maxlength="5000" rows="5" placeholder="Directive body..." class="border-glow-primary bg-surface-container-lowest border border-outline-variant rounded px-3 py-2 text-on-surface font-body-sm focus:outline-none"></textarea>
          <label class="font-mono-label text-on-surface-variant"><input type="checkbox" name="publish" checked /> PUBLISH NOW</label>
          <div class="flex gap-2 justify-end">
            <button type="button" id="ann-cancel" class="border border-outline-variant text-on-surface-variant font-mono-label px-4 py-2 uppercase">CANCEL</button>
            <button type="submit" class="bg-primary-container text-on-primary-container font-mono-label px-4 py-2 uppercase hover:bg-primary-fixed-dim">TRANSMIT</button>
          </div>
        </form>
      </div>`;
    document.body.appendChild(overlay);
    overlay.querySelector('#ann-cancel').addEventListener('click', () => overlay.remove());
    overlay.querySelector('#ann-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = e.target;
      try {
        await API.post('/announcements', {
          communityId: c.id, title: f.title.value.trim(), body: f.body.value.trim(),
          status: f.publish.checked ? 'published' : 'draft',
        });
        overlay.remove();
        await loadAnnouncements(c.id);
        loadNotifications();
      } catch (err) { alert(err.message); }
    });
  }


  // ---------- top bar / sidebar shared ----------
  function topBar(title) {
    return `
    <header class="flex justify-between items-center w-full px-container-margin h-14 border-b border-outline-variant bg-surface-container-low sticky top-0 z-40">
      <div class="font-mono-label text-mono-label font-black text-primary-fixed-dim uppercase tracking-widest">F_SOCIETY // SYS_KERN_v4.2</div>
      <div class="flex items-center gap-4">
        <span class="font-mono-label text-on-surface-variant hidden md:block">${esc(title || '')}</span>
        <button id="btn-notifications" class="relative text-on-surface-variant hover:text-primary-fixed-dim p-2 rounded transition-colors" title="Notifications">
          <span class="material-symbols-outlined">notifications</span>
          <span id="notif-badge" class="hidden absolute -top-0 -right-0 bg-error-container text-error text-[10px] font-mono-label px-1 rounded-full">0</span>
        </button>
        <button class="text-on-surface-variant hover:text-primary-fixed-dim p-2 rounded transition-colors" title="Security"><span class="material-symbols-outlined">security</span></button>
        <button id="btn-logout" class="bg-primary-fixed-dim text-on-primary font-mono-label px-3 py-1 rounded-sm hover:bg-primary-fixed transition-colors glitch-text">DECRYPT / EXIT</button>
      </div>
    </header>`;
  }

  function sideNav() {
    const isActive = (h) =>
      state.route === h ||
      (h === '#/communities' && state.route.startsWith('#/c/')) ||
      (h === '#/messages' && (state.route.startsWith('#/dm/') || state.route === '#/messages'));
    const item = (icon, label, hash) => `
      <a href="${hash}" class="flex flex-col items-center gap-2 p-3 rounded ${isActive(hash) ? 'text-primary-fixed-dim border-l-2 border-primary-fixed-dim bg-primary-fixed-dim/10' : 'text-on-surface-variant opacity-60 hover:bg-surface-variant/20 hover:text-primary-fixed-dim'} transition-all">
        <span class="material-symbols-outlined">${icon}</span>
        <span class="font-mono-label text-mono-label">${label}</span>
      </a>`;
    return `
    <nav class="fixed left-0 top-0 h-full w-20 flex flex-col items-center py-stack-lg border-r border-outline-variant bg-surface-container-lowest z-50 hidden md:flex">
      <div class="flex-1 flex flex-col items-center gap-stack-lg">
        <span class="material-symbols-outlined text-primary-fixed-dim text-[32px]">terminal</span>
        ${item('dashboard', 'Dashboard', '#/')}
        ${item('groups', 'Communities', '#/communities')}
        ${item('forum', 'Messages', '#/messages')}
        ${item('school', 'Learn', '#/learn')}
        ${item('emoji_events', 'CTF', '#/ctf')}
        ${hasPerm('VIEW_REPORTS') ? item('shield', 'Moderate', '#/moderation') : ''}
      </div>
      <div class="flex flex-col items-center gap-stack-lg mt-auto">
        <a href="#/profile" class="flex flex-col items-center gap-2 p-3 rounded text-on-surface-variant opacity-60 hover:text-primary-fixed-dim"><span class="material-symbols-outlined">person</span><span class="font-mono-label text-mono-label">Profile</span></a>
        <a href="#/settings" class="flex flex-col items-center gap-2 p-3 rounded text-on-surface-variant opacity-60 hover:text-primary-fixed-dim"><span class="material-symbols-outlined">settings</span></a>
      </div>
    </nav>`;
  }

  function shell(inner, title) {
    return `
    ${sideNav()}
    <div class="md:ml-20 min-h-screen flex flex-col">
      ${topBar(title)}
      <main class="flex-1 px-container-margin py-stack-md overflow-y-auto">${inner}</main>
    </div>`;
  }

  // ---------- landing ----------
  function renderLanding() {
    return `
    <header class="fixed top-0 w-full z-50 bg-surface-container-low border-b border-outline-variant flex justify-between items-center px-container-margin h-14">
      <div class="flex items-center gap-4">
        <span class="font-mono-label text-mono-label font-black text-primary-fixed-dim uppercase tracking-tighter">[SEC_CORE_01]</span>
        <div class="font-mono-label text-mono-label font-black text-primary-fixed-dim uppercase hidden md:block">F_SOCIETY // SYS_KERN_v4.2</div>
      </div>
      <nav class="hidden md:flex items-center gap-6">
        <a class="text-primary-fixed-dim font-bold text-mono-label" href="#/">HOME</a>
        <a class="text-on-surface-variant font-mono-label hover:text-primary-fixed-dim" href="#/communities">COMMUNITY</a>
        <a class="text-on-surface-variant font-mono-label hover:text-primary-fixed-dim" href="#/learn">LEARN</a>
        <a class="text-on-surface-variant font-mono-label hover:text-primary-fixed-dim" href="#/ctf">CTF</a>
      </nav>
      <div class="flex items-center gap-3">
        <a href="#/login" class="text-primary-fixed-dim hover:bg-surface-variant/30 px-3 py-1 rounded font-mono-label">LOGIN</a>
        <a href="#/register" class="bg-primary-container text-on-primary-container font-mono-label px-4 py-2 uppercase tracking-widest hover:bg-primary-fixed-dim transition-colors">JOIN</a>
      </div>
    </header>
    <main class="relative z-10 pt-20 px-container-margin md:max-w-7xl mx-auto min-h-screen flex flex-col justify-center pb-20">
      <section class="grid grid-cols-1 md:grid-cols-12 gap-gutter items-center min-h-[70vh]">
        <div class="md:col-span-7 flex flex-col gap-stack-lg stutter-in">
          <div class="inline-flex items-center gap-2 border border-outline-variant bg-surface px-3 py-1 w-max">
            <span class="w-2 h-2 bg-primary-container animate-pulse rounded-full"></span>
            <span class="font-mono-label text-primary-fixed-dim">STATUS: ONLINE // ENCRYPTED_SESSION</span>
          </div>
          <h1 class="font-headline-lg-mobile md:font-headline-lg text-on-surface leading-tight">
            <span class="block text-primary-fixed-dim font-mono-data mb-2 opacity-70">ROOT_ACCESS_GRANTED</span>F SOCIETY
          </h1>
          <p class="font-body-lg text-on-surface-variant max-w-2xl border-l-2 border-outline-variant pl-4 py-1">
            THE CYBERSECURITY COMMUNITY. Enter the grid, master the protocols, and defend the architecture. A nexus for elite infosec professionals and ethical hackers.
          </p>
          <div class="flex flex-wrap gap-4 mt-4">
            <a href="#/register" class="bg-primary-container text-on-primary-container font-mono-label px-6 py-3 uppercase tracking-widest hover:bg-primary-fixed-dim transition-colors">ENTER F SOCIETY</a>
            <a href="#/communities" class="border border-secondary-container text-secondary-container font-mono-label px-6 py-3 uppercase tracking-widest hover:bg-secondary-container/10 transition-colors">EXPLORE COMMUNITY</a>
          </div>
        </div>
        <div class="md:col-span-5 relative flex justify-center items-center min-h-[400px]">
          <div class="absolute inset-0 border border-outline-variant rounded-full opacity-20 scale-[0.8]"></div>
          <div class="absolute inset-0 border border-primary-fixed-dim border-dashed rounded-full opacity-30 animate-[spin_60s_linear_infinite] scale-[0.6]"></div>
          <div class="relative z-10 p-8 border border-outline-variant bg-surface-container-low/80 backdrop-blur-sm">
            <div class="absolute top-0 left-0 p-2 font-mono-label text-outline text-[10px]">[IMG_SRC_01]</div>
            <div class="w-64 h-64 flex items-center justify-center text-primary-fixed-dim font-headline-lg glitch-text select-none">F//S</div>
            <div class="absolute bottom-0 right-0 p-2 font-mono-label text-primary-fixed-dim text-[10px] animate-pulse">SYNCING...</div>
          </div>
        </div>
      </section>
      <section class="grid grid-cols-2 md:grid-cols-4 gap-px bg-outline-variant border-y border-outline-variant my-stack-lg">
        ${[['ACTIVE_NODES','1,337'],['THREATS_NEUTRALIZED','89.4K'],['LIVE_CTFS','42'],['UPTIME','99.999%']].map(([k,v]) => `
          <div class="bg-surface-container-low p-6 flex flex-col gap-2 group hover:bg-surface-variant/20 transition-colors">
            <span class="font-mono-label text-on-surface-variant">${k}</span>
            <span class="font-mono-data text-2xl text-primary-fixed-dim group-hover:text-white">${v}</span>
          </div>`).join('')}
      </section>
    </main>`;
  }

  // ---------- auth screens ----------
  function renderLogin(err) {
    return `
    <main class="relative z-10 pt-24 px-container-margin md:max-w-md mx-auto min-h-screen flex flex-col justify-center">
      <div class="border border-outline-variant bg-surface-container-low p-8 stutter-in">
        <div class="font-mono-label text-primary-fixed-dim mb-2">[AUTH_GATE]</div>
        <h1 class="font-headline-md text-on-surface mb-6">DECRYPT ACCESS</h1>
        ${err ? `<div class="mb-4 border border-error-container bg-error-container/20 text-error px-3 py-2 font-mono-label text-mono-label">${esc(err)}</div>` : ''}
        <form id="login-form" class="flex flex-col gap-stack-md">
          <label class="font-mono-label text-on-surface-variant">EMAIL<span class="text-error">*</span></label>
          <input name="email" type="email" required class="border-glow-primary bg-surface-container-lowest border border-outline-variant rounded px-3 py-2 text-on-surface font-body-sm focus:outline-none" placeholder="you@domain.com" />
          <label class="font-mono-label text-on-surface-variant">PASSWORD<span class="text-error">*</span></label>
          <input name="password" type="password" required class="border-glow-primary bg-surface-container-lowest border border-outline-variant rounded px-3 py-2 text-on-surface font-body-sm focus:outline-none" placeholder="••••••••" />
          <button class="bg-primary-container text-on-primary-container font-mono-label px-6 py-3 uppercase tracking-widest hover:bg-primary-fixed-dim transition-colors mt-2">DECRYPT</button>
          <div class="flex justify-between font-mono-label text-mono-label text-on-surface-variant mt-2">
            <a href="#/register" class="hover:text-primary-fixed-dim">CREATE ACCESS</a>
            <a href="#/forgot" class="hover:text-primary-fixed-dim">RESET</a>
          </div>
        </form>
      </div>
    </main>`;
  }

  function renderRegister(err) {
    const interests = ['Web Security','Linux','CTF','Ethical Hacking','Network Security','OSINT','Forensics','Red Team','Blue Team','Cryptography','Reverse Engineering','Malware Analysis'];
    const exp = ['beginner','intermediate','advanced','elite'];
    return `
    <main class="relative z-10 pt-24 px-container-margin md:max-w-2xl mx-auto min-h-screen flex flex-col justify-center">
      <div class="border border-outline-variant bg-surface-container-low p-8 stutter-in">
        <div class="font-mono-label text-primary-fixed-dim mb-2">[IDENTITY_SETUP]</div>
        <h1 class="font-headline-md text-on-surface mb-6">ESTABLISH IDENTITY</h1>
        ${err ? `<div class="mb-4 border border-error-container bg-error-container/20 text-error px-3 py-2 font-mono-label text-mono-label">${esc(err)}</div>` : ''}
        <form id="register-form" class="flex flex-col gap-stack-md">
          <div class="grid grid-cols-1 md:grid-cols-2 gap-stack-md">
            <div><label class="font-mono-label text-on-surface-variant">EMAIL</label><input name="email" type="email" required class="border-glow-primary w-full bg-surface-container-lowest border border-outline-variant rounded px-3 py-2 text-on-surface font-body-sm focus:outline-none" /></div>
            <div><label class="font-mono-label text-on-surface-variant">USERNAME</label><input name="username" required pattern="[a-zA-Z0-9_]{3,20}" class="border-glow-primary w-full bg-surface-container-lowest border border-outline-variant rounded px-3 py-2 text-on-surface font-body-sm focus:outline-none" placeholder="3-20 chars" /></div>
            <div><label class="font-mono-label text-on-surface-variant">DISPLAY NAME</label><input name="displayName" required class="border-glow-primary w-full bg-surface-container-lowest border border-outline-variant rounded px-3 py-2 text-on-surface font-body-sm focus:outline-none" /></div>
            <div><label class="font-mono-label text-on-surface-variant">EXPERIENCE</label><select name="experienceLevel" class="border-glow-primary w-full bg-surface-container-lowest border border-outline-variant rounded px-3 py-2 text-on-surface font-body-sm focus:outline-none">${exp.map(e=>`<option value="${e}">${e}</option>`).join('')}</select></div>
            <div><label class="font-mono-label text-on-surface-variant">PASSWORD</label><input name="password" type="password" required minlength="8" class="border-glow-primary w-full bg-surface-container-lowest border border-outline-variant rounded px-3 py-2 text-on-surface font-body-sm focus:outline-none" /></div>
            <div><label class="font-mono-label text-on-surface-variant">CONFIRM</label><input name="confirmPassword" type="password" required minlength="8" class="border-glow-primary w-full bg-surface-container-lowest border border-outline-variant rounded px-3 py-2 text-on-surface font-body-sm focus:outline-none" /></div>
          </div>
          <div><label class="font-mono-label text-on-surface-variant">INTERESTS</label><div class="flex flex-wrap gap-2 mt-2" id="interest-tags">${interests.map(i=>`<button type="button" data-interest="${i}" class="interest-btn border border-outline-variant rounded-full px-3 py-1 font-mono-label text-mono-label text-on-surface-variant hover:text-primary-fixed-dim hover:border-primary-fixed-dim transition-colors">${i}</button>`).join('')}</div></div>
          <button class="bg-primary-container text-on-primary-container font-mono-label px-6 py-3 uppercase tracking-widest hover:bg-primary-fixed-dim transition-colors mt-2">INITIALIZE</button>
          <div class="font-mono-label text-mono-label text-on-surface-variant mt-2">Already decrypted? <a href="#/login" class="text-primary-fixed-dim hover:underline">LOGIN</a></div>
        </form>
      </div>
    </main>`;
  }

  // ---------- communities / channels / messages ----------
  async function loadCommunities() {
    const data = await API.get('/communities');
    state.communities = data.communities;
  }

  function communityCard(c) {
    return `
    <button data-community="${c.id}" class="community-btn text-left border border-outline-variant bg-surface-container-low hover:bg-surface-variant/20 hover:border-primary-fixed-dim transition-colors p-5 flex flex-col gap-2">
      <div class="flex items-center justify-between">
        <span class="font-headline-md text-on-surface">${esc(c.name)}</span>
        ${c.joined ? '<span class="font-mono-label text-primary-fixed-dim text-mono-label">JOINED</span>' : '<span class="font-mono-label text-on-surface-variant text-mono-label">OPEN</span>'}
      </div>
      <p class="font-body-sm text-on-surface-variant">${esc(c.description || '')}</p>
      <div class="font-mono-label text-mono-label text-outline mt-2">[ ${c.member_count} NODES ]</div>
    </button>`;
  }

  function renderCommunities() {
    const grid = state.communities.length
      ? `<div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-gutter">${state.communities.map(communityCard).join('')}</div>`
      : `<div class="font-mono-label text-on-surface-variant">No communities yet. Join F SOCIETY to begin.</div>`;
    return shell(`
      <div class="font-mono-label text-primary-fixed-dim mb-4">[COMMUNITY_EXPLORER]</div>
      <h1 class="font-headline-md text-on-surface mb-6">COMMUNITIES</h1>
      ${grid}
    `, 'COMMUNITIES');
  }

  function renderChannel() {
    const c = state.activeChannel;
    const msgs = state.messages.map(renderMessage).join('') ||
      '<div class="font-mono-label text-on-surface-variant p-4">No transmissions yet. Initialize the channel.</div>';
    return shell(`
      <div class="flex flex-col h-[calc(100vh-3.5rem)]">
        <div class="flex items-center justify-between border-b border-outline-variant py-3">
          <div>
            <div class="font-mono-label text-on-surface-variant text-mono-label">${esc(state.activeCommunity.name)} /</div>
            <div class="font-headline-md text-on-surface">#${esc(c.name)}</div>
          </div>
      <div class="font-mono-label text-mono-label text-primary-fixed-dim">${esc(c.kind || 'text').toUpperCase()} CHANNEL</div>
    </div>
    <div class="px-container-margin flex gap-3 flex-wrap">
      <button data-report data-report-type="channel" data-report-id="${c.id}" data-report-label="CHANNEL" class="font-mono-label text-outline text-[10px] hover:text-primary-fixed-dim uppercase">REPORT CHANNEL</button>
      <button data-report data-report-type="community" data-report-id="${state.activeCommunity.id}" data-report-label="COMMUNITY" class="font-mono-label text-outline text-[10px] hover:text-primary-fixed-dim uppercase">REPORT COMMUNITY</button>
    </div>
    <div class="border-b border-outline-variant px-container-margin py-2 flex items-center gap-3 flex-wrap">
      <button id="btn-announcements" class="font-mono-label text-mono-label text-primary-fixed-dim uppercase hover:underline">DIRECTIVES</button>
      ${hasPerm('POST_ANNOUNCEMENTS') ? '<button id="btn-new-ann" class="font-mono-label text-mono-label border border-outline-variant px-2 py-0.5 hover:text-primary-fixed-dim hover:border-primary-fixed-dim transition-colors">+ NEW</button>' : ''}
    </div>
    <div id="announcements" class="hidden flex-col gap-2 px-container-margin py-3 border-b border-outline-variant"></div>
    ${restrictionBannerHtml()}
    <div id="messages" class="flex-1 overflow-y-auto py-4 flex flex-col gap-3">${msgs}</div>
        <form id="message-form" class="flex flex-col gap-2 border-t border-outline-variant pt-3">
          <div id="attach-preview" class="hidden"></div>
          <div class="flex gap-2">
            <button type="button" id="attach-btn" class="text-on-surface-variant hover:text-primary-fixed-dim p-2 rounded transition-colors" title="Attach image or document" ${isRestricted() ? 'disabled style="display:none"' : ''}><span class="material-symbols-outlined">attach_file</span></button>
            <input id="file-input" type="file" accept="image/jpeg,image/png,image/webp,image/gif,application/pdf,text/plain,text/csv" class="hidden" />
            <input id="message-input" autocomplete="off" ${isRestricted() ? 'disabled' : ''} class="border-glow-primary flex-1 bg-surface-container-lowest border border-outline-variant rounded px-3 py-2 text-on-surface font-body-sm focus:outline-none" placeholder="${isRestricted() ? 'TRANSMISSION DISABLED' : 'Transmit to #' + esc(c.name) + '...'}" />
            <button class="bg-primary-container text-on-primary-container font-mono-label px-4 py-2 uppercase hover:bg-primary-fixed-dim transition-colors" ${isRestricted() ? 'disabled' : ''}>SEND</button>
          </div>
        </form>
      </div>
    `, '#' + c.name);
  }

  function renderReactions(reactions) {
    if (!reactions) return '';
    return Object.entries(reactions).map(([emoji, r]) =>
      `<button class="react-btn ${r.mine ? 'bg-primary-fixed-dim/20 border-primary-fixed-dim' : 'border-outline-variant'} border rounded px-2 py-0.5 font-mono-label text-mono-label text-on-surface-variant hover:text-primary-fixed-dim" data-emoji="${emoji}">${emoji} ${r.count}</button>`
    ).join('');
  }

  function renderMessage(m) {
    const mine = state.user && m.authorId === state.user.id;
    return `
    <div id="msg-${m.id}" class="flex flex-col gap-1 ${mine ? 'items-end' : 'items-start'}">
      <div class="font-mono-label text-mono-label text-on-surface-variant">${esc(m.authorName)} <span class="text-outline">${esc(m.createdAt)}</span></div>
       <div class="max-w-[80%] border border-outline-variant rounded px-3 py-2 ${m.deleted ? 'opacity-40 italic' : 'bg-surface-container-low'} text-on-surface font-body-sm">${m.deleted ? '[ deleted ]' : esc(m.body)}</div>
      ${renderAttachment(m.attachment)}
      <div class="msg-reactions flex gap-1">${renderReactions(m.reactions)}</div>
      ${msgActions(m, false)}
    </div>`;
  }

  function appendMessage(m) {
    const box = $('#messages');
    const empty = box && box.querySelector('.font-mono-label');
    if (box) box.insertAdjacentHTML('beforeend', renderMessage(m));
  }
  function scrollMessages() { const b = $('#messages'); if (b) b.scrollTop = b.scrollHeight; }

  // ---------- attachments ----------
  function formatBytes(n) {
    if (!n && n !== 0) return '';
    const u = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(n) / Math.log(1024));
    return (n / Math.pow(1024, i)).toFixed(i ? 1 : 0) + ' ' + u[i];
  }

  function renderAttachment(att) {
    if (!att) return '';
    const isImg = (att.mimeType || '').startsWith('image/');
    if (isImg) {
      return `<div class="mt-1">
        <img src="${esc(att.url)}" alt="${esc(att.originalFilename || 'image')}" class="max-w-[280px] max-h-[280px] rounded border border-outline-variant cursor-pointer hover:opacity-90 transition-opacity" data-view="${esc(att.url)}" />
        <div class="font-mono-label text-outline text-[10px] mt-1">${esc(att.originalFilename || 'image')} · ${formatBytes(att.size)} · <a class="text-primary-fixed-dim hover:underline" href="${esc(att.url)}" download="${esc(att.originalFilename || 'file')}" target="_blank">DOWNLOAD</a></div>
      </div>`;
    }
    return `<div class="mt-1 flex items-center gap-3 border border-outline-variant bg-surface-container-lowest rounded p-2 max-w-[320px]">
      <span class="material-symbols-outlined text-3xl text-on-surface-variant">description</span>
      <div class="flex-1 min-w-0">
        <div class="font-body-sm text-on-surface truncate">${esc(att.originalFilename || 'file')}</div>
        <div class="font-mono-label text-outline text-[10px]">${formatBytes(att.size)}</div>
      </div>
      <a href="${esc(att.url)}" download="${esc(att.originalFilename || 'file')}" target="_blank" class="bg-primary-container text-on-primary-container font-mono-label text-[10px] px-2 py-1 uppercase hover:bg-primary-fixed-dim whitespace-nowrap">DOWNLOAD</a>
    </div>`;
  }

  function openImagePreview(url) {
    const overlay = document.createElement('div');
    overlay.className = 'fixed inset-0 z-[200] bg-black/80 flex items-center justify-center p-4';
    overlay.innerHTML = `<img src="${esc(url)}" class="max-w-[90vw] max-h-[90vh] rounded border border-outline-variant" /><button class="absolute top-4 right-4 text-white text-3xl" id="iv-close">×</button>`;
    document.body.appendChild(overlay);
    overlay.addEventListener('click', () => overlay.remove());
  }
  window.__fsViewImage = openImagePreview;

  function uploadFile(file, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/uploads');
      xhr.withCredentials = true;
      xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100)); };
      xhr.onload = () => {
        let d = null; try { d = JSON.parse(xhr.responseText); } catch {}
        if (xhr.status >= 200 && xhr.status < 300) resolve(d); else reject(new Error((d && d.error) || ('HTTP ' + xhr.status)));
      };
      xhr.onerror = () => reject(new Error('Network error'));
      const fd = new FormData();
      fd.append('file', file);
      xhr.send(fd);
    });
  }

  function renderAttachPreview(preview, file, localUrl, onRemove) {
    const isImg = file.type.startsWith('image/');
    const thumb = isImg
      ? `<img src="${localUrl}" class="w-16 h-16 object-cover rounded border border-outline-variant" />`
      : `<span class="material-symbols-outlined text-3xl text-on-surface-variant">description</span>`;
    preview.innerHTML = `
      <div class="flex items-center gap-3 border border-outline-variant bg-surface-container-lowest rounded p-2">
        ${thumb}
        <div class="flex-1 min-w-0">
          <div class="font-body-sm text-on-surface truncate">${esc(file.name)}</div>
          <div class="font-mono-label text-outline text-[10px]">${formatBytes(file.size)}</div>
          <div id="att-status" class="font-mono-label text-mono-label text-primary-fixed-dim text-[10px]">READY</div>
          <div class="h-1 w-full bg-surface-container rounded mt-1 overflow-hidden"><div id="att-bar" class="h-full bg-primary-container" style="width:0%"></div></div>
        </div>
        <button type="button" id="att-remove" class="text-on-surface-variant hover:text-error p-1" title="Remove"><span class="material-symbols-outlined">close</span></button>
      </div>`;
    preview.classList.remove('hidden');
    preview.querySelector('#att-remove').addEventListener('click', onRemove);
  }

  function resetComposer(form) {
    const preview = form.querySelector('#attach-preview');
    if (preview) { preview.classList.add('hidden'); preview.innerHTML = ''; }
    const input = form.querySelector('#file-input');
    if (input) input.value = '';
    form._att = null;
  }

  function setupComposer(form) {
    if (!form) return;
    const btn = form.querySelector('#attach-btn');
    const input = form.querySelector('#file-input');
    const preview = form.querySelector('#attach-preview');
    if (!btn || !input || !preview) return;
    form._att = null;
    btn.addEventListener('click', () => input.click());
    input.addEventListener('change', async () => {
      const file = input.files && input.files[0];
      if (!file) return;
      const okType = /^(image\/(jpeg|png|webp|gif)|application\/pdf|text\/(plain|csv))$/.test(file.type);
      if (!okType) { alert('Unsupported file type. Allowed: images (JPG/PNG/WebP/GIF), PDF, TXT, CSV.'); input.value = ''; return; }
      const max = file.type.startsWith('image/') ? 8 * 1024 * 1024 : 15 * 1024 * 1024;
      if (file.size > max) { alert('File exceeds the size limit.'); input.value = ''; return; }
      const localUrl = URL.createObjectURL(file);
      renderAttachPreview(preview, file, localUrl, () => { URL.revokeObjectURL(localUrl); resetComposer(form); });
      const statusEl = preview.querySelector('#att-status');
      const barEl = preview.querySelector('#att-bar');
      try {
        const data = await uploadFile(file, (pct) => { if (barEl) barEl.style.width = pct + '%'; });
        form._att = { id: data.id, name: data.originalFilename, size: data.size, url: data.url, mime: data.mimeType };
        statusEl.textContent = '✓ UPLOAD COMPLETE';
        barEl.style.width = '100%';
      } catch (e) {
        statusEl.textContent = '✗ UPLOAD FAILED';
        form._att = null;
      }
    });
  }

  // ---------- presence ----------
  function presenceClass(st) {
    return { online: 'bg-primary-container', away: 'bg-tertiary-container', dnd: 'bg-error', offline: 'bg-outline' }[st] || 'bg-outline';
  }
  function presenceDot(userId, size) {
    const s = size || 'w-2.5 h-2.5';
    const st = state.presence[userId] || 'offline';
    return `<span class="inline-block rounded-full ${s} ${presenceClass(st)}" data-presence="${userId}" data-psize="${s}" title="${esc(st)}"></span>`;
  }
  function updatePresence(userId, st) {
    state.presence[userId] = st;
    document.querySelectorAll('[data-presence]').forEach((el) => {
      if (parseInt(el.dataset.presence, 10) !== userId) return;
      const size = el.dataset.psize || 'w-2.5 h-2.5';
      el.className = `inline-block rounded-full ${size} ${presenceClass(st)}`;
      el.title = st;
    });
  }

  // ---------- direct messages ----------
  async function loadConversations() {
    const d = await API.get('/conversations');
    state.conversations = d.conversations;
  }

  async function refreshConversations() {
    try {
      await loadConversations();
      const list = $('#dm-list');
      if (list) list.innerHTML = state.conversations.length
        ? state.conversations.map(renderConvItem).join('')
        : '<div class="font-mono-label text-on-surface-variant p-4">No conversations yet. Start one with + NEW.</div>';
    } catch {}
  }

  function renderConvItem(c) {
    const active = state.activeConversation && state.activeConversation.id === c.id;
    return `
    <a href="#/dm/${c.id}" class="flex items-center gap-3 p-3 border-b border-outline-variant ${active ? 'bg-primary-fixed-dim/10' : 'hover:bg-surface-variant/20'} transition-colors">
      ${presenceDot(c.other.id)}
      <div class="flex-1 min-w-0">
        <div class="font-body-sm text-on-surface truncate">${esc(c.other.displayName || c.other.username)}</div>
        <div class="font-mono-label text-outline text-[10px] truncate">${c.lastMessage ? esc(c.lastMessage.body) : 'No transmissions'}</div>
      </div>
      ${c.unread ? `<span class="bg-primary-container text-on-primary-container font-mono-label text-[10px] px-1.5 rounded-full">${c.unread > 9 ? '9+' : c.unread}</span>` : ''}
    </a>`;
  }

  function renderConversationPane() {
    const c = state.activeConversation;
    const msgs = state.dmMessages.map(renderDMMessage).join('') ||
      '<div class="font-mono-label text-on-surface-variant p-4">No transmissions yet. Initialize the link.</div>';
    return `
      <div class="flex items-center gap-3 border-b border-outline-variant py-3 px-4">
        ${presenceDot(c.other.id, 'w-3 h-3')}
        <div class="font-headline-md text-on-surface">${esc(c.other.displayName || c.other.username)}</div>
        <button id="dm-back" class="md:hidden ml-auto font-mono-label text-mono-label text-on-surface-variant">BACK</button>
      </div>
      <div id="dm-typing" class="px-4 py-1 h-5 font-mono-label text-outline text-[10px]"></div>
      ${restrictionBannerHtml()}
      <div id="dm-messages" class="flex-1 overflow-y-auto py-4 px-4 flex flex-col gap-3">${msgs}</div>
      <form id="dm-form" class="flex flex-col gap-2 border-t border-outline-variant pt-3 px-4 pb-3">
        <div id="attach-preview" class="hidden"></div>
        <div class="flex gap-2">
          <button type="button" id="attach-btn" class="text-on-surface-variant hover:text-primary-fixed-dim p-2 rounded transition-colors" title="Attach image or document" ${isRestricted() ? 'disabled style="display:none"' : ''}><span class="material-symbols-outlined">attach_file</span></button>
          <input id="file-input" type="file" accept="image/jpeg,image/png,image/webp,image/gif,application/pdf,text/plain,text/csv" class="hidden" />
          <input id="dm-input" autocomplete="off" ${isRestricted() ? 'disabled' : ''} class="border-glow-primary flex-1 bg-surface-container-lowest border border-outline-variant rounded px-3 py-2 text-on-surface font-body-sm focus:outline-none" placeholder="${isRestricted() ? 'TRANSMISSION DISABLED' : 'Transmit to @' + esc(c.other.username) + '...'}" />
          <button class="bg-primary-container text-on-primary-container font-mono-label px-4 py-2 uppercase hover:bg-primary-fixed-dim transition-colors" ${isRestricted() ? 'disabled' : ''}>SEND</button>
        </div>
      </form>`;
  }

  function renderDMWorkspace() {
    const list = state.conversations.length
      ? state.conversations.map(renderConvItem).join('')
      : '<div class="font-mono-label text-on-surface-variant p-4">No conversations yet. Start one with + NEW.</div>';
    const pane = state.activeConversation
      ? renderConversationPane()
      : '<div class="flex-1 flex items-center justify-center font-mono-label text-on-surface-variant">SELECT A TRANSMISSION OR START A NEW ONE</div>';
    return shell(`
      <div class="flex h-[calc(100vh-3.5rem)] -mx-container-margin -my-stack-md">
        <aside class="w-72 shrink-0 border-r border-outline-variant flex flex-col">
          <div class="flex items-center justify-between p-3 border-b border-outline-variant">
            <span class="font-mono-label text-primary-fixed-dim uppercase">DM_LINKS</span>
            <button id="btn-new-dm" class="font-mono-label text-mono-label border border-outline-variant px-2 py-0.5 hover:text-primary-fixed-dim hover:border-primary-fixed-dim transition-colors">+ NEW</button>
          </div>
          <div id="dm-list" class="flex-1 overflow-y-auto">${list}</div>
        </aside>
        <section id="dm-pane" class="flex-1 flex flex-col min-w-0">${pane}</section>
      </div>
    `, 'MESSAGES');
  }

  function renderDMMessage(m) {
    const mine = state.user && m.authorId === state.user.id;
    return `
    <div id="dm-${m.id}" class="flex flex-col gap-1 ${mine ? 'items-end' : 'items-start'}">
      <div class="font-mono-label text-mono-label text-on-surface-variant">${esc(m.authorName)} <span class="text-outline">${esc(m.createdAt)}</span></div>
      <div class="dm-body max-w-[80%] border border-outline-variant rounded px-3 py-2 ${m.deleted ? 'opacity-40 italic' : 'bg-surface-container-low'} text-on-surface font-body-sm">${m.deleted ? '[ deleted ]' : esc(m.body)}</div>
      ${renderAttachment(m.attachment)}
      <div class="msg-reactions flex gap-1">${renderReactions(m.reactions)}</div>
      ${msgActions(m, true)}
    </div>`;
  }

  function appendDMMessage(m) { const box = $('#dm-messages'); if (box) box.insertAdjacentHTML('beforeend', renderDMMessage(m)); }
  function scrollDM() { const b = $('#dm-messages'); if (b) b.scrollTop = b.scrollHeight; }

  function showTyping(userId, typing) {
    const el = $('#dm-typing');
    if (!el) return;
    if (typing && state.activeConversation && state.activeConversation.other.id === userId) {
      el.textContent = `${esc(state.activeConversation.other.displayName || state.activeConversation.other.username)} is typing…`;
    } else {
      el.textContent = '';
    }
  }

  async function openConversationMessages(id) {
    const data = await API.get(`/conversations/${id}/messages?limit=50`);
    state.dmMessages = data.messages;
    const pane = $('#dm-pane');
    if (!pane) return;
    pane.innerHTML = renderConversationPane();
    bindDMForm();
    scrollDM();
    await API.post(`/conversations/${id}/read`).catch(() => {});
    joinConvRealtime(id);
    refreshConversations();
  }

  async function openDMWorkspace(selectedId) {
    const prev = state.activeConversation;
    await loadConversations();
    const next = selectedId ? state.conversations.find((c) => c.id === selectedId) || null : null;
    if (prev && (!next || prev.id !== next.id)) leaveConvRealtime(prev.id);
    state.activeConversation = next;
    state.dmMessages = [];
    $('#app').innerHTML = renderDMWorkspace();
    bindDMWorkspace();
    if (state.activeConversation) await openConversationMessages(state.activeConversation.id);
  }

  function bindDMWorkspace() {
    const nb = $('#btn-new-dm');
    if (nb) nb.addEventListener('click', openNewDMModal);
    const back = $('#dm-back');
    if (back) back.addEventListener('click', () => { location.hash = '#/messages'; });
    bindDMForm();
  }

  function bindDMForm() {
    const form = $('#dm-form');
    if (!form) return;
    const input = $('#dm-input');
    setupComposer(form);
    let typingTimer = null;
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const body = input.value.trim();
      if (!body && !(form._att && form._att.id)) return;
      input.value = '';
      const payload = { body };
      if (form._att && form._att.id) payload.attachmentId = form._att.id;
      const attId = form._att && form._att.id;
      try {
        const r = await API.post(`/conversations/${state.activeConversation.id}/messages`, payload);
        resetComposer(form);
        if (!rt.connected) {
          state.dmMessages.push(r.message);
          appendDMMessage(r.message);
          scrollDM();
        }
      } catch (err) { console.error(err); resetComposer(form); void attId; }
    });
    input.addEventListener('input', () => {
      if (!state.activeConversation) return;
      wsSend({ type: 'dm:typing', conversationId: state.activeConversation.id, typing: true });
      clearTimeout(typingTimer);
      typingTimer = setTimeout(() => wsSend({ type: 'dm:typing', conversationId: state.activeConversation.id, typing: false }), 1500);
    });
    document.querySelectorAll('.react-btn').forEach((b) => b.addEventListener('click', reactHandler));
  }

  function openNewDMModal() {
    const overlay = document.createElement('div');
    overlay.className = 'fixed inset-0 z-[200] bg-black/70 flex items-center justify-center p-4';
    overlay.innerHTML = `
      <div class="border border-outline-variant bg-surface-container-low w-full max-w-md p-6">
        <div class="font-mono-label text-primary-fixed-dim mb-2">[NEW_LINK]</div>
        <h2 class="font-headline-md text-on-surface mb-4">START A DIRECT MESSAGE</h2>
        <input id="dm-search" placeholder="Search members by name..." class="border-glow-primary w-full bg-surface-container-lowest border border-outline-variant rounded px-3 py-2 text-on-surface font-body-sm focus:outline-none mb-3" />
        <div id="dm-results" class="flex flex-col gap-1 max-h-72 overflow-y-auto"></div>
        <div class="flex justify-end mt-4"><button id="dm-cancel" class="border border-outline-variant text-on-surface-variant font-mono-label px-4 py-2 uppercase hover:text-primary-fixed-dim">CANCEL</button></div>
      </div>`;
    document.body.appendChild(overlay);
    overlay.querySelector('#dm-cancel').addEventListener('click', () => overlay.remove());
    const results = overlay.querySelector('#dm-results');
    const search = overlay.querySelector('#dm-search');
    let t;
    search.addEventListener('input', () => {
      clearTimeout(t);
      t = setTimeout(async () => {
        const q = search.value.trim();
        if (q.length < 2) { results.innerHTML = ''; return; }
        try {
          const d = await API.get('/users/search?q=' + encodeURIComponent(q));
          results.innerHTML = d.users.length
            ? d.users.map((u) => `
              <button class="dm-user-btn flex items-center gap-3 p-2 hover:bg-surface-variant/20 text-left" data-uid="${u.id}">
                ${presenceDot(u.id)}
                <span class="font-body-sm text-on-surface">${esc(u.displayName || u.username)}</span>
                <span class="font-mono-label text-outline text-[10px]">@${esc(u.username)}</span>
              </button>`).join('')
            : '<div class="font-mono-label text-on-surface-variant p-2">NO MATCHES</div>';
        } catch {}
      }, 300);
    });
    results.addEventListener('click', async (e) => {
      const b = e.target.closest('.dm-user-btn');
      if (!b) return;
      try {
        const d = await API.post('/conversations', { targetUserId: parseInt(b.dataset.uid, 10) });
        overlay.remove();
        location.hash = '#/dm/' + d.conversation.id;
      } catch (err) { alert(err.message); }
    });
    setTimeout(() => search.focus(), 50);
  }

  // ---------- account restriction banner ----------
  function restrictionBannerHtml() {
    const s = state.user && state.user.status;
    if (s === 'muted') return `<div class="border border-error-container bg-error-container/10 text-error font-mono-label text-mono-label px-3 py-2 mb-2">YOUR ACCOUNT IS MUTED — TRANSMISSION DISABLED</div>`;
    if (s === 'suspended') return `<div class="border border-error-container bg-error-container/10 text-error font-mono-label text-mono-label px-3 py-2 mb-2">YOUR ACCOUNT IS SUSPENDED</div>`;
    return '';
  }
  const isRestricted = () => state.user && state.user.status !== 'active';

  // ---------- reporting ----------
  async function openReportModal(targetType, targetId, label) {
    const overlay = document.createElement('div');
    overlay.className = 'fixed inset-0 z-[200] bg-black/70 flex items-center justify-center p-4';
    const reasons = ['SPAM', 'HARASSMENT', 'INAPPROPRIATE_CONTENT', 'SCAM', 'ABUSE', 'OTHER'];
    overlay.innerHTML = `
      <div class="border border-outline-variant bg-surface-container-low w-full max-w-md p-6">
        <div class="font-mono-label text-primary-fixed-dim mb-2">[REPORT]</div>
        <h2 class="font-headline-md text-on-surface mb-1">REPORT ${esc(label)}</h2>
        <p class="font-mono-label text-outline text-[10px] mb-4">REPORTED CONTENT IS REVIEWED BY MODERATORS. DO NOT USE FOR EMERGENCIES.</p>
        <form id="report-form" class="flex flex-col gap-stack-md">
          <select name="reason" class="border-glow-primary bg-surface-container-lowest border border-outline-variant rounded px-3 py-2 text-on-surface font-body-sm focus:outline-none">
            ${reasons.map((r) => `<option value="${r}">${r}</option>`).join('')}
          </select>
          <textarea name="description" maxlength="2000" rows="4" placeholder="Optional details..." class="border-glow-primary bg-surface-container-lowest border border-outline-variant rounded px-3 py-2 text-on-surface font-body-sm focus:outline-none"></textarea>
          <div class="flex gap-2 justify-end">
            <button type="button" id="report-cancel" class="border border-outline-variant text-on-surface-variant font-mono-label px-4 py-2 uppercase">CANCEL</button>
            <button type="submit" class="bg-error-container text-on-error font-mono-label px-4 py-2 uppercase hover:bg-error transition-colors">SUBMIT REPORT</button>
          </div>
        </form>
      </div>`;
    document.body.appendChild(overlay);
    overlay.querySelector('#report-cancel').addEventListener('click', () => overlay.remove());
    overlay.querySelector('#report-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = e.target;
      try {
        await API.post('/moderation/reports', { targetType, targetId, reason: f.reason.value, description: f.description.value.trim() });
        overlay.remove();
        alert('Report submitted. Thank you.');
      } catch (err) {
        if (err.status === 409) { overlay.remove(); alert('You have already reported this item.'); }
        else alert(err.message);
      }
    });
  }

  async function deleteMessage(id) {
    if (!confirm('Delete this message?')) return;
    try {
      await API.del('/messages/' + id);
      const ch = document.getElementById('msg-' + id); if (ch) ch.remove();
      const dm = document.getElementById('dm-' + id);
      if (dm) { const b = dm.querySelector('.dm-body'); if (b) { b.textContent = '[ deleted ]'; b.classList.add('opacity-40', 'italic'); } }
    } catch (err) { alert(err.message); }
  }

  function msgActions(m, isDM) {
    const mine = state.user && m.authorId === state.user.id;
    const canDel = mine || hasPerm('MODERATE_CONTENT');
    const canRep = !mine;
    if (!canDel && !canRep) return '';
    return `<div class="flex gap-3 mt-1">
      ${canDel ? `<button type="button" data-delmsg="${m.id}" class="font-mono-label text-outline text-[10px] hover:text-error uppercase">DELETE</button>` : ''}
      ${canRep ? `<button type="button" data-report data-report-type="message" data-report-id="${m.id}" data-report-label="MESSAGE" class="font-mono-label text-outline text-[10px] hover:text-primary-fixed-dim uppercase">REPORT</button>` : ''}
    </div>`;
  }

  // ---------- global search palette (CTRL+K) ----------
  let searchPaletteOpen = false;
  async function gotoCommunity(id) {
    try {
      const d = await API.get('/communities/' + id + '/channels');
      if (d.channels[0]) location.hash = `#/c/${id}/${d.channels[0].id}`;
      else location.hash = '#/communities';
    } catch { location.hash = '#/communities'; }
  }
  function renderSearchResults(d) {
    const sec = (title, arr, emptyMsg, render) => {
      if (!arr || !arr.length) return `<div class="px-3 py-2"><span class="font-mono-label text-outline text-[10px] uppercase">${title}</span><div class="font-mono-label text-on-surface-variant text-[11px] pl-2">${emptyMsg}</div></div>`;
      return `<div class="px-3 py-2"><span class="font-mono-label text-primary-fixed-dim text-[10px] uppercase">${title}</span>${arr.map(render).join('')}</div>`;
    };
    const any = (d.users && d.users.length) || (d.communities && d.communities.length) || (d.channels && d.channels.length) || (d.messages && d.messages.length);
    if (!any) return `<div class="font-mono-label text-on-surface-variant p-4 text-center">No results found.</div>`;
    return [
      sec('USERS', d.users, 'No matching users', (u) => `
        <button data-nav="user" data-id="${u.id}" class="w-full flex items-center gap-3 p-2 hover:bg-surface-variant/20 text-left rounded">
          ${presenceDot(u.id)}
          <div class="flex-1 min-w-0"><div class="font-body-sm text-on-surface truncate">${esc(u.displayName || u.username)}</div><div class="font-mono-label text-outline text-[10px]">@${esc(u.username)}</div></div>
        </button>`),
      sec('COMMUNITIES', d.communities, 'No matching communities', (c) => `
        <button data-nav="community" data-id="${c.id}" class="w-full flex items-start gap-3 p-2 hover:bg-surface-variant/20 text-left rounded">
          <span class="material-symbols-outlined text-on-surface-variant">groups</span>
          <div class="flex-1 min-w-0"><div class="font-body-sm text-on-surface truncate">${esc(c.name)}</div><div class="font-mono-label text-outline text-[10px]">${esc(c.description || '')} · ${c.memberCount} nodes</div></div>
        </button>`),
      sec('CHANNELS', d.channels, 'No matching channels', (ch) => `
        <button data-nav="channel" data-community="${ch.communityId}" data-id="${ch.id}" class="w-full flex items-start gap-3 p-2 hover:bg-surface-variant/20 text-left rounded">
          <span class="material-symbols-outlined text-on-surface-variant">forum</span>
          <div class="flex-1 min-w-0"><div class="font-body-sm text-on-surface truncate">#${esc(ch.name)}</div><div class="font-mono-label text-outline text-[10px]">${esc(ch.communityName || '')}</div></div>
        </button>`),
      sec('MESSAGES', d.messages, 'No matching messages', (m) => `
        <button data-nav="message" data-community="${m.communityId}" data-channel="${m.channelId}" data-id="${m.id}" class="w-full flex items-start gap-3 p-2 hover:bg-surface-variant/20 text-left rounded">
          <span class="material-symbols-outlined text-on-surface-variant">chat</span>
          <div class="flex-1 min-w-0"><div class="font-body-sm text-on-surface truncate">${esc(m.preview || '')}</div><div class="font-mono-label text-outline text-[10px]">#${esc(m.channelName)} · ${esc(m.authorName)}</div></div>
        </button>`),
    ].join('');
  }
  function openSearchPalette() {
    if (searchPaletteOpen) return;
    searchPaletteOpen = true;
    const overlay = document.createElement('div');
    overlay.className = 'fixed inset-0 z-[200] bg-black/70 flex items-start justify-center p-4 pt-[10vh]';
    overlay.innerHTML = `
      <div class="w-full max-w-2xl border border-outline-variant bg-surface-container-low shadow-xl">
        <div class="flex items-center gap-3 px-4 py-3 border-b border-outline-variant">
          <span class="material-symbols-outlined text-on-surface-variant">search</span>
          <input id="sp-input" autocomplete="off" class="flex-1 bg-transparent text-on-surface font-body-sm focus:outline-none" placeholder="Search F SOCIETY — users, communities, channels, messages..." />
          <span class="font-mono-label text-outline text-[10px]">ESC</span>
        </div>
        <div id="sp-results" class="max-h-[60vh] overflow-y-auto p-2"><div class="font-mono-label text-on-surface-variant p-4 text-center">Type at least 2 characters to search.</div></div>
      </div>`;
    document.body.appendChild(overlay);
    const input = overlay.querySelector('#sp-input');
    const results = overlay.querySelector('#sp-results');
    const close = () => { searchPaletteOpen = false; overlay.remove(); };
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    input.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } });
    let t;
    input.addEventListener('input', () => {
      clearTimeout(t);
      const q = input.value.trim();
      if (q.length < 2) { results.innerHTML = `<div class="font-mono-label text-on-surface-variant p-4 text-center">Type at least 2 characters to search.</div>`; return; }
      results.innerHTML = `<div class="font-mono-label text-on-surface-variant p-4 text-center">Searching...</div>`;
      t = setTimeout(async () => {
        try {
          const d = await API.get('/search?q=' + encodeURIComponent(q));
          results.innerHTML = renderSearchResults(d);
        } catch {
          results.innerHTML = `<div class="font-mono-label text-error p-4 text-center">Network error. Try again.</div>`;
        }
      }, 250);
    });
    results.addEventListener('click', (e) => {
      const a = e.target.closest('[data-nav]');
      if (!a) return;
      close();
      const nav = a.dataset.nav;
      if (nav === 'user') location.hash = '#/profile/' + a.dataset.id;
      else if (nav === 'community') gotoCommunity(a.dataset.id);
      else if (nav === 'channel') location.hash = `#/c/${a.dataset.community}/${a.dataset.id}`;
      else if (nav === 'message') { state.pendingScrollMessageId = parseInt(a.dataset.id, 10); location.hash = `#/c/${a.dataset.community}/${a.dataset.channel}`; }
    });
    setTimeout(() => input.focus(), 30);
  }

  // ---------- profile (self + others) ----------
  async function openProfile(userId) {
    let data;
    if (userId) {
      try { data = await API.get('/users/' + userId); }
      catch { $('#app').innerHTML = shell(`<div class="font-mono-label text-error p-8">USER NOT FOUND</div>`, 'PROFILE'); return; }
    } else {
      if (!state.user) { location.hash = '#/'; return; }
      data = {
        id: state.user.id, username: state.user.username,
        displayName: (state.profile && state.profile.displayName) || state.user.username,
        status: state.user.status, bio: state.profile && state.profile.bio,
        experienceLevel: state.profile && state.profile.experienceLevel,
        interests: (state.profile && state.profile.interests) || [], self: true,
      };
    }
    const isSelf = !userId || userId === state.user.id;
    const inner = `
      <div class="font-mono-label text-primary-fixed-dim mb-2">[USER_DOSSIER]</div>
      <div class="border border-outline-variant bg-surface-container-low p-6 flex flex-col gap-3 max-w-2xl">
        <div class="flex items-center gap-4">
          ${presenceDot(data.id, 'w-3 h-3')}
          <div><div class="font-headline-md text-on-surface">${esc(data.displayName || data.username)}</div><div class="font-mono-label text-outline text-[10px]">@${esc(data.username)} · ${esc(data.status || 'active')}</div></div>
        </div>
        ${data.bio ? `<p class="font-body-sm text-on-surface-variant">${esc(data.bio)}</p>` : ''}
        ${data.experienceLevel ? `<div class="font-mono-label text-on-surface-variant text-[10px] uppercase">EXP: ${esc(data.experienceLevel)}</div>` : ''}
        ${data.interests && data.interests.length ? `<div class="flex flex-wrap gap-2">${data.interests.map((i) => `<span class="border border-outline-variant rounded-full px-3 py-1 font-mono-label text-mono-label text-on-surface-variant">${esc(i)}</span>`).join('')}</div>` : ''}
        <div class="flex gap-2 mt-2">
          ${!isSelf && data.sharesCommunity ? `<button id="profile-dm" class="bg-primary-container text-on-primary-container font-mono-label px-4 py-2 uppercase hover:bg-primary-fixed-dim">SEND MESSAGE</button>` : ''}
          ${!isSelf ? `<button data-report data-report-type="user" data-report-id="${data.id}" data-report-label="USER" class="border border-outline-variant text-on-surface-variant font-mono-label px-4 py-2 uppercase hover:text-error">REPORT</button>` : ''}
        </div>
      </div>`;
    $('#app').innerHTML = shell(inner, 'PROFILE');
    if (!isSelf && data.sharesCommunity) {
      const b = $('#profile-dm');
      if (b) b.addEventListener('click', async () => {
        try { const d = await API.post('/conversations', { targetUserId: data.id }); location.hash = '#/dm/' + d.conversation.id; }
        catch (err) { alert(err.message); }
      });
    }
  }

  // ---------- moderation console ----------
  async function openModeration() {
    if (!hasPerm('VIEW_REPORTS')) { location.hash = '#/communities'; return; }
    $('#app').innerHTML = shell(`<div id="mod-root" class="font-mono-label text-on-surface-variant p-8">LOADING MODERATION CONSOLE...</div>`, 'MODERATION');
    await loadModeration();
  }
  async function loadModeration() {
    const root = $('#mod-root'); if (!root) return;
    let html = `<div class="font-mono-label text-primary-fixed-dim mb-2">[MODERATION_CONSOLE]</div><h1 class="font-headline-md text-on-surface mb-4">MODERATION QUEUE</h1>`;
    html += `<div class="flex gap-2 mb-4" id="mod-tabs">${['open', 'reviewing', 'resolved', 'dismissed'].map((s) => `<button data-status="${s}" class="mod-tab font-mono-label text-mono-label border border-outline-variant px-3 py-1 uppercase ${s === 'open' ? 'text-primary-fixed-dim border-primary-fixed-dim' : ''}">${s}</button>`).join('')}</div>`;
    html += `<div id="mod-reports" class="flex flex-col gap-2 mb-8"></div>`;
    if (hasPerm('MANAGE_USERS')) {
      html += `<div class="font-mono-label text-primary-fixed-dim mb-2 mt-4">[USER_MODIFICATION]</div>
        <div class="border border-outline-variant bg-surface-container-low p-4 flex flex-col gap-3">
          <input id="mod-user-search" placeholder="Search member by name..." class="border-glow-primary bg-surface-container-lowest border border-outline-variant rounded px-3 py-2 text-on-surface font-body-sm focus:outline-none" />
          <div id="mod-user-result"></div>
        </div>`;
    }
    if (hasPerm('VIEW_AUDIT_LOGS')) {
      html += `<div class="font-mono-label text-primary-fixed-dim mb-2 mt-6">[AUDIT_LOG]</div><div id="mod-audit" class="flex flex-col gap-1"></div>`;
    }
    root.innerHTML = html;
    bindModeration();
    await refreshReports('open');
    if (hasPerm('VIEW_AUDIT_LOGS')) refreshAudit();
  }
  async function refreshReports(status) {
    const box = $('#mod-reports'); if (!box) return;
    box.innerHTML = `<div class="font-mono-label text-on-surface-variant p-2">Loading...</div>`;
    const d = await API.get('/moderation/reports?status=' + status);
    if (!d.reports.length) { box.innerHTML = `<div class="font-mono-label text-on-surface-variant p-2">No ${status} reports.</div>`; return; }
    box.innerHTML = d.reports.map(reportRow).join('');
  }
  function reportRow(r) {
    const t = r.target || {};
    let label = r.targetType;
    if (r.targetType === 'message') label = `Message #${r.targetId} in #${esc(t.channelName || '')} by ${esc(t.authorName || '')}`;
    else if (r.targetType === 'user') label = `User @${esc(t.username || r.targetId)}`;
    else if (r.targetType === 'community') label = `Community ${esc(t.name || r.targetId)}`;
    else if (r.targetType === 'channel') label = `Channel #${esc(t.name || r.targetId)} (${esc(t.communityName || '')})`;
    const canResolve = hasPerm('RESOLVE_REPORTS') && r.status !== 'resolved' && r.status !== 'dismissed';
    return `<div class="border border-outline-variant bg-surface-container-low p-3 flex flex-col gap-1">
      <div class="flex justify-between items-center">
        <span class="font-mono-label text-mono-label text-primary-fixed-dim uppercase">${r.targetType}</span>
        <span class="font-mono-label text-[10px] uppercase ${r.status === 'open' ? 'text-primary-fixed-dim' : r.status === 'resolved' ? 'text-secondary-container' : 'text-outline'}">${r.status}</span>
      </div>
      <div class="font-body-sm text-on-surface">${esc(label)}</div>
      <div class="font-mono-label text-outline text-[10px]">Reason: ${esc(r.reason)} · Reporter: ${esc((r.reporter && r.reporter.username) || '?')} · ${esc(r.createdAt)}</div>
      ${r.description ? `<div class="font-body-sm text-on-surface-variant text-[12px]">${esc(r.description)}</div>` : ''}
      <div class="flex gap-2 mt-1">
        <button data-report-view="${r.id}" class="border border-outline-variant text-on-surface-variant font-mono-label text-[10px] px-2 py-1 uppercase hover:text-primary-fixed-dim">VIEW</button>
        ${r.status === 'open' ? `<button data-report-claim="${r.id}" class="border border-outline-variant text-on-surface-variant font-mono-label text-[10px] px-2 py-1 uppercase hover:text-primary-fixed-dim">CLAIM</button>` : ''}
        ${canResolve ? `<button data-report-resolve="${r.id}" class="bg-secondary-container text-on-secondary-container font-mono-label text-[10px] px-2 py-1 uppercase">RESOLVE</button>` : ''}
        ${canResolve ? `<button data-report-dismiss="${r.id}" class="border border-error-container text-error font-mono-label text-[10px] px-2 py-1 uppercase">DISMISS</button>` : ''}
      </div>
    </div>`;
  }
  function bindModeration() {
    const tabs = $('#mod-tabs');
    if (tabs) tabs.addEventListener('click', (e) => {
      const b = e.target.closest('.mod-tab'); if (!b) return;
      document.querySelectorAll('.mod-tab').forEach((x) => x.classList.remove('text-primary-fixed-dim', 'border-primary-fixed-dim'));
      b.classList.add('text-primary-fixed-dim', 'border-primary-fixed-dim');
      refreshReports(b.dataset.status);
    });
    const box = $('#mod-reports');
    if (box) box.addEventListener('click', async (e) => {
      const cur = () => document.querySelector('.mod-tab.text-primary-fixed-dim')?.dataset.status || 'open';
      const v = e.target.closest('[data-report-view]'); if (v) { openReportDetail(parseInt(v.dataset.reportView, 10)); return; }
      const c = e.target.closest('[data-report-claim]'); if (c) { await API.post('/moderation/reports/' + c.dataset.reportClaim + '/claim').catch(() => {}); refreshReports(cur()); return; }
      const rs = e.target.closest('[data-report-resolve]'); if (rs) { if (confirm('Resolve this report?')) { await API.post('/moderation/reports/' + rs.dataset.reportResolve + '/resolve').catch(() => {}); refreshReports(cur()); } return; }
      const dm = e.target.closest('[data-report-dismiss]'); if (dm) { if (confirm('Dismiss this report?')) { await API.post('/moderation/reports/' + dm.dataset.reportDismiss + '/dismiss').catch(() => {}); refreshReports(cur()); } return; }
    });
    const us = $('#mod-user-search');
    if (us) { let t; us.addEventListener('input', () => { clearTimeout(t); const q = us.value.trim(); if (q.length < 2) { const r = $('#mod-user-result'); if (r) r.innerHTML = ''; return; } t = setTimeout(async () => { try { const d = await API.get('/users/search?q=' + encodeURIComponent(q)); const r = $('#mod-user-result'); if (!r) return; r.innerHTML = d.users.length ? d.users.map((u) => `<div class="flex items-center justify-between border border-outline-variant p-2 mt-2"><div class="flex items-center gap-2">${presenceDot(u.id)}<span class="font-body-sm text-on-surface">${esc(u.displayName || u.username)}</span><span class="font-mono-label text-outline text-[10px]">@${esc(u.username)}</span></div><button data-mod-user="${u.id}" data-mod-name="${esc(u.username)}" class="bg-primary-container text-on-primary-container font-mono-label text-[10px] px-2 py-1 uppercase">ACTIONS</button></div>`).join('') : '<div class="font-mono-label text-on-surface-variant p-2">No users.</div>'; } catch {} }, 300); }); }
    const ur = $('#mod-user-result');
    if (ur) ur.addEventListener('click', (e) => { const b = e.target.closest('[data-mod-user]'); if (!b) return; openUserModeration(parseInt(b.dataset.modUser, 10), b.dataset.modName); });
  }
  async function openReportDetail(id) {
    let r;
    try { r = await API.get('/moderation/reports/' + id); } catch { return; }
    const t = r.target || {};
    const overlay = document.createElement('div');
    overlay.className = 'fixed inset-0 z-[200] bg-black/70 flex items-center justify-center p-4';
    const canResolve = hasPerm('RESOLVE_REPORTS') && r.status !== 'resolved' && r.status !== 'dismissed';
    overlay.innerHTML = `<div class="border border-outline-variant bg-surface-container-low w-full max-w-lg p-6">
      <div class="font-mono-label text-primary-fixed-dim mb-2">[REPORT #${r.id}]</div>
      <div class="font-mono-label text-outline text-[10px] mb-3">${r.targetType} · ${esc(r.reason)} · ${esc(r.status)}</div>
      <div class="font-body-sm text-on-surface mb-2">${esc((r.target && JSON.stringify(r.target)) || '')}</div>
      ${r.description ? `<div class="font-body-sm text-on-surface-variant mb-2">${esc(r.description)}</div>` : ''}
      <div class="font-mono-label text-outline text-[10px] mb-4">Reporter: ${esc((r.reporter && r.reporter.username) || '?')} · ${esc(r.createdAt)}</div>
      ${canResolve ? `<div class="flex gap-2 justify-end"><button id="rd-resolve" class="bg-secondary-container text-on-secondary-container font-mono-label px-4 py-2 uppercase">RESOLVE</button><button id="rd-dismiss" class="border border-error-container text-error font-mono-label px-4 py-2 uppercase">DISMISS</button></div>` : ''}
      <div class="flex justify-end mt-2"><button id="rd-close" class="border border-outline-variant text-on-surface-variant font-mono-label px-4 py-2 uppercase">CLOSE</button></div>
    </div>`;
    document.body.appendChild(overlay);
    overlay.querySelector('#rd-close').addEventListener('click', () => overlay.remove());
    if (canResolve) {
      overlay.querySelector('#rd-resolve').addEventListener('click', async () => { await API.post('/moderation/reports/' + id + '/resolve').catch(() => {}); overlay.remove(); refreshReports(document.querySelector('.mod-tab.text-primary-fixed-dim')?.dataset.status || 'open'); });
      overlay.querySelector('#rd-dismiss').addEventListener('click', async () => { await API.post('/moderation/reports/' + id + '/dismiss').catch(() => {}); overlay.remove(); refreshReports(document.querySelector('.mod-tab.text-primary-fixed-dim')?.dataset.status || 'open'); });
    }
  }
  async function openUserModeration(userId, name) {
    let st = '';
    try { const u = await API.get('/users/' + userId); st = u.status; } catch {}
    const overlay = document.createElement('div');
    overlay.className = 'fixed inset-0 z-[200] bg-black/70 flex items-center justify-center p-4';
    overlay.innerHTML = `<div class="border border-outline-variant bg-surface-container-low w-full max-w-md p-6">
      <div class="font-mono-label text-primary-fixed-dim mb-2">[USER_MODIFICATION]</div>
      <h2 class="font-headline-md text-on-surface mb-1">@${esc(name)}</h2>
      <div class="font-mono-label text-outline text-[10px] mb-4">CURRENT STATUS: ${esc(st)}</div>
      <form id="mod-action-form" class="flex flex-col gap-stack-md">
        <select name="action" class="border-glow-primary bg-surface-container-lowest border border-outline-variant rounded px-3 py-2 text-on-surface font-body-sm">${['warn', 'mute', 'suspend', 'ban', 'unmute', 'unsuspend', 'unban'].map((a) => `<option value="${a}">${a.toUpperCase()}</option>`).join('')}</select>
        <input name="duration" type="number" min="1" max="${24 * 365}" placeholder="Duration (hours, for MUTE/SUSPEND)" class="border-glow-primary bg-surface-container-lowest border border-outline-variant rounded px-3 py-2 text-on-surface font-body-sm" />
        <textarea name="reason" maxlength="1000" rows="3" placeholder="Reason (recorded)..." class="border-glow-primary bg-surface-container-lowest border border-outline-variant rounded px-3 py-2 text-on-surface font-body-sm"></textarea>
        <div class="flex gap-2 justify-end">
          <button type="button" id="mod-cancel" class="border border-outline-variant text-on-surface-variant font-mono-label px-4 py-2 uppercase">CANCEL</button>
          <button type="submit" class="bg-error-container text-on-error font-mono-label px-4 py-2 uppercase">APPLY</button>
        </div>
      </form></div>`;
    document.body.appendChild(overlay);
    overlay.querySelector('#mod-cancel').addEventListener('click', () => overlay.remove());
    overlay.querySelector('#mod-action-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = e.target;
      try {
        await API.post('/moderation/users/' + userId + '/moderate', { action: f.action.value, reason: f.reason.value.trim(), durationHours: f.duration.value ? parseInt(f.duration.value, 10) : undefined });
        overlay.remove();
        alert('Action applied.');
        refreshReports(document.querySelector('.mod-tab.text-primary-fixed-dim')?.dataset.status || 'open');
      } catch (err) { alert(err.message); }
    });
  }
  async function refreshAudit() {
    const box = $('#mod-audit'); if (!box) return;
    const d = await API.get('/moderation/audit?limit=100');
    if (!d.logs.length) { box.innerHTML = '<div class="font-mono-label text-on-surface-variant p-2">No audit entries.</div>'; return; }
    box.innerHTML = d.logs.map((l) => `<div class="border-b border-outline-variant py-1 flex justify-between gap-2"><span class="font-mono-label text-mono-label text-primary-fixed-dim uppercase whitespace-nowrap">${esc(l.action)}</span><span class="font-body-sm text-on-surface-variant truncate">${esc((l.metadata && JSON.stringify(l.metadata)) || '')}</span><span class="font-mono-label text-outline text-[10px] whitespace-nowrap">${esc(l.actor || '?')} · ${esc(l.createdAt)}</span></div>`).join('');
  }

  // ---------- routing ----------
  async function router() {
    const hash = location.hash || '#/';
    state.route = hash;
    const app = $('#app');

    if (hash === '#/' || hash === '#/communities' || hash === '#/learn' || hash === '#/ctf' || hash === '#/profile' || hash === '#/settings' || hash === '#/messages' || hash === '#/moderation' || hash.startsWith('#/dm/') || hash.startsWith('#/profile/')) {
      if (!state.user) { renderAuthGate(hash); return; }
    }

    // Leave any open DM socket subscription when navigating away from the DM area.
    if (state.activeConversation && !hash.startsWith('#/dm/') && hash !== '#/messages') {
      leaveConvRealtime(state.activeConversation.id);
      state.activeConversation = null;
    }

    try {
      if (hash === '#/') { app.innerHTML = renderLanding(); }
      else if (hash === '#/login') app.innerHTML = renderLogin();
      else if (hash === '#/register') app.innerHTML = renderRegister();
      else if (hash === '#/communities') {
        app.innerHTML = renderCommunities();
        bindCommunityCards();
      }
      else if (hash.startsWith('#/c/')) {
        const parts = hash.split('/'); // #/c/:communityId/:channelId
        const communityId = parseInt(parts[2], 10);
        const channelId = parseInt(parts[3], 10);
        await openChannel(communityId, channelId);
      }
      else if (hash === '#/messages') {
        await openDMWorkspace(null);
      }
      else if (hash.startsWith('#/dm/')) {
        const id = parseInt(hash.split('/')[2], 10);
        await openDMWorkspace(id);
      }
      else if (hash === '#/profile' || hash.startsWith('#/profile/')) {
        const id = hash.startsWith('#/profile/') ? parseInt(hash.split('/')[2], 10) : null;
        await openProfile(id);
      }
      else if (hash === '#/moderation') {
        await openModeration();
      }
      else { app.innerHTML = renderLanding(); }
      bindCommon();
    } catch (e) {
      app.innerHTML = `<div class="p-8 font-mono-label text-error">ERROR: ${esc(e.message)}</div>`;
    }
  }

  function renderAuthGate(hash) {
    // Not logged in but tried a protected route -> go to landing.
    if (hash !== '#/') location.hash = '#/';
    else $('#app').innerHTML = renderLanding();
  }

  async function openChannel(communityId, channelId) {
    const comm = state.communities.find((c) => c.id === communityId) || (await API.get('/communities')).communities.find((c) => c.id === communityId);
    const chans = await API.get(`/communities/${communityId}/channels`);
    state.activeCommunity = comm;
    state.activeChannel = chans.channels.find((c) => c.id === channelId) || chans.channels[0];
    const data = await API.get(`/channels/${state.activeChannel.id}/messages?limit=50`);
    state.messages = data.messages;
    $('#app').innerHTML = renderChannel();
    bindMessageForm();
    loadAnnouncements(state.activeCommunity.id);
    scrollMessages();
    if (state.pendingScrollMessageId) {
      const node = document.getElementById('msg-' + state.pendingScrollMessageId);
      if (node) { node.scrollIntoView({ block: 'center' }); node.classList.add('ring-2', 'ring-primary-fixed-dim'); }
      state.pendingScrollMessageId = null;
    }
    joinChannelRealtime(state.activeChannel.id);
    loadNotifications();
    loadAnnouncements(communityId);
    const ba = $('#btn-announcements'); if (ba) ba.addEventListener('click', () => $('#announcements').classList.toggle('hidden'));
    const bna = $('#btn-new-ann'); if (bna) bna.addEventListener('click', openAnnouncementForm);
  }

  // ---------- bindings ----------
  function bindCommon() {
    const lb = $('#btn-logout'); if (lb) lb.addEventListener('click', logout);
    const nb = $('#btn-notifications'); if (nb) nb.addEventListener('click', toggleNotifications);
    // Delegated image preview for attachments.
    document.addEventListener('click', (e) => {
      const t = e.target.closest('[data-view]');
      if (t) { e.preventDefault(); openImagePreview(t.dataset.view); return; }
      const rep = e.target.closest('[data-report]');
      if (rep) { e.preventDefault(); openReportModal(rep.dataset.reportType, parseInt(rep.dataset.reportId, 10), rep.dataset.reportLabel || rep.dataset.reportType); return; }
      const del = e.target.closest('[data-delmsg]');
      if (del) { e.preventDefault(); deleteMessage(parseInt(del.dataset.delmsg, 10)); return; }
    });
    const lf = $('#login-form');
    if (lf) lf.addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        await API.post('/auth/login', { email: lf.email.value.trim(), password: lf.password.value });
        await bootstrapUser();
        location.hash = '#/communities';
      } catch (err) { $('#app').innerHTML = renderLogin(err.message); bindCommon(); }
    });
    const rf = $('#register-form');
    if (rf) {
      const selected = new Set();
      $('#interest-tags').addEventListener('click', (e) => {
        const b = e.target.closest('.interest-btn'); if (!b) return;
        const v = b.dataset.interest;
        if (selected.has(v)) { selected.delete(v); b.classList.remove('text-primary-fixed-dim','border-primary-fixed-dim'); b.classList.add('text-on-surface-variant'); }
        else { selected.add(v); b.classList.add('text-primary-fixed-dim','border-primary-fixed-dim'); b.classList.remove('text-on-surface-variant'); }
      });
      rf.addEventListener('submit', async (e) => {
        e.preventDefault();
        const payload = {
          email: rf.email.value.trim(), username: rf.username.value.trim(), displayName: rf.displayName.value.trim(),
          password: rf.password.value, confirmPassword: rf.confirmPassword.value,
          experienceLevel: rf.experienceLevel.value, interests: Array.from(selected),
        };
        try {
          const r = await API.post('/auth/register', payload);
          if (r.devVerifyToken) {
            await API.get('/auth/verify-email?token=' + encodeURIComponent(r.devVerifyToken));
          }
          await bootstrapUser();
          location.hash = '#/communities';
        } catch (err) { $('#app').innerHTML = renderRegister(err.message); bindCommon(); }
      });
    }
  }

  function bindCommunityCards() {
    document.querySelectorAll('.community-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = parseInt(btn.dataset.community, 10);
        const comm = state.communities.find((c) => c.id === id);
        if (!comm.joined) { await API.post(`/communities/${id}/join`); comm.joined = 1; }
        const chans = await API.get(`/communities/${id}/channels`);
        if (chans.channels[0]) location.hash = `#/c/${id}/${chans.channels[0].id}`;
      });
    });
  }

  function bindMessageForm() {
    const form = $('#message-form');
    if (!form) return;
    setupComposer(form);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const input = $('#message-input');
      const body = input.value.trim();
      if (!body && !(form._att && form._att.id)) return;
      input.value = '';
      const payload = { body };
      if (form._att && form._att.id) payload.attachmentId = form._att.id;
      try {
        const r = await API.post(`/channels/${state.activeChannel.id}/messages`, payload);
        resetComposer(form);
        if (!rt.connected) {
          state.messages.push(r.message);
          appendMessage(r.message);
          scrollMessages();
        }
      } catch (err) { console.error(err); resetComposer(form); }
    });
    document.querySelectorAll('.react-btn').forEach((b) => b.addEventListener('click', reactHandler));
    const annBtn = $('#btn-announcements');
    if (annBtn) annBtn.addEventListener('click', () => {
      const box = $('#announcements');
      if (box) box.classList.toggle('hidden');
    });
    const newAnn = $('#btn-new-ann');
    if (newAnn) newAnn.addEventListener('click', openAnnouncementForm);
  }

  async function reactHandler(e) {
    const btn = e.target.closest('.react-btn'); if (!btn) return;
    const msgEl = btn.closest('[id]');
    if (!msgEl) return;
    const msgId = parseInt(msgEl.id.replace(/^(msg|dm)-/, ''), 10);
    try { await API.post(`/messages/${msgId}/react`, { emoji: btn.dataset.emoji }); } catch {}
  }

  async function logout() {
    try { await API.post('/auth/logout'); } catch {}
    state.user = null; disconnectRealtime();
    location.hash = '#/';
    router();
  }

  async function bootstrapUser() {
    const me = await API.get('/auth/me');
    state.user = me.user; state.profile = me.profile; state.roles = me.roles; state.permissions = me.permissions;
    connectRealtime();
    loadNotifications();
  }

  // ---------- boot ----------
  document.body.insertAdjacentHTML('beforeend',
    '<div id="notif-panel" class="hidden fixed top-14 right-4 w-80 max-h-[70vh] overflow-y-auto bg-surface-container-low border border-outline-variant z-[150] shadow-xl"></div>');
  window.addEventListener('hashchange', router);
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      if (state.user) openSearchPalette();
    }
  });
  (async () => {
    try {
      await bootstrapUser();
    } catch {
      state.user = null;
    }
    await router();
    if (state.user && (state.route === '#/' || state.route === '#/login' || state.route === '#/register')) {
      location.hash = '#/communities';
    }
  })();
})();
