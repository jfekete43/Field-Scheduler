'use strict';

/**
 * Builds the standalone demo page.
 *
 *   npm run build:demo
 *
 * The result is a single self-contained HTML file that runs the real front-end
 * code — the same CSS, markup and JavaScript the live site uses — against an
 * in-browser stand-in for the server, loaded with a sample season. It needs no
 * Node process and no database, so GitHub Pages can serve it.
 *
 * Re-run this after changing anything under public/, or the demo drifts from
 * the real thing.
 *
 *   --fragment <path>   also write a version with no <html>/<head>/<body>
 *                       wrapper, for hosts that supply their own skeleton
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

/* ---------------- the real stylesheet ---------------- */

const css = read('public/css/styles.css');

/* ---------------- the real markup, scripts stripped ---------------- */

function bodyOf(file) {
  const html = read(file);
  return html
    .slice(html.indexOf('<body'))
    .replace(/^<body[^>]*>/, '')
    .replace(/<\/body>[\s\S]*$/, '')
    .replace(/<script[\s\S]*?<\/script>/g, '')
    .trim();
}

let publicBody = bodyOf('public/index.html');
const adminBody = bodyOf('public/admin.html');

// A sandboxed page cannot hand over a file, so the feed is a button that says so.
publicBody = publicBody.replace(
  '<a class="btn btn-primary" id="btn-download-ics" href="/calendar.ics" download>Download .ics</a>',
  '<button class="btn btn-primary" type="button" id="btn-download-ics">Download .ics</button>'
);

/* ---------------- the real front-end code ---------------- */

