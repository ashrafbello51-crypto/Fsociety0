// server/seed.js
const db = require('./db');
const auth = require('./auth');
const config = require('./config');
const schema = require('./schema');

const PERMISSIONS = [
  'MANAGE_USERS', 'MANAGE_COMMUNITIES', 'MANAGE_CHANNELS', 'POST_ANNOUNCEMENTS',
  'MANAGE_LEARNING', 'MANAGE_LABS', 'MANAGE_CTF', 'MODERATE_CONTENT',
  'MANAGE_ROLES', 'VIEW_AUDIT_LOGS', 'MANAGE_PLATFORM',
  'VIEW_REPORTS', 'RESOLVE_REPORTS',
];

const ROLE_PERMS = {
  SUPER_ADMIN: PERMISSIONS,
  ADMIN: PERMISSIONS,
  MODERATOR: ['MODERATE_CONTENT', 'VIEW_REPORTS', 'RESOLVE_REPORTS', 'MANAGE_USERS', 'POST_ANNOUNCEMENTS'],
  INSTRUCTOR: ['MANAGE_LEARNING', 'MANAGE_LABS'],
  CTF_ORGANIZER: ['MANAGE_CTF'],
  MEMBER: [],
};

const DEFAULT_CHANNELS = [
  'GENERAL', 'ANNOUNCEMENTS', 'CYBERSECURITY', 'ETHICAL-HACKING', 'WEB-SECURITY',
  'NETWORKING', 'LINUX', 'CTF', 'OSINT', 'DIGITAL-FORENSICS', 'RED-TEAM', 'BLUE-TEAM',
];

const DEFAULT_ADMIN_PASSWORD = 'F_Society#2024!';

async function seed() {
  // Ensure the schema exists (idempotent — all statements use IF NOT EXISTS).
  await schema.initSchema(db);

  await db.tx(async (d) => {
    // Permissions
    const permIds = {};
    for (const p of PERMISSIONS) {
      await d.prepare(`INSERT OR IGNORE INTO permissions (name, description) VALUES (?, ?)`).run(p, p);
      permIds[p] = (await d.prepare(`SELECT id FROM permissions WHERE name = ?`).get(p)).id;
    }

    // Roles
    const roleIds = {};
    for (const role of Object.keys(ROLE_PERMS)) {
      await d.prepare(`INSERT OR IGNORE INTO roles (name, display_name, system) VALUES (?, ?, 1)`).run(role, role.replace('_', ' ').toLowerCase());
      const rid = (await d.prepare(`SELECT id FROM roles WHERE name = ?`).get(role)).id;
      roleIds[role] = rid;
      for (const perm of ROLE_PERMS[role]) {
        await d.prepare(`INSERT OR IGNORE INTO role_permissions (role_id, permission_id) VALUES (?, ?)`).run(rid, permIds[perm]);
      }
    }

    // Admin user
    const adminEmail = (process.env.SEED_ADMIN_EMAIL || 'root@f.society').toLowerCase();
    const adminPass = process.env.SEED_ADMIN_PASSWORD || DEFAULT_ADMIN_PASSWORD;
    let admin = await d.prepare(`SELECT id FROM users WHERE email = ?`).get(adminEmail);
    let adminId;
    if (!admin) {
      const hash = auth.hashPassword(adminPass);
      const r = await d.prepare(`INSERT INTO users (email, username, password_hash, display_name, email_verified) VALUES (?, ?, ?, ?, 1)`).run(
        adminEmail, 'overseer', hash, 'Overseer'
      );
      adminId = r.lastInsertRowid;
      await d.prepare(`INSERT INTO profiles (user_id, experience_level, interests, xp) VALUES (?, 'elite', '["Web Security","CTF","Red Team"]', 0)`).run(adminId);
      await d.prepare(`INSERT INTO presence (user_id, state) VALUES (?, 'online')`).run(adminId);
    } else {
      adminId = admin.id;
    }
    const saRole = roleIds.SUPER_ADMIN;
    await d.prepare(`INSERT OR IGNORE INTO user_roles (user_id, role_id) VALUES (?, ?)`).run(adminId, saRole);

    // Default community + channels
    let comm = await d.prepare(`SELECT id FROM communities WHERE slug = 'f-society'`).get();
    let commId;
    if (!comm) {
      const r = await d.prepare(`INSERT INTO communities (name, slug, description, owner_id) VALUES (?, ?, ?, ?)`).run(
        'F SOCIETY', 'f-society', 'The cybersecurity community. Master the protocols. Defend the architecture.', adminId
      );
      commId = r.lastInsertRowid;
      await d.prepare(`INSERT INTO community_members (community_id, user_id, role) VALUES (?, ?, 'owner')`).run(commId, adminId);
    } else {
      commId = comm.id;
    }
    for (let i = 0; i < DEFAULT_CHANNELS.length; i++) {
      const name = DEFAULT_CHANNELS[i];
      const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
      const kind = name === 'ANNOUNCEMENTS' ? 'announcement' : 'text';
      await d.prepare(`INSERT OR IGNORE INTO channels (community_id, name, slug, kind, position) VALUES (?, ?, ?, ?, ?)`).run(commId, name, slug, kind, i);
    }

    // Challenge categories
    const CATS = ['Web', 'Linux', 'Networking', 'Forensics', 'OSINT', 'Cryptography', 'Reverse Engineering'];
    for (const c of CATS) {
      await d.prepare(`INSERT OR IGNORE INTO challenge_categories (name, slug) VALUES (?, ?)`).run(c, c.toLowerCase().replace(/\s+/g, '-'));
    }

    // Sample learning path
    let path = await d.prepare(`SELECT id FROM learning_paths WHERE slug = 'web-security'`).get();
    if (!path) {
      const r = await d.prepare(`INSERT INTO learning_paths (title, slug, description, difficulty, xp_reward) VALUES (?, ?, ?, ?, ?)`).run(
        'Web Security', 'web-security', 'Foundations of securing web applications.', 'beginner', 500
      );
      const pathId = r.lastInsertRowid;
      const m = await d.prepare(`INSERT INTO learning_modules (path_id, title, position, xp_reward) VALUES (?, ?, ?, ?)`).run(pathId, 'OWASP Top 10', 1, 200);
      const modId = m.lastInsertRowid;
      await d.prepare(`INSERT INTO lessons (module_id, title, position, content, xp_reward) VALUES (?, ?, ?, ?, ?)`).run(
        modId, 'Intro to XSS', 1, 'Cross-site scripting fundamentals for authorized testing.', 50
      );
    }

    console.log('Seed complete.');
    console.log(`Admin login: ${adminEmail} / ${adminPass}`);
  });
  if (config.env === 'production' && (process.env.SEED_ADMIN_PASSWORD || DEFAULT_ADMIN_PASSWORD) === DEFAULT_ADMIN_PASSWORD) {
    console.warn('[SECURITY] Using the default seed admin password. Set SEED_ADMIN_PASSWORD in production.');
  }
}

if (require.main === module) {
  seed().catch((e) => { console.error(e); process.exit(1); });
}

module.exports = { seed, PERMISSIONS, ROLE_PERMS };
