'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const express = require('express');
const session = require('express-session');
const helmet = require('helmet');
const compression = require('compression');
const cookieParser = require('cookie-parser');

const { db, getSettings, logAction, DATA_DIR, UPLOAD_DIR } = require('./db');
const auth = require('./auth');
const publicRoutes = require('./routes/public');
const adminRoutes = require('./routes/admin');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const IS_PROD = process.env.NODE_ENV === 'production';

/* ---------------------------------------------------------------- *
 * Session secret: from the environment, or persisted locally so that
 * logins survive a restart during development.
 * ---------------------------------------------------------------- */

function resolveSessionSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  const secretFile = path.join(DATA_DIR, '.session-secret');
  try {
    const stored = fs.readFileSync(secretFile, 'utf8').trim();
    // A truncated or empty file (a crash mid-write, a bad restore) would make
    // express-session throw on every request, taking the public schedule down
    // too. Regenerate instead.
    if (stored.length >= 32) return stored;
    console.warn('[warn] data/.session-secret was empty or too short; regenerating it.');
  } catch {
    /* fall through to generating a new secret */
  }

  {
    const generated = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(secretFile, generated, { mode: 0o600 });
    if (IS_PROD) {
      console.warn(
        '[warn] SESSION_SECRET was not set. A secret was generated at data/.session-secret.\n' +
          '       Set SESSION_SECRET in the environment for production deployments.'
      );
    }
    return generated;
  }
}

const app = express();

// Number(x) || 1 would turn an explicit 0 back into 1, leaving a directly
// exposed instance trusting a forged X-Forwarded-For (and so a forged req.ip,
// which the login throttle is keyed on).
// Defaults to 0 (trust nothing). With any non-zero value express takes req.ip
// from a client-supplied X-Forwarded-For, and the login throttle is keyed on
// req.ip - so a directly exposed instance that trusted a proxy by default would
// let an attacker mint a fresh attempt budget per request. Set this to the
// number of proxies you actually run behind; render.yaml, fly.toml and the
// nginx example all set 1.
const TRUST_PROXY_HOPS =
  process.env.TRUST_PROXY_HOPS !== undefined && Number.isFinite(Number(process.env.TRUST_PROXY_HOPS))
    ? Number(process.env.TRUST_PROXY_HOPS)
    : 0;
app.set('trust proxy', TRUST_PROXY_HOPS);
app.disable('x-powered-by');

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'blob:'],
        fontSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        upgradeInsecureRequests: IS_PROD ? [] : null,
      },
    },
    crossOriginEmbedderPolicy: false,
    referrerPolicy: { policy: 'same-origin' },
  })
);

app.use(compression());
app.use(express.json({ limit: '256kb' }));
app.use(express.urlencoded({ extended: false, limit: '256kb' }));
app.use(cookieParser());

app.use(
  session({
    name: 'jhll.sid',
    secret: resolveSessionSecret(),
    store: new auth.SqliteStore(),
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: IS_PROD,
      maxAge: auth.SESSION_TTL_MS,
    },
  })
);

/* ---------------------------------------------------------------- *
 * Helpers
 * ---------------------------------------------------------------- */

function userCount() {
  return db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
}

/**
 * Recreates an admin account from the environment if it is missing.
 *
 * Free hosting tiers have no persistent disk, so the database is wiped every
 * time the service restarts and the admin account goes with it. Setting
 * ADMIN_USERNAME and ADMIN_PASSWORD means the login works again as soon as the
 * service comes back, instead of dropping you at the first-run setup page.
 *
 * For a real deployment, leave these unset, attach a persistent disk and create
 * the account through /admin/setup so the password is never stored in config.
 */
function ensureAdminFromEnv() {
  const username = process.env.ADMIN_USERNAME;
  const password = process.env.ADMIN_PASSWORD;
  if (!username || !password) return;

  if (auth.findUserByUsername(username)) return;

  try {
    const created = auth.createUser({
      username,
      password,
      displayName: process.env.ADMIN_NAME || username,
      role: 'owner',
    });
    logAction(created, 'create_user_env', 'users', created.id, created.username);
    console.log(`  Admin account "${created.username}" restored from the environment.`);
  } catch (err) {
    console.warn(`[warn] ADMIN_USERNAME/ADMIN_PASSWORD were set but ignored: ${err.message}`);
  }
}

