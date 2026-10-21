'use strict';

/**
 * Creates an admin account from the command line.
 *
 *   npm run create-admin -- --username jim --password 'SomePass123' --name 'Jim Fekete' --owner
 *
 * Useful for the very first account on a server where opening /admin/setup
 * in a browser is awkward, or to recover access.
 */

const auth = require('../src/auth');
const { logAction } = require('../src/db');

function arg(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index > -1 ? process.argv[index + 1] : undefined;
}

const username = arg('username');
const password = arg('password');
const displayName = arg('name') || username;
const owner = process.argv.includes('--owner');

if (!username || !password) {
  console.error(`
Create an admin account.

  npm run create-admin -- --username <name> --password <password> [--name "Full Name"] [--owner]

Passwords need at least 10 characters including a letter and a number.
`);
  process.exit(1);
}

try {
  const user = auth.createUser({ username, password, displayName, role: owner ? 'owner' : 'admin' });
  logAction(null, 'create_user_cli', 'users', user.id, user.username);
  console.log(`Created ${user.role} account "${user.username}".`);
  console.log('Sign in at /admin/login');
} catch (err) {
  console.error(`Could not create the account: ${err.message}`);
  process.exit(1);
}
