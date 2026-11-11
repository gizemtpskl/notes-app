/**
 * syncApi.js: how your devices sync with the server. Every request carries the access key you
 * chose (ACCESS_KEY, a Worker secret) as a Bearer token. After too many wrong keys the server
 * stops answering for an hour.
 *
 *   GET    /sync/info          { version, lock, timeZone }
 *   GET    /sync/copy          { version, records, deleted }
 *   PUT    /sync/copy          { baseVersion, records, deleted, timeZone } -> { version } or 409
 *   POST   /sync/lock          the passphrase lock for private notes, set once
 *   GET    /sync/assets        { ids }
 *   GET    /sync/assets/:id    an image
 *   PUT    /sync/assets/:id    an image
 *   DELETE /sync/assets/:id
 */
import { keyMatches, notesStore } from './shared.js';

const MAX_COPY_BYTES = 25 * 1024 * 1024;
const MAX_ASSET_BYTES = 1.9 * 1024 * 1024; // A row in the server's database holds up to 2 MB.
const ASSET_ID = /^[\w-]{1,128}$/;

function cors(request) {
  return {
    'Access-Control-Allow-Origin': request.headers.get('Origin') || '*',
    'Access-Control-Allow-Methods': 'GET, PUT, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

const json = (request, data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...cors(request) },
});

async function readBody(request, max) {
  const text = await request.text();
  if (text.length > max) return { tooBig: true };
  try {
    return { value: JSON.parse(text) };
  } catch {
    return { bad: true };
  }
}

export async function handleSync(request, env) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(request) });
  const store = notesStore(env);
  if (await store.locked()) return json(request, { error: 'Too many wrong keys. Try again in an hour.' }, 429);
  const given = (request.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (!keyMatches(given, env.ACCESS_KEY)) {
    await store.failed();
    return json(request, { error: 'That access key isn’t right.' }, 401);
  }

  const path = new URL(request.url).pathname.replace(/\/+$/, '');
  const { method } = request;

  if (path === '/sync/info' && method === 'GET') return json(request, await store.info());
  if (path === '/sync/copy' && method === 'GET') return json(request, await store.copy());
  if (path === '/sync/copy' && method === 'PUT') {
    const body = await readBody(request, MAX_COPY_BYTES);
    if (body.tooBig) return json(request, { error: 'Your notes are over 25 MB.' }, 413);
    const value = body.value;
    if (body.bad || !value || typeof value.records !== 'object' || typeof value.deleted !== 'object' || !Number.isInteger(value.baseVersion)) {
      return json(request, { error: 'That isn’t a copy of your notes.' }, 400);
    }
    const saved = await store.replace(value);
    return json(request, saved, saved.ok ? 200 : 409);
  }
  if (path === '/sync/lock' && method === 'POST') {
    const body = await readBody(request, 10_000);
    if (body.bad || !body.value?.lock) return json(request, { error: 'No lock given.' }, 400);
    return json(request, await store.setLock(body.value.lock));
  }
  if (path === '/sync/assets' && method === 'GET') return json(request, { ids: await store.assetIds() });

  const asset = path.match(/^\/sync\/assets\/([^/]+)$/);
  if (asset && ASSET_ID.test(asset[1])) {
    const id = asset[1];
    if (method === 'GET') {
      const text = await store.asset(id);
      return text === null ? json(request, { error: 'No such image.' }, 404) : new Response(text, { headers: { 'Content-Type': 'application/json', ...cors(request) } });
    }
    if (method === 'PUT') {
      const text = await request.text();
      if (text.length > MAX_ASSET_BYTES) return json(request, { error: 'That image is too large to sync.' }, 413);
      await store.putAsset(id, text);
      return json(request, { ok: true });
    }
    if (method === 'DELETE') {
      await store.removeAsset(id);
      return json(request, { ok: true });
    }
  }
  return json(request, { error: 'Not found.' }, 404);
}