function sendPage(res, file) {
  res.set('Cache-Control', 'no-cache');
  res.sendFile(path.join(PUBLIC_DIR, file));
}

function clientIp(req) {
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

/* ---------------------------------------------------------------- *
 * Pages
 * ---------------------------------------------------------------- */

app.get('/', (_req, res) => sendPage(res, 'index.html'));

app.get('/admin', auth.requireAuth, (_req, res) => sendPage(res, 'admin.html'));

app.get('/admin/login', (req, res) => {
  if (userCount() === 0) return res.redirect('/admin/setup');
  if (req.session?.user?.id) return res.redirect('/admin');
  return sendPage(res, 'login.html');
});

app.get('/admin/setup', (_req, res) => {
  if (userCount() > 0) return res.redirect('/admin/login');
  return sendPage(res, 'setup.html');
});

/* ---------------------------------------------------------------- *
 * Auth API
 * ---------------------------------------------------------------- */

app.get('/api/auth/me', (req, res) => {
  const signedIn = !!req.session?.user?.id;
  res.json({
    signedIn,
    user: signedIn ? req.session.user : null,
    csrfToken: signedIn ? auth.csrfToken(req) : null,
    needsSetup: userCount() === 0,
  });
});

/** Creates the very first admin. Only available while no users exist. */
app.post('/api/setup', (req, res, next) => {
  try {
    if (userCount() > 0) {
      return res.status(403).json({ error: 'Setup has already been completed. Sign in instead.' });
    }
    const created = auth.createUser({
      username: req.body.username,
      password: req.body.password,
      displayName: req.body.displayName,
      role: 'owner',
    });
    logAction(created, 'first_admin_created', 'users', created.id, created.username);
    req.session.regenerate((err) => {
      if (err) return next(err);
      req.session.user = auth.publicUser(created);
      req.session.startedAt = Date.now();
      auth.csrfToken(req);
      return req.session.save((saveErr) =>
        saveErr ? next(saveErr) : res.status(201).json({ user: req.session.user, csrfToken: req.session.csrf })
      );
    });
    return undefined;
  } catch (err) {
    return next(err);
  }
});

app.post('/api/auth/login', (req, res, next) => {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  const ip = clientIp(req);

  const lockedFor = auth.checkThrottle(username, ip);
  if (lockedFor) {
    return res.status(429).json({
      error: `Too many failed attempts. Try again in ${Math.ceil(lockedFor / 60)} minute(s).`,
    });
  }

  const row = auth.verifyLogin(username, password);
  if (!row) {
    auth.recordFailure(username, ip);
    logAction(null, 'login_failed', 'users', '', `${username} from ${ip}`);
    return res.status(401).json({ error: 'That username or password is not right.' });
  }

  auth.clearFailures(username, ip);
  return req.session.regenerate((err) => {
    if (err) return next(err);
    req.session.user = auth.publicUser(row);
    req.session.startedAt = Date.now();
    auth.csrfToken(req);
    return req.session.save((saveErr) => {
      if (saveErr) return next(saveErr);
      logAction(row, 'login', 'users', row.id, ip);
      return res.json({ user: req.session.user, csrfToken: req.session.csrf });
    });
  });
});

app.post('/api/auth/logout', (req, res) => {
  const user = req.session?.user;
  if (user) logAction(user, 'logout', 'users', user.id, '');
  req.session.destroy(() => {
    res.clearCookie('jhll.sid');
    res.json({ ok: true });
  });
});

/** Lets a signed-in admin change their own password. */
app.post('/api/auth/password', auth.requireAuth, auth.requireCsrf, (req, res, next) => {
  try {
    const current = String(req.body.currentPassword || '');
    if (!auth.verifyLogin(req.user.username, current)) {
      return res.status(401).json({ error: 'Your current password is not right.' });
    }
    auth.setPassword(req.user.id, req.body.newPassword, { keepSid: req.sessionID });
    logAction(req.user, 'change_own_password', 'users', req.user.id, '');
    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
});

/* ---------------------------------------------------------------- *
 * Data API
 * ---------------------------------------------------------------- */

app.use('/api', publicRoutes.router);
app.use('/api/admin', auth.requireAuth, auth.requireCsrf, adminRoutes);

app.get('/calendar.ics', publicRoutes.calendarHandler);

app.get('/healthz', (_req, res) => {
  const counts = db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM locations) AS locations,
              (SELECT COUNT(*) FROM fields)    AS fields,
              (SELECT COUNT(*) FROM events)    AS events,
              (SELECT COUNT(*) FROM users)     AS users`
    )
    .get();
  res.json({ ok: true, ...counts, needsSetup: counts.users === 0 });
});

/* ---------------------------------------------------------------- *
 * Static files
 * ---------------------------------------------------------------- */

app.use(
  '/uploads',
  express.static(UPLOAD_DIR, {
    maxAge: '7d',
    index: false,
    dotfiles: 'deny',
    setHeaders: (res) => {
      // Uploaded SVGs are never rendered as documents in this app.
      res.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; img-src data:");
      res.set('X-Content-Type-Options', 'nosniff');
    },
  })
);

// The HTML is served no-cache while the JS and CSS it loads have no version in
// their filenames. Caching them for an hour would let a browser pair fresh HTML
// with a stale script after a deploy, so they are revalidated on each load.
app.use(
  express.static(PUBLIC_DIR, {
    etag: true,
    lastModified: true,
    maxAge: 0,
    index: false,
    extensions: ['html'],
    setHeaders: (res) => res.set('Cache-Control', 'no-cache'),
  })
);

/* ---------------------------------------------------------------- *
 * 404 + error handling
 * ---------------------------------------------------------------- */

app.use((req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found.' });
  return res.status(404).sendFile(path.join(PUBLIC_DIR, '404.html'));
});

app.use((err, _req, res, _next) => {
  // Multer signals upload problems with a code rather than an HTTP status;
  // they are the caller's fault, not a server fault.
  const MULTER_MESSAGES = {
    LIMIT_FILE_SIZE: 'That image is larger than 6 MB.',
    LIMIT_FILE_COUNT: 'Upload one image at a time.',
    LIMIT_UNEXPECTED_FILE: 'Unexpected upload field.',
  };
  const isUploadError = typeof err.code === 'string' && err.code.startsWith('LIMIT_');
  const status = err.status || err.statusCode || (isUploadError ? 400 : 500);

  if (status >= 500) console.error('[error]', err);
  const payload = {
    error: isUploadError
      ? MULTER_MESSAGES[err.code] || 'That upload was rejected.'
      : status >= 500
        ? 'Something went wrong on the server.'
        : err.message,
  };
  if (err.conflicts) payload.conflicts = err.conflicts;
  if (err.eventCount !== undefined) payload.eventCount = err.eventCount;
  res.status(status).json(payload);
});

/* ---------------------------------------------------------------- *
 * Start
 * ---------------------------------------------------------------- */

if (require.main === module) {
  ensureAdminFromEnv();

  const server = app.listen(PORT, () => {
    const settings = getSettings();
    console.log(`\n${settings.league_name} - Field Scheduler`);
    console.log(`  Public schedule : http://localhost:${PORT}/`);
    console.log(`  Admin console   : http://localhost:${PORT}/admin`);
    if (userCount() === 0) {
      console.log(`\n  No admin accounts yet. Create the first one at http://localhost:${PORT}/admin/setup`);
    }
    console.log('');
  });

  const shutdown = (signal) => () => {
    console.log(`\n${signal} received, shutting down.`);
    server.close(() => {
      try {
        db.close();
      } catch {
        /* ignore */
      }
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 8000).unref();
  };

  process.on('SIGTERM', shutdown('SIGTERM'));
  process.on('SIGINT', shutdown('SIGINT'));
}

module.exports = app;
