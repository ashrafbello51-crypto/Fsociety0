// server/rbac.js
const db = require('./db');

function getRoles(userId) {
  return db
    .prepare(
      `SELECT r.name, r.display_name FROM roles r
       JOIN user_roles ur ON ur.role_id = r.id
       WHERE ur.user_id = ?`
    )
    .all(userId)
    .map((r) => r.name);
}

function getPermissions(userId) {
  const rows = db
    .prepare(
      `SELECT DISTINCT p.name FROM permissions p
       JOIN role_permissions rp ON rp.permission_id = p.id
       JOIN user_roles ur ON ur.role_id = rp.role_id
       WHERE ur.user_id = ?`
    )
    .all(userId);
  return new Set(rows.map((r) => r.name));
}

function userHasPermission(userId, permission) {
  return getPermissions(userId).has(permission);
}

module.exports = { getRoles, getPermissions, userHasPermission };
