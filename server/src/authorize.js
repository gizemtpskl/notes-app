/**
 * authorize.js: the page Claude sends you to when you connect it. It says which app is asking and
 * where access will go, and you allow it by typing your access key. Reading is always included;
 * changing your notes is a box you can untick.
 *
 * The OAuth library keeps the request itself on the server between showing the page and the
 * answer, bound to this browser; the form only carries a one-time handle.
 */
import { AuthorizationError, CimdFetchError } from '@cloudflare/workers-oauth-provider';
import { escapeHtml, keyMatches, notesStore } from './shared.js';

export const READ = 'notes:read';
export const WRITE = 'notes:write';

const STYLE = `
  :root { color-scheme: light dark; --bg: #fbfaf7; --text: #1f1f1c; --muted: #6b6a64; --border: #dcd9d0; --accent: #2f6f62; --error: #a3372b; }
  @media (prefers-color-scheme: dark) { :root { --bg: #1b1c1a; --text: #ecebe6; --muted: #a9a79f; --border: #3a3b37; --accent: #6fb3a3; --error: #f08a7e; } }
  body { margin: 0; padding: 32px 16px; background: var(--bg); color: var(--text); font: 16px/1.5 system-ui, sans-serif; }
  main { max-width: 440px; margin: 0 auto; }
  h1 { font-size: 22px; line-height: 1.3; }
  .muted { color: var(--muted); font-size: 14px; }
  .warn, .error { padding: 10px 12px; border: 1px solid var(--error); border-radius: 8px; color: var(--error); }
  label { display: block; margin: 14px 0 4px; font-weight: 600; }
  input[type=password] { box-sizing: border-box; width: 100%; padding: 10px 12px; border: 1px solid var(--border); border-radius: 8px; background: transparent; color: inherit; font: inherit; }
  .check { display: flex; gap: 8px; align-items: flex-start; font-weight: 400; }
  .actions { display: flex; gap: 10px; margin-top: 22px; }
  button { padding: 10px 18px; border: 1px solid var(--border); border-radius: 8px; background: transparent; color: inherit; font: inherit; cursor: pointer; }
  button[value=approve] { border-color: var(--accent); background: var(--accent); color: var(--bg); font-weight: 600; }
`;

/**
 * Where the form may lead. Browsers apply form-action to the redirect after the form is sent too,
 * so the place the answer goes back to (Claude's callback) has to be allowed as well, or the
 * browser silently stops at the Allow button.
 */
export function returnSource(redirectUri) {
  try {
    const url = new URL(redirectUri);
    if (url.protocol === 'https:' || url.protocol === 'http:') return url.origin;
    return /^[a-z][a-z0-9+.-]*:$/i.test(url.protocol) ? url.protocol : '';
  } catch {
    return '';
  }
}

