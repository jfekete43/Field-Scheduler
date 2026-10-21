'use strict';

/**
 * Resets an admin password from the command line.
 *
 *   npm run reset-password -- --username jim --password 'NewPass123'
 */

const auth = require('../src/auth');
const { db, logAction } = require('../src/db');

function arg(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index > -1 ? process.argv[index + 1] : undefined;
}

const username = arg('username');
const password = arg('password');

if (!username || !password) {
  console.error(`
Reset an admin password.

  npm run reset-password -- --username <name> --password <new password>
`);
  process.exit(1);
}

const user = auth.findUserByUsername(username);
if (!user) {
  console.error(`No account named "${username}".`);
  const all = db.prepare('SELECT username FROM users ORDER BY username').all().map((u) => u.username);
  if (all.length) console.error(`Existing accounts: ${all.join(', ')}`);
  process.exit(1);
}

try {
  auth.setPassword(user.id, password);
  db.prepare('UPDATE users SET active = 1 WHERE id = ?').run(user.id);
  logAction(null, 'reset_password_cli', 'users', user.id, user.username);
  console.log(`Password updated for "${user.username}". The account is active.`);
} catch (err) {
  console.error(`Could not reset the password: ${err.message}`);
  process.exit(1);
}
