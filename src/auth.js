'use strict';

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const session = require('express-session');
const { db, logAction } = require('./db');

const BCRYPT_ROUNDS = 12;
const SESSION_TTL_MS = 1000 * 60 * 60 * 12; // 12 hours

/* ---------------------------------------------------------------- *
 * SQLite-backed session store (keeps logins alive across restarts)
 * ---------------------------------------------------------------- */

class SqliteStore extends session.Store {
  constructor() {
    super();
    this.getStmt = db.prepare('SELECT data, expires_at FROM sessions WHERE sid = ?');
    this.setStmt = db.prepare(
      `INSERT INTO sessions (sid, data, expires_at) VALUES (?, ?, ?)
       ON CONFLICT(sid) DO UPDATE SET data = excluded.data, expires_at = excluded.expires_at`
    );
    this.delStmt = db.prepare('DELETE FROM sessions WHERE sid = ?');
    this.touchStmt = db.prepare('UPDATE sessions SET expires_at = ? WHERE sid = ?');
    this.sweepStmt = db.prepare('DELETE FROM sessions WHERE expires_at < ?');

    this.sweep();
    this.timer = setInterval(() => this.sweep(), 1000 * 60 * 30);
    this.timer.unref();
  }

  sweep() {
    try {
      this.sweepStmt.run(Date.now());
    } catch {
      /* non-fatal */
    }
  }

  expiryFor(sess) {
    const cookieExpiry = sess?.cookie?.expires ? new Date(sess.cookie.expires).getTime() : null;
    return cookieExpiry && Number.isFinite(cookieExpiry) ? cookieExpiry : Date.now() + SESSION_TTL_MS;
  }

  get(sid, cb) {
    let row;
    try {
      row = this.getStmt.get(sid);
    } catch (err) {
      return cb(err);
    }
    if (!row) return cb(null, null);
    if (row.expires_at < Date.now()) {
      this.delStmt.run(sid);
      return cb(null, null);
    }
    try {
      return cb(null, JSON.parse(row.data));
    } catch {
      this.delStmt.run(sid);
      return cb(null, null);
    }
  }

  set(sid, sess, cb) {
    try {
      this.setStmt.run(sid, JSON.stringify(sess), this.expiryFor(sess));
    } catch (err) {
      return cb?.(err);
    }
    return cb?.(null);
  }

  destroy(sid, cb) {
    try {
      this.delStmt.run(sid);
    } catch (err) {
      return cb?.(err);
    }
    return cb?.(null);
  }

  touch(sid, sess, cb) {
    try {
      this.touchStmt.run(this.expiryFor(sess), sid);
    } catch (err) {
      return cb?.(err);
    }
    return cb?.(null);
  }
}

/* ---------------------------------------------------------------- *
 * Users
 * ---------------------------------------------------------------- */

function hashPassword(plain) {
  return bcrypt.hashSync(plain, BCRYPT_ROUNDS);
}

function findUserByUsername(username) {
  return db
    .prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE')
    .get(String(username || '').trim());
}

function publicUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name || row.username,
    role: row.role,
    mustChange: !!row.must_change,
  };
}

