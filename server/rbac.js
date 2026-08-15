// server/rbac.js
const db = require('./db');

async function getRoles(userId) {
  const rows = await db
    .prepare(
      `SELECT r.name, r.display_name FROM roles r
       JOIN user_roles ur ON ur.role_id = r.id
       WHERE ur.user_id = ?`
    )
    .all(userId);
  return rows.map((r) => r.name);
}

async function getPermissions(userId) {
  const rows = await db
    .prepare(
      `SELECT DISTINCT p.name FROM permissions p
       JOIN role_permissions rp ON rp.permission_id = p.id
       JOIN user_roles ur ON ur.role_id = rp.role_id
       WHERE ur.user_id = ?`
    )
    .all(userId);
  return new Set(rows.map((r) => r.name));
}

async function userHasPermission(userId, permission) {
  return (await getPermissions(userId)).has(permission);
}

module.exports = { getRoles, getPermissions, userHasPermission };