function page(title, body, status = 200, headers = new Headers(), returnTo = '') {
  const formAction = ["'self'", returnSource(returnTo)].filter(Boolean).join(' ');
  headers.set('Content-Type', 'text/html; charset=utf-8');
  headers.set('Content-Security-Policy', `default-src 'none'; style-src 'unsafe-inline'; form-action ${formAction}; frame-ancestors 'none'; base-uri 'none'`);
  headers.set('Referrer-Policy', 'no-referrer');
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title><style>${STYLE}</style></head><body><main>${body}</main></body></html>`, { status, headers });
}

/** What the page shows about the asking app. Re-sent with the form only to show it again. */
function consentForm({
  clientName, clientDomain, redirectHost, redirectIsLoopback, returnTo, extraScopes, wantsWrite,
}, handle, error = '') {
  const name = escapeHtml(clientName || 'An app');
  const origin = clientDomain ? `Published by <strong>${escapeHtml(clientDomain)}</strong>.` : 'This app registered itself, so its name isn’t verified.';
  const keep = (field, value) => `<input type="hidden" name="${field}" value="${escapeHtml(value)}">`;
  return `
    <h1>Allow ${name} to use your notes?</h1>
    <p class="muted">${origin} Access will be sent to <strong>${escapeHtml(redirectHost)}</strong>.</p>
    ${redirectIsLoopback ? '<p class="warn">This sends access to an app on a computer. Continue only if you just started connecting from it.</p>' : ''}
    ${error ? `<p class="error" role="alert">${escapeHtml(error)}</p>` : ''}
    <form method="post">
      ${keep('handle', handle)}
      ${keep('clientName', clientName)}${keep('clientDomain', clientDomain ?? '')}${keep('redirectHost', redirectHost)}${keep('redirectIsLoopback', redirectIsLoopback ? '1' : '')}${keep('returnTo', returnSource(returnTo))}
      ${extraScopes.map((scope) => keep('extra', scope)).join('')}
      <p>It will be able to search and read your notes, tasks, deadlines and timetable. Private notes are never included.</p>
      <label class="check"><input type="checkbox" name="write" value="1" ${wantsWrite ? 'checked' : ''}> <span>Also let it add and change notes, tasks and timetable blocks. It can never delete anything.</span></label>
      <label for="key">Your access key</label>
      <input id="key" name="key" type="password" autocomplete="current-password" required autofocus>
      <p class="muted">The key you set on the server and typed into the app.</p>
      <div class="actions"><button name="decision" value="approve">Allow</button><button name="decision" value="deny" formnovalidate>Deny</button></div>
    </form>`;
}

function failure(error) {
  if (error instanceof AuthorizationError && error.redirectTo) return Response.redirect(error.redirectTo, 302);
  if (error instanceof AuthorizationError || error instanceof CimdFetchError) {
    const message = error instanceof AuthorizationError ? error.description : 'This app could not be verified.';
    return page('Can’t connect', `<h1>Can’t connect</h1><p>${escapeHtml(message)}</p><p class="muted">Start connecting again from Claude.</p>`, 400);
  }
  throw error;
}

export async function handleAuthorize(request, env, supported) {
  const oauth = env.OAUTH_PROVIDER;
  try {
    if (request.method === 'GET') {
      const authRequest = await oauth.parseAuthRequest(request);
      const details = await oauth.describeConsent(authRequest);
      const consent = await oauth.beginConsent(authRequest);
      const extraScopes = details.scope.filter((scope) => scope !== READ && scope !== WRITE && supported.includes(scope));
      const returnTo = authRequest.redirectUri;
      return page('Connect to your notes', consentForm({
        ...details, returnTo, extraScopes, wantsWrite: true,
      }, consent.handle), 200, consent.headers, returnTo);
    }
    if (request.method !== 'POST') return page('Not found', '<h1>Not found</h1>', 404);

    const form = await request.formData();
    const handle = String(form.get('handle') ?? '');
    if (form.get('decision') !== 'approve') {
      const denied = await oauth.denyConsent(request, handle);
      return new Response(null, { status: 302, headers: denied.headers });
    }
    const store = notesStore(env);
    const shown = {
      clientName: String(form.get('clientName') ?? ''),
      clientDomain: String(form.get('clientDomain') ?? '') || null,
      redirectHost: String(form.get('redirectHost') ?? ''),
      redirectIsLoopback: form.get('redirectIsLoopback') === '1',
      returnTo: String(form.get('returnTo') ?? ''),
      extraScopes: form.getAll('extra').map(String).filter((scope) => supported.includes(scope) && scope !== WRITE),
      wantsWrite: form.get('write') === '1',
    };
    if (await store.locked()) {
      return page('Try again later', consentForm(shown, handle, 'Too many wrong keys. Try again in an hour.'), 429, undefined, shown.returnTo);
    }
    if (!keyMatches(String(form.get('key') ?? ''), env.ACCESS_KEY)) {
      await store.failed();
      return page('Connect to your notes', consentForm(shown, handle, 'That access key isn’t right.'), 401, undefined, shown.returnTo);
    }
    await store.succeeded();
    const scope = [READ, ...(shown.wantsWrite ? [WRITE] : []), ...shown.extraScopes];
    const approved = await oauth.approveConsent(request, handle, { scope });
    const { redirectTo } = await oauth.completeAuthorization({
      request: approved.request,
      userId: 'owner',
      metadata: { label: shown.clientName },
      scope: approved.request.scope,
      props: { userId: 'owner' },
    });
    approved.headers.set('Location', redirectTo);
    return new Response(null, { status: 302, headers: approved.headers });
  } catch (error) {
    return failure(error);
  }
}
