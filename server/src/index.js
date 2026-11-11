/**
 * index.js: your notes server. One Cloudflare Worker that:
 *   - keeps a copy of your notes, synced with your devices (/sync, see syncApi.js)
 *   - lets Claude work with them as a connector, over MCP at /mcp, after you allow it with your
 *     access key (OAuth: /authorize, /oauth/token, /oauth/register)
 *
 * Its address comes from the request, so nothing needs configuring but the access key.
 */
import './dom.js';
import { OAuthProvider, insufficientScope } from '@cloudflare/workers-oauth-provider';
import { McpServer } from '@modelcontextprotocol/server';
import { createMcpHandler } from 'agents/mcp/server';
import { env as workerEnv } from 'cloudflare:workers';
import { READ, WRITE, handleAuthorize } from './authorize.js';
import { OPERATIONS } from './operations.js';
import { escapeHtml, keyIsSet, notesStore } from './shared.js';
import { handleSync } from './syncApi.js';

export { NotesStore } from './store.js';

const SCOPES = [READ, WRITE, 'offline_access'];
const DAY = 86400;

function createServer() {
  const server = new McpServer({ name: 'notes', version: '1.0.0' });
  for (const [name, operation] of Object.entries(OPERATIONS)) {
    server.registerTool(name, {
      title: operation.title,
      description: operation.description,
      inputSchema: operation.schema,
      annotations: {
        title: operation.title, readOnlyHint: !operation.writes, destructiveHint: false, openWorldHint: false,
      },
    }, async (args, context) => {
      const scopes = context?.http?.authInfo?.scopes ?? [];
      const answer = await notesStore(workerEnv).runTool(name, args ?? {}, { canWrite: scopes.includes(WRITE) });
      return answer.ok
        ? { content: [{ type: 'text', text: JSON.stringify(answer.result, null, 1) }] }
        : { content: [{ type: 'text', text: answer.error }], isError: true };
    });
  }
  return server;
}

const mcpHandler = createMcpHandler(createServer, { route: '/mcp' });

const apiHandler = {
  fetch(request, env, ctx) {
    if (!ctx.auth.scope.includes(READ)) return insufficientScope(ctx.auth, [READ]);
    return mcpHandler(request, env, ctx);
  },
};

/** The OAuth side, for the address this Worker answers on. */
const providers = new Map();
function providerFor(origin) {
  if (!providers.has(origin)) {
    providers.set(origin, new OAuthProvider({
      apiRoute: '/mcp',
      apiHandler,
      defaultHandler: {
        fetch(request, env) {
          if (new URL(request.url).pathname === '/authorize') return handleAuthorize(request, env, SCOPES);
          return new Response('Not found', { status: 404 });
        },
      },
      authorizeEndpoint: '/authorize',
      tokenEndpoint: '/oauth/token',
      clientRegistrationEndpoint: '/oauth/register',
      scopesSupported: SCOPES,
      requiredScopes: [READ],
      resourceMetadata: { resource: `${origin}/mcp`, authorization_servers: [origin], resource_name: 'Your notes' },
      // Claude stays connected while it's used at least every 60 days.
      refreshTokenTTL: 60 * DAY,
      refreshTokenIdleTTL: 60 * DAY,
    }));
  }
  return providers.get(origin);
}

function homePage(origin) {
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Your notes server</title></head>
<body style="font: 16px/1.5 system-ui, sans-serif; max-width: 520px; margin: 40px auto; padding: 0 16px">
<h1>Your notes server is running</h1>
<p>In the notes app, open Settings and connect to <code>${escapeHtml(origin)}</code> with your access key.</p>
<p>In Claude, add a custom connector with the address <code>${escapeHtml(origin)}/mcp</code>.</p>
</body></html>`, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'" } });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!keyIsSet(env)) {
      return new Response('This server has no access key yet, or it is shorter than 24 characters. Set one with: npx wrangler secret put ACCESS_KEY', { status: 503 });
    }
    if (url.pathname === '/sync' || url.pathname.startsWith('/sync/')) return handleSync(request, env);
    if (url.pathname === '/' && request.method === 'GET') return homePage(url.origin);
    return providerFor(url.origin).fetch(request, env, ctx);
  },
};
