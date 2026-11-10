/**
 * googleErrors.js: turns the body of a failed Google API answer into one short reason code.
 *
 * Google reports the same problem in more than one way: older answers carry
 * error.errors[0].reason, newer ones error.details[].reason or only a message. The codes here
 * are the ones the app explains in plain English:
 *   apiOff     the API isn't turned on in the Google project (or was only just turned on)
 *   scope      the token doesn't cover this API: its box wasn't ticked on Google's page
 *   rateLimit  too many requests; try again later
 * Anything else comes back as Google's own code, or ''.
 */

export function googleErrorReason(body) {
  const error = body?.error ?? {};
  const codes = [
    ...(Array.isArray(error.errors) ? error.errors.map((e) => e?.reason) : []),
    ...(Array.isArray(error.details) ? error.details.map((d) => d?.reason) : []),
  ].filter((code) => typeof code === 'string');
  const message = typeof error.message === 'string' ? error.message : '';
  const has = (...wanted) => codes.some((code) => wanted.includes(code));

  if (has('accessNotConfigured', 'SERVICE_DISABLED') || /has not been used in project|is disabled/i.test(message)) return 'apiOff';
  if (has('insufficientPermissions', 'ACCESS_TOKEN_SCOPE_INSUFFICIENT') || /insufficient authentication scopes/i.test(message)) return 'scope';
  if (has('rateLimitExceeded', 'userRateLimitExceeded', 'RATE_LIMIT_EXCEEDED')) return 'rateLimit';
  return codes[0] ?? '';
}

/** Reads a failed fetch Response. Never throws: an unreadable body gives ''. */
export async function readGoogleErrorReason(response) {
  try {
    return googleErrorReason(await response.json());
  } catch {
    return '';
  }
}
