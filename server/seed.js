// server/seed.js
const db = require('./db');
const auth = require('./auth');
const config = require('./config');

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

function seed() {
  db.exec('BEGIN');
  try {
    // Permissions
    const permIds = {};
    PERMISSIONS.forEach((p) => {
      db.prepare(`INSERT OR IGNORE INTO permissions (name, description) VALUES (?, ?)`).run(p, p);
      permIds[p] = db.prepare(`SELECT id FROM permissions WHERE name = ?`).get(p).id;
    });

    // Roles
    const roleIds = {};
    Object.keys(ROLE_PERMS).forEach((role) => {
      db.prepare(`INSERT OR IGNORE INTO roles (name, display_name, system) VALUES (?, ?, 1)`).run(role, role.replace('_', ' ').toLowerCase());
      const rid = db.prepare(`SELECT id FROM roles WHERE name = ?`).get(role).id;
      roleIds[role] = rid;
      ROLE_PERMS[role].forEach((perm) => {
        db.prepare(`INSERT OR IGNORE INTO role_permissions (role_id, permission_id) VALUES (?, ?)`).run(rid, permIds[perm]);
      });
    });

    // Admin user
    const adminEmail = (process.env.SEED_ADMIN_EMAIL || 'root@f.society').toLowerCase();
    const adminPass = process.env.SEED_ADMIN_PASSWORD || 'F_Society#2024!';
    let admin = db.prepare(`SELECT id FROM users WHERE email = ?`).get(adminEmail);
    let adminId;
    if (!admin) {
      const hash = auth.hashPassword(adminPass);
      const r = db.prepare(`INSERT INTO users (email, username, password_hash, display_name, email_verified) VALUES (?, ?, ?, ?, 1)`).run(
        adminEmail, 'overseer', hash, 'Overseer'
      );
      adminId = r.lastInsertRowid;
      db.prepare(`INSERT INTO profiles (user_id, experience_level, interests, xp) VALUES (?, 'elite', '["Web Security","CTF","Red Team"]', 0)`).run(adminId);
      db.prepare(`INSERT INTO presence (user_id, state) VALUES (?, 'online')`).run(adminId);
    } else {
      adminId = admin.id;
    }
    const saRole = roleIds.SUPER_ADMIN;
    db.prepare(`INSERT OR IGNORE INTO user_roles (user_id, role_id) VALUES (?, ?)`).run(adminId, saRole);

    // Default community + channels
    let comm = db.prepare(`SELECT id FROM communities WHERE slug = 'f-society'`).get();
    let commId;
    if (!comm) {
      const r = db.prepare(`INSERT INTO communities (name, slug, description, owner_id) VALUES (?, ?, ?, ?)`).run(
        'F SOCIETY', 'f-society', 'The cybersecurity community. Master the protocols. Defend the architecture.', adminId
      );
      commId = r.lastInsertRowid;
      db.prepare(`INSERT INTO community_members (community_id, user_id, role) VALUES (?, ?, 'owner')`).run(commId, adminId);
    } else {
      commId = comm.id;
    }
    DEFAULT_CHANNELS.forEach((name, i) => {
      const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
      const kind = name === 'ANNOUNCEMENTS' ? 'announcement' : 'text';
      db.prepare(`INSERT OR IGNORE INTO channels (community_id, name, slug, kind, position) VALUES (?, ?, ?, ?, ?)`).run(commId, name, slug, kind, i);
    });

    // Challenge categories
    const CATS = ['Web', 'Linux', 'Networking', 'Forensics', 'OSINT', 'Cryptography', 'Reverse Engineering'];
    CATS.forEach((c) => db.prepare(`INSERT OR IGNORE INTO challenge_categories (name, slug) VALUES (?, ?)`).run(c, c.toLowerCase().replace(/\s+/g, '-')));

    // Sample learning path
    let path = db.prepare(`SELECT id FROM learning_paths WHERE slug = 'web-security'`).get();
    if (!path) {
      const r = db.prepare(`INSERT INTO learning_paths (title, slug, description, difficulty, xp_reward) VALUES (?, ?, ?, ?, ?)`).run(
        'Web Security', 'web-security', 'Foundations of securing web applications.', 'beginner', 500
      );
      const pathId = r.lastInsertRowid;
      const m = db.prepare(`INSERT INTO learning_modules (path_id, title, position, xp_reward) VALUES (?, ?, ?, ?)`).run(pathId, 'OWASP Top 10', 1, 200);
      const modId = m.lastInsertRowid;
      db.prepare(`INSERT INTO lessons (module_id, title, position, content, xp_reward) VALUES (?, ?, ?, ?, ?)`).run(
        modId, 'Intro to XSS', 1, 'Cross-site scripting fundamentals for authorized testing.', 50
      );
    }

    console.log('Seed complete.');
    console.log(`Admin login: ${adminEmail} / ${adminPass}`);
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch {}
    throw e;
  }
}

if (require.main === module) {
  seed();
}

module.exports = { seed, PERMISSIONS, ROLE_PERMS };
