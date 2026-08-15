// server/db.js
// PostgreSQL (Neon) database layer for F SOCIETY.
// Exposes a small async compatibility API (prepare/get/run/all/exec/tx) so the
// rest of the app can be migrated incrementally. Every SQL string is rewritten
// from SQLite syntax to PostgreSQL syntax at call time.
const { Pool } = require('pg');
const config = require('./config');

// Postgres returns BIGINT (e.g. COUNT(*), xp, file sizes) as strings by default.
// Coerce to numbers so API consumers get consistent types.
pgTypes20();
function pgTypes20() {
  try { require('pg').types.setTypeParser(20, (v) => (v === null ? null : parseInt(v, 10))); } catch {}
}

if (!config.databaseUrl) {
  throw new Error('DATABASE_URL environment variable is required (Neon PostgreSQL)');
}

const pool = new Pool({
  connectionString: config.databaseUrl,
  ssl: { rejectUnauthorized: false },
  max: 10,
});

// ---- SQLite -> PostgreSQL SQL rewrites ----
function rewrite(sql) {
  let s = String(sql);

  // 0) Backtick-quoted identifiers -> double-quoted (SQLite uses backticks;
  //    Postgres uses double quotes). Reserved words like `read` need quoting.
  s = s.replace(/`([^`]+)`/g, '"$1"');

  // 1) Anonymous ? placeholders -> positional $1, $2, ...
  let i = 0;
  s = s.replace(/\?/g, () => `$${++i}`);

  // 2) datetime('now') -> CURRENT_TIMESTAMP (paren-free so it never breaks
  //    the INSERT OR REPLACE/IGNORE VALUES regex which captures [^)]* groups)
  s = s.replace(/datetime\(\s*'now'\s*\)/g, 'CURRENT_TIMESTAMP');

  // 3) datetime('now', '-N unit') -> now() - interval 'N unit'
  s = s.replace(
    /datetime\(\s*'now'\s*,\s*'(-?\d+)\s+([a-zA-Z]+)'\s*\)/g,
    "now() - interval '$1 $2'"
  );

  // 4) INSERT OR IGNORE INTO tbl (cols) VALUES (vals) -> ON CONFLICT DO NOTHING
  s = s.replace(
    /INSERT\s+OR\s+IGNORE\s+INTO\s+([`"]?)([a-zA-Z_][\w]*)\1\s*\(([^)]*)\)\s*VALUES\s*\(([^)]*)\)/gi,
    'INSERT INTO $2 ($3) VALUES ($4) ON CONFLICT DO NOTHING'
  );

  // 4b) INSERT OR IGNORE INTO tbl (cols) SELECT ... -> ON CONFLICT DO NOTHING
  //     (e.g. "mark all as read" bulk inserts that use a SELECT source)
  s = s.replace(
    /INSERT\s+OR\s+IGNORE\s+INTO\s+([`"]?)([a-zA-Z_][\w]*)\1\s*\(([^)]*)\)\s*SELECT\s+([\s\S]+)$/gi,
    'INSERT INTO $2 ($3) SELECT $4 ON CONFLICT DO NOTHING'
  );

  // 5) INSERT OR REPLACE INTO presence -> upsert on user_id
  s = s.replace(
    /INSERT\s+OR\s+REPLACE\s+INTO\s+presence\s*\(([^)]*)\)\s*VALUES\s*\(([^)]*)\)/i,
    'INSERT INTO presence ($1) VALUES ($2) ON CONFLICT (user_id) DO UPDATE SET state = EXCLUDED.state, last_seen = EXCLUDED.last_seen'
  );

  return s;
}

function makeStatement(conn, sql) {
  const rw = rewrite(sql);
  const isInsert = /^\s*insert\b/i.test(rw);
  const hasReturning = /returning\b/i.test(rw);
  return {
    async get(...params) {
      try { const r = await conn.query(rw, params); return r.rows[0]; }
      catch (e) { throw e; }
    },
    async all(...params) {
      try { const r = await conn.query(rw, params); return r.rows; }
      catch (e) { throw e; }
    },
    async run(...params) {
      try {
      // RETURNING * works for every table: those with an `id` column yield it,
      // those without (e.g. profiles, presence) simply return 0 below.
      const q = isInsert && !hasReturning ? rw + ' RETURNING *' : rw;
      const r = await conn.query(q, params);
      const row = r.rows[0];
      return {
        lastInsertRowid: row && Object.prototype.hasOwnProperty.call(row, 'id') ? Number(row.id) : 0,
        changes: r.rowCount || 0,
      };
      } catch (e) { throw e; }
    },
  };
}

function stripSqlComments(sql) {
  return String(sql)
    .replace(/--[^\n]*/g, ' ') // line comments
    .replace(/\/\*[\s\S]*?\*\//g, ' '); // block comments
}

function runExec(conn, sql) {
  const stmts = stripSqlComments(sql).split(';').map((s) => s.trim()).filter(Boolean);
  return (async () => {
    for (const st of stmts) {
      await conn.query(st);
    }
  })();
}

const db = {
  prepare: (sql) => makeStatement(pool, sql),
  exec: (sql) => runExec(pool, sql),
  async tx(fn) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn({
        prepare: (sql) => makeStatement(client, sql),
        exec: (sql) => runExec(client, sql),
      });
      await client.query('COMMIT');
      return result;
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  },
};

module.exports = db;