function createUser({ username, password, displayName, role = 'admin', mustChange = false }) {
  const clean = String(username || '').trim();
  if (!/^[A-Za-z0-9._-]{3,40}$/.test(clean)) {
    throw Object.assign(new Error('Username must be 3-40 characters: letters, numbers, . _ - only.'), {
      status: 400,
    });
  }
  const pwError = validatePassword(password);
  if (pwError) throw Object.assign(new Error(pwError), { status: 400 });
  if (findUserByUsername(clean)) {
    throw Object.assign(new Error('That username is already taken.'), { status: 409 });
  }
  const info = db
    .prepare(
      `INSERT INTO users (username, password_hash, display_name, role, must_change)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(clean, hashPassword(password), String(displayName || clean).trim(), role === 'owner' ? 'owner' : 'admin', mustChange ? 1 : 0);
  return db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
}

function validatePassword(password) {
  const value = String(password || '');
  if (value.length < 10) return 'Password must be at least 10 characters.';
  if (value.length > 200) return 'Password must be 200 characters or fewer.';
  if (!/[A-Za-z]/.test(value)) return 'Password must include at least one letter.';
  if (!/[0-9]/.test(value)) return 'Password must include at least one number.';
  return null;
}

function setPassword(userId, password) {
  const pwError = validatePassword(password);
  if (pwError) throw Object.assign(new Error(pwError), { status: 400 });
  db.prepare('UPDATE users SET password_hash = ?, must_change = 0 WHERE id = ?').run(
    hashPassword(password),
    userId
  );
}

function countActiveAdmins() {
  return db.prepare('SELECT COUNT(*) AS n FROM users WHERE active = 1').get().n;
}

/* ---------------------------------------------------------------- *
 * Login throttling (in-memory, per username+IP)
 * ---------------------------------------------------------------- */

const attempts = new Map();
const MAX_ATTEMPTS = 8;
const LOCKOUT_MS = 1000 * 60 * 10;

function throttleKey(username, ip) {
  return `${String(username || '').toLowerCase()}|${ip}`;
}

function checkThrottle(username, ip) {
  const entry = attempts.get(throttleKey(username, ip));
  if (!entry) return null;
  if (entry.lockedUntil && entry.lockedUntil > Date.now()) {
    return Math.ceil((entry.lockedUntil - Date.now()) / 1000);
  }
  return null;
}

function recordFailure(username, ip) {
  const key = throttleKey(username, ip);
  const entry = attempts.get(key) || { count: 0, lockedUntil: 0 };
  entry.count += 1;
  if (entry.count >= MAX_ATTEMPTS) {
    entry.lockedUntil = Date.now() + LOCKOUT_MS;
    entry.count = 0;
  }
  attempts.set(key, entry);
}

function clearFailures(username, ip) {
  attempts.delete(throttleKey(username, ip));
}

setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of attempts) {
    if (!entry.lockedUntil || entry.lockedUntil < now - LOCKOUT_MS) attempts.delete(key);
  }
}, 1000 * 60 * 15).unref();

/* ---------------------------------------------------------------- *
 * Authentication
 * ---------------------------------------------------------------- */

function verifyLogin(username, password) {
  const row = findUserByUsername(username);
  // Always run a hash comparison so a missing user and a wrong password
  // take a similar amount of time.
  const hash = row ? row.password_hash : '$2a$12$0000000000000000000000000000000000000000000000000000';
  const ok = bcrypt.compareSync(String(password || ''), hash);
  if (!row || !ok || !row.active) return null;
  db.prepare("UPDATE users SET last_login_at = datetime('now') WHERE id = ?").run(row.id);
  return row;
}

function requireAuth(req, res, next) {
  if (req.session?.user?.id) {
    const fresh = db.prepare('SELECT * FROM users WHERE id = ? AND active = 1').get(req.session.user.id);
    if (fresh) {
      req.user = fresh;
      return next();
    }
    req.session.destroy(() => {});
  }
  // Only a page request is redirected. API calls always get JSON, because a
  // redirect there would be followed silently by fetch() and look like success.
  // originalUrl, not path: inside a mounted router req.path is relative.
  if (req.method === 'GET' && !req.originalUrl.startsWith('/api/')) {
    return res.redirect(`/admin/login?next=${encodeURIComponent(req.originalUrl)}`);
  }
  return res.status(401).json({ error: 'Sign in required.' });
}

/* ---------------------------------------------------------------- *
 * CSRF (double-submit token tied to the session)
 * ---------------------------------------------------------------- */

function csrfToken(req) {
  if (!req.session) return '';
  if (!req.session.csrf) req.session.csrf = crypto.randomBytes(24).toString('hex');
  return req.session.csrf;
}

function requireCsrf(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const sent = req.get('x-csrf-token') || req.body?._csrf || '';
  const expected = req.session?.csrf || '';
  const a = Buffer.from(String(sent));
  const b = Buffer.from(String(expected));
  if (!expected || a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(403).json({ error: 'Your session expired. Reload the page and try again.' });
  }
  return next();
}

module.exports = {
  SqliteStore,
  SESSION_TTL_MS,
  hashPassword,
  validatePassword,
  createUser,
  setPassword,
  findUserByUsername,
  publicUser,
  countActiveAdmins,
  verifyLogin,
  requireAuth,
  csrfToken,
  requireCsrf,
  checkThrottle,
  recordFailure,
  clearFailures,
  logAction,
};
