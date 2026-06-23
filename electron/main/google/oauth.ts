// electron/main/google/oauth.ts
//
// Pure + fetch-based building blocks for the Google OAuth 2.0 "desktop app"
// (loopback) flow. No Electron / Node-server concerns live here so the token
// logic is unit-testable with an injected fetch. The orchestration (loopback
// HTTP server, opening the system browser, secure token storage) lives in
// ./auth.ts.
//
// We use PKCE (S256) in addition to the client secret. Desktop OAuth clients
// get a "secret" that Google itself documents as non-confidential, so PKCE is
// what actually protects the code exchange.

import crypto from 'node:crypto';

export const GOOGLE_AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
export const GOOGLE_USERINFO_ENDPOINT = 'https://www.googleapis.com/oauth2/v3/userinfo';

/** Scopes requested at sign-in. One consent covers both Tasks export and
 *  Doc export (via Drive's per-file `drive.file` scope), plus openid/email
 *  so we can show which account is connected. */
export const GOOGLE_SCOPES: readonly string[] = [
  'https://www.googleapis.com/auth/tasks',
  'https://www.googleapis.com/auth/drive.file',
  'openid',
  'email',
];

export type FetchImpl = typeof fetch;

/** URL-safe random string (base64url, no padding). Used for `state` and the
 *  PKCE code verifier. */
export function randomUrlSafe(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

/** S256 PKCE challenge for a verifier. */
export function pkceChallenge(verifier: string): string {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}

export interface ConsentUrlParams {
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
  scopes?: readonly string[];
}

/** Build the Google consent-screen URL the user is sent to in their browser. */
export function buildConsentUrl(p: ConsentUrlParams): string {
  const u = new URL(GOOGLE_AUTH_ENDPOINT);
  u.searchParams.set('client_id', p.clientId);
  u.searchParams.set('redirect_uri', p.redirectUri);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('scope', (p.scopes ?? GOOGLE_SCOPES).join(' '));
  u.searchParams.set('state', p.state);
  u.searchParams.set('code_challenge', p.codeChallenge);
  u.searchParams.set('code_challenge_method', 'S256');
  // offline + consent so Google returns a refresh_token (needed for
  // long-lived, sign-in-once access).
  u.searchParams.set('access_type', 'offline');
  u.searchParams.set('prompt', 'consent');
  return u.toString();
}

export interface TokenSet {
  accessToken: string;
  /** Null on a refresh (Google only returns refresh_token on first consent). */
  refreshToken: string | null;
  /** Seconds until the access token expires. */
  expiresInSec: number;
}

interface GoogleTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

async function postToken(
  fetchImpl: FetchImpl,
  body: Record<string, string>,
): Promise<GoogleTokenResponse> {
  const resp = await fetchImpl(GOOGLE_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
  });
  const json = (await resp.json().catch(() => ({}))) as GoogleTokenResponse;
  if (!resp.ok || json.error) {
    throw new Error(
      `Google token endpoint ${resp.status}: ${json.error ?? ''} ${json.error_description ?? ''}`.trim(),
    );
  }
  return json;
}

/** Exchange an authorization code (from the loopback callback) for tokens. */
export async function exchangeCodeForTokens(
  fetchImpl: FetchImpl,
  args: {
    clientId: string;
    clientSecret: string;
    code: string;
    redirectUri: string;
    codeVerifier: string;
  },
): Promise<TokenSet> {
  const json = await postToken(fetchImpl, {
    grant_type: 'authorization_code',
    client_id: args.clientId,
    client_secret: args.clientSecret,
    code: args.code,
    redirect_uri: args.redirectUri,
    code_verifier: args.codeVerifier,
  });
  if (!json.access_token) throw new Error('Google token response had no access_token');
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token ?? null,
    expiresInSec: json.expires_in ?? 3600,
  };
}

/** Trade a stored refresh token for a fresh access token. */
export async function refreshAccessToken(
  fetchImpl: FetchImpl,
  args: { clientId: string; clientSecret: string; refreshToken: string },
): Promise<{ accessToken: string; expiresInSec: number }> {
  const json = await postToken(fetchImpl, {
    grant_type: 'refresh_token',
    client_id: args.clientId,
    client_secret: args.clientSecret,
    refresh_token: args.refreshToken,
  });
  if (!json.access_token) throw new Error('Google refresh response had no access_token');
  return { accessToken: json.access_token, expiresInSec: json.expires_in ?? 3600 };
}

/** Fetch the connected account's email for display. Best-effort: returns
 *  null on any failure (we don't want a missing email to block sign-in). */
export async function fetchAccountEmail(
  fetchImpl: FetchImpl,
  accessToken: string,
): Promise<string | null> {
  try {
    const resp = await fetchImpl(GOOGLE_USERINFO_ENDPOINT, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    if (!resp.ok) return null;
    const json = (await resp.json()) as { email?: string };
    return typeof json.email === 'string' ? json.email : null;
  } catch {
    return null;
  }
}

/** Validate + extract `code` from a loopback callback URL, checking `state`.
 *  Throws on a state mismatch or an error param (e.g. access_denied). */
export function parseCallbackUrl(rawUrl: string, expectedState: string): string {
  const u = new URL(rawUrl, 'http://127.0.0.1');
  const err = u.searchParams.get('error');
  if (err) throw new Error(`Google sign-in failed: ${err}`);
  const state = u.searchParams.get('state');
  if (state !== expectedState) throw new Error('Google sign-in state mismatch (possible CSRF)');
  const code = u.searchParams.get('code');
  if (!code) throw new Error('Google sign-in callback had no code');
  return code;
}