const common = read('public/js/common.js');
const timeline = read('public/js/timeline.js').replace(/\nif \(typeof module[\s\S]*$/, '\n');

/** Wraps a page script so it mounts on demand instead of on DOMContentLoaded. */
function mountable(file, fnName) {
  return `function ${fnName}() {\n${
    read(file)
      .replace("document.addEventListener('DOMContentLoaded', init);", '')
      .replace(/^'use strict';\n/, '')
  }\n  return init();\n}`;
}

let publicApp = mountable('public/js/public.js', 'mountPublic');
let adminApp = mountable('public/js/admin.js', 'mountAdmin');

// History writes throw when the page is opened straight from disk.
publicApp = publicApp.replace(
  "  window.history.replaceState(null, '', query ? `/?${query}` : '/');",
  "  try { window.history.replaceState(null, '', query ? `/?${query}` : '/'); } catch { /* file:// */ }"
);
publicApp = publicApp.replace(
  "$('#btn-print').addEventListener('click', () => window.print());",
  "$('#btn-print').addEventListener('click', () => window.print());"
);

// window.prompt() is unavailable in some embeds; route it through the page.
adminApp = adminApp.replace(
  "const name = window.prompt('Name of the new location?');",
  "const name = await demoPrompt('Add a location', 'What is the new location called?', '');"
);
adminApp = adminApp.replace(
  `  const entered = window.prompt(
    \`Set a new password for \${user.username}.\\n\\nAt least 10 characters with a letter and a number.\`,
    suggested
  );`,
  `  const entered = await demoPrompt(
    \`Reset password for \${user.username}\`,
    'At least 10 characters, including a letter and a number.',
    suggested
  );`
);

const demoApi = read('scripts/demo/demo-api.js');

/* ---------------- the demo shell ---------------- */

const SHELL_CSS = `
.demo-bar {
  background: #0a1a2f; color: #cfe0f5;
  border-bottom: 1px solid rgba(255,255,255,.14);
  padding-block: 9px;
  padding-left: max(16px, env(safe-area-inset-left, 0px));
  padding-right: max(16px, env(safe-area-inset-right, 0px));
  display: flex; align-items: center; gap: 12px; flex-wrap: wrap; font-size: 13px;
}
.demo-bar .demo-note { color: #8fa8c8; min-width: 0; }
.demo-switch { display: inline-flex; background: rgba(255,255,255,.1); border-radius: 7px; padding: 3px; gap: 2px; }
.demo-switch button {
  font: inherit; font-size: 13px; font-weight: 700; color: #cfe0f5;
  background: transparent; border: 0; border-radius: 5px; padding: 5px 12px; cursor: pointer;
}
.demo-switch button[aria-pressed="true"] { background: #fff; color: #0a1a2f; }
.demo-reset { margin-left: auto; }
.demo-reset button {
  font: inherit; font-size: 12.5px; font-weight: 600; color: #cfe0f5;
  background: transparent; border: 1px solid rgba(255,255,255,.3);
  border-radius: 6px; padding: 5px 11px; cursor: pointer;
}
.demo-reset button:hover { background: rgba(255,255,255,.14); }
@media (max-width: 680px) { .demo-bar .demo-note { display: none; } }
#demo-prompt .modal-body { display: grid; gap: 10px; }
`;

const PROMPT_DIALOG = `
<dialog class="modal" id="demo-prompt" aria-labelledby="demo-prompt-title">
  <div class="modal-head">
    <h2 id="demo-prompt-title">Enter a value</h2>
    <button class="modal-close" type="button" data-prompt-cancel aria-label="Close">&times;</button>
  </div>
  <div class="modal-body">
    <p class="hint" id="demo-prompt-message" style="margin:0"></p>
    <input type="text" id="demo-prompt-input">
  </div>
  <div class="modal-foot">
    <button class="btn" type="button" data-prompt-cancel>Cancel</button>
    <button class="btn btn-primary" type="button" data-prompt-ok>OK</button>
  </div>
</dialog>`;

const SHELL_JS = `
/* ---------------- demo shell ---------------- */

const PUBLIC_HTML = document.getElementById('tpl-public').innerHTML;
const ADMIN_HTML = document.getElementById('tpl-admin').innerHTML;
const stage = document.getElementById('stage');
let current = null;

/** Stands in for window.prompt(), which some embeds refuse to show. */
function demoPrompt(title, message, value) {
  return new Promise((resolve) => {
    const dlg = document.getElementById('demo-prompt');
    document.getElementById('demo-prompt-title').textContent = title;
    document.getElementById('demo-prompt-message').textContent = message;
    const input = document.getElementById('demo-prompt-input');
    input.value = value || '';
    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      dlg.close();
      resolve(result);
    };
    dlg.querySelector('[data-prompt-ok]').onclick = () => done(input.value.trim() || null);
    dlg.querySelectorAll('[data-prompt-cancel]').forEach((b) => { b.onclick = () => done(null); });
    dlg.addEventListener('close', () => done(null), { once: true });
    dlg.showModal();
    setTimeout(() => input.select(), 40);
  });
}

function show(which) {
  if (current === which) return;
  current = which;
  document.querySelectorAll('.demo-switch button').forEach((b) =>
    b.setAttribute('aria-pressed', String(b.dataset.demo === which)));
  stage.innerHTML = which === 'public' ? PUBLIC_HTML : ADMIN_HTML;
  const started = which === 'public' ? mountPublic() : mountAdmin();
  Promise.resolve(started).then(() => wireCrossLinks(which)).catch(() => wireCrossLinks(which));
}

/** Links that would move between pages switch the demo instead. */
function wireCrossLinks(which) {
  const go = (sel, target) => {
    document.querySelectorAll(sel).forEach((el) => {
      el.addEventListener('click', (e) => { e.preventDefault(); show(target); });
    });
  };
  if (which === 'public') {
    go('#link-admin, .site-footer a[href="/admin"]', 'admin');
    const feedNote = (e) => {
      e.preventDefault();
      toast('The calendar feed comes from the real site. This demo has no server to build one.', 'info', 5500);
    };
    document.querySelectorAll('.site-footer a[href="/calendar.ics"]').forEach((a) =>
      a.addEventListener('click', feedNote));
    const dl = document.getElementById('btn-download-ics');
    if (dl) dl.addEventListener('click', feedNote);
  } else {
    go('.header-actions a[href="/"]', 'public');
    const out = document.getElementById('btn-logout');
    if (out) {
      const fresh = out.cloneNode(true);
      out.replaceWith(fresh);
      fresh.addEventListener('click', () => show('public'));
    }
  }
}

document.querySelectorAll('.demo-switch button').forEach((b) =>
  b.addEventListener('click', () => show(b.dataset.demo)));
document.getElementById('demo-reset').addEventListener('click', () => window.location.reload());

show('public');
`;

/* ---------------- assemble ---------------- */

const head = `<title>JHLL Field Scheduler — Demo</title>
<meta name="description" content="A working demo of the Jackson Holbrook Little League field and batting cage scheduler, running on sample data.">
<meta name="claude:viewport-fit-sides" content="cover">
<style>
${css}
${SHELL_CSS}
</style>`;

const body = `<div class="demo-bar">
  <div class="demo-switch" role="group" aria-label="Which part of the site to view">
    <button type="button" data-demo="public" aria-pressed="true">Public site</button>
    <button type="button" data-demo="admin" aria-pressed="false">Admin console</button>
  </div>
  <span class="demo-note">Demo with sample data &mdash; changes stay in your browser</span>
  <span class="demo-reset"><button type="button" id="demo-reset">Reset sample data</button></span>
</div>

<div id="stage"></div>

${PROMPT_DIALOG}

<template id="tpl-public">${publicBody}</template>
<template id="tpl-admin">${adminBody}</template>

<script>
${common}
${timeline}
${demoApi}
${publicApp}
${adminApp}
${SHELL_JS}
</script>`;

const fragment = `${head}\n\n${body}\n`;

const standalone = `<!doctype html>
<!--
  GENERATED FILE — do not edit by hand. Run: npm run build:demo

  A self-contained demo of the scheduler for GitHub Pages. It runs the real
  front-end code from public/ against an in-browser stand-in for the server
  (scripts/demo/demo-api.js), loaded with a sample season. Nothing is saved
  anywhere: changes live in the viewer's browser until they reload.

  The real application is a Node server — see README.md.
-->
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<link rel="icon" href="public/img/favicon.svg" type="image/svg+xml">
<style>
  :root { color-scheme: light; }
  body { margin: 0; font: 14px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
  img { max-width: 100%; }
  [hidden] { display: none !important; }
</style>
${head}
</head>
<body>
${body}
</body>
</html>
`;

fs.writeFileSync(path.join(ROOT, 'index.html'), standalone);
console.log(`index.html  ${(Buffer.byteLength(standalone) / 1024).toFixed(0)} KB`);

const flagIndex = process.argv.indexOf('--fragment');
if (flagIndex > -1 && process.argv[flagIndex + 1]) {
  const out = path.resolve(process.argv[flagIndex + 1]);
  fs.writeFileSync(out, fragment);
  console.log(`${out}  ${(Buffer.byteLength(fragment) / 1024).toFixed(0)} KB`);
}
