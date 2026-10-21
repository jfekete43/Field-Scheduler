/* Sign-in and first-run setup. */
'use strict';

function showError(message) {
  const slot = document.getElementById('error-slot');
  clear(slot).append(h('div', { class: 'form-error', role: 'alert' }, message));
}

function clearError() {
  clear(document.getElementById('error-slot'));
}

function nextUrl() {
  const next = new URLSearchParams(window.location.search).get('next');
  if (!next) return '/admin';
  // Must be a same-site path. Rejecting only a leading "//" is not enough:
  // browsers normalise backslashes to slashes, so "/\\evil.com" and "/\t//evil.com"
  // would navigate off-site. Resolve it and confirm the origin is still ours.
  try {
    const resolved = new URL(next, window.location.origin);
    if (resolved.origin !== window.location.origin) return '/admin';
    return resolved.pathname + resolved.search + resolved.hash;
  } catch {
    return '/admin';
  }
}

/* ---------------- Sign in ---------------- */

const loginForm = document.getElementById('login-form');
if (loginForm) {
  // Show the league's own name and logo if branding has been set.
  api.get('/api/bootstrap').then(({ settings }) => {
    const name = settings.leagueName;
    document.querySelectorAll('.auth-head p').forEach((p) => { p.textContent = name; });
    if (settings.logoPath) {
      const slot = document.getElementById('auth-logo');
      if (slot) slot.replaceWith(h('img', { class: 'brand-logo', src: settings.logoPath, alt: `${name} logo` }));
    } else {
      const slot = document.getElementById('auth-logo');
      if (slot) {
        slot.textContent = name.split(/\s+/).filter(Boolean).slice(0, 2)
          .map((w) => w[0]).join('').toUpperCase() || 'JH';
      }
    }
  }).catch(() => { /* branding is optional */ });

  loginForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    clearError();

    const button = document.getElementById('submit-btn');
    const username = document.getElementById('username').value.trim();
    const password = document.getElementById('password').value;

    if (!username || !password) {
      showError('Enter both your username and password.');
      return;
    }

    button.disabled = true;
    button.textContent = 'Signing in…';
    try {
      await api.post('/api/auth/login', { username, password }, { quiet: true });
      window.location.href = nextUrl();
    } catch (err) {
      showError(err.message);
      button.disabled = false;
      button.textContent = 'Sign In';
      document.getElementById('password').value = '';
      document.getElementById('password').focus();
    }
  });
}

/* ---------------- First-run setup ---------------- */

const setupForm = document.getElementById('setup-form');
if (setupForm) {
  setupForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    clearError();

    const button = document.getElementById('submit-btn');
    const username = document.getElementById('username').value.trim();
    const password = document.getElementById('password').value;
    const confirm = document.getElementById('confirm').value;
    const displayName = document.getElementById('displayName').value.trim();

    if (password !== confirm) {
      showError('The two passwords do not match.');
      return;
    }

    button.disabled = true;
    button.textContent = 'Creating account…';
    try {
      await api.post('/api/setup', { username, password, displayName }, { quiet: true });
      window.location.href = '/admin';
    } catch (err) {
      showError(err.message);
      button.disabled = false;
      button.textContent = 'Create Account & Sign In';
    }
  });
}
