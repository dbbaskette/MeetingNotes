// electron/main/google/auth.ts
//
// Google account lifecycle for the desktop (loopback) OAuth flow. Owns the
// access-token cache + refresh, the one-shot loopback HTTP server, and the
// sign-in/out orchestration. All storage + side effects (settings,
// safeStorage encryption, opening the browser) are injected so the
// token/refresh logic stays unit-testable.

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  buildConsentUrl, exchangeCodeForTokens, refreshAccessToken, fetchAccountEmail,
  parseCallbackUrl, pkceChallenge, randomUrlSafe, type FetchImpl,
} from './oauth.js';

export interface GoogleCredentials { clientId: string; clientSecret: string; }

export interface GoogleAuthDeps {
  /** OAuth client credentials: BYO from settings, or a shipped default.
   *  Returns null when neither is configured (sign-in unavailable). */
  getCredentials: () => GoogleCredentials | null;
  /** Decrypted refresh token, or null when not signed in. */
  getRefreshToken: () => string | null;
  /** Persist the refresh token (the impl encrypts via safeStorage) or clear
   *  it with null. */
  setRefreshToken: (token: string | null) => void;
  getAccountEmail: () => string | null;
  setAccountEmail: (email: string | null) => void;
  /** Open the consent URL in the system browser (shell.openExternal). */
  openExternal: (url: string) => Promise<void>;
  fetchImpl?: FetchImpl;
  /** Test seam — defaults to node http.createServer. */
  createServer?: typeof http.createServer;
  /** Max time to wait for the browser callback before giving up. */
  signInTimeoutMs?: number;
  log?: (msg: string, data?: Record<string, unknown>) => void;
}

const TOKEN_REFRESH_BUFFER_MS = 60_000;

export class GoogleAuth {
  private accessToken: string | null = null;
  private accessTokenExpiresAt = 0;
  private signInInFlight: Promise<{ email: string | null }> | null = null;

  constructor(private readonly deps: GoogleAuthDeps) {}

  private get fetchImpl(): FetchImpl { return this.deps.fetchImpl ?? fetch; }

  hasCredentials(): boolean { return this.deps.getCredentials() !== null; }
  isSignedIn(): boolean { return this.deps.getRefreshToken() !== null; }
  getConnectedEmail(): string | null { return this.deps.getAccountEmail(); }

  /** Begin (or join) an interactive sign-in. Resolves with the connected
   *  account email once tokens are stored. */
  async startSignIn(): Promise<{ email: string | null }> {
    if (this.signInInFlight) return this.signInInFlight;
    this.signInInFlight = this.runSignIn().finally(() => { this.signInInFlight = null; });
    return this.signInInFlight;
  }

  private async runSignIn(): Promise<{ email: string | null }> {
    const creds = this.deps.getCredentials();
    if (!creds) throw new Error('Add a Google OAuth Client ID + Secret in Settings first.');
    const state = randomUrlSafe();
    const verifier = randomUrlSafe(48);
    const challenge = pkceChallenge(verifier);

    const loopback = await this.startLoopback(state);
    try {
      const url = buildConsentUrl({
        clientId: creds.clientId, redirectUri: loopback.redirectUri, state, codeChallenge: challenge,
      });
      await this.deps.openExternal(url);
      const code = await loopback.codePromise;
      return await this.completeAuthorization(code, verifier, loopback.redirectUri);
    } finally {
      loopback.close();
    }
  }

  /** Exchange a callback code for tokens and persist them. Separated from the
   *  loopback orchestration so it's unit-testable with an injected fetch. */
  async completeAuthorization(
    code: string, codeVerifier: string, redirectUri: string,
  ): Promise<{ email: string | null }> {
    const creds = this.deps.getCredentials();
    if (!creds) throw new Error('Google OAuth credentials missing.');
    const tokens = await exchangeCodeForTokens(this.fetchImpl, {
      clientId: creds.clientId, clientSecret: creds.clientSecret,
      code, redirectUri, codeVerifier,
    });
    if (tokens.refreshToken) this.deps.setRefreshToken(tokens.refreshToken);
    this.accessToken = tokens.accessToken;
    this.accessTokenExpiresAt = Date.now() + tokens.expiresInSec * 1000;
    const email = await fetchAccountEmail(this.fetchImpl, tokens.accessToken);
    this.deps.setAccountEmail(email);
    this.deps.log?.('google:signed-in', { email });
    return { email };
  }

  /** A live access token, refreshing via the stored refresh token when the
   *  cached one is missing or about to expire. Throws (and clears the session)
   *  if the refresh token is revoked/expired. */
  async getAccessToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.accessTokenExpiresAt - TOKEN_REFRESH_BUFFER_MS) {
      return this.accessToken;
    }
    const creds = this.deps.getCredentials();
    const refreshToken = this.deps.getRefreshToken();
    if (!creds || !refreshToken) {
      throw new Error('Not signed in to Google — connect your account in Settings.');
    }
    try {
      const { accessToken, expiresInSec } = await refreshAccessToken(this.fetchImpl, {
        clientId: creds.clientId, clientSecret: creds.clientSecret, refreshToken,
      });
      this.accessToken = accessToken;
      this.accessTokenExpiresAt = Date.now() + expiresInSec * 1000;
      return accessToken;
    } catch (e) {
      // Most refresh failures are a revoked/expired refresh token — force a
      // re-sign-in rather than leaving the user stuck.
      this.signOut();
      throw new Error('Google session expired — reconnect your account in Settings.');
    }
  }

  signOut(): void {
    this.deps.setRefreshToken(null);
    this.deps.setAccountEmail(null);
    this.accessToken = null;
    this.accessTokenExpiresAt = 0;
    this.deps.log?.('google:signed-out');
  }

  // ── Loopback server ────────────────────────────────────────────────────
  // Google's installed-app flow allows any 127.0.0.1 port, so we bind an
  // ephemeral one and use it as the redirect target. The server lives only
  // for the duration of one sign-in.
  private async startLoopback(
    expectedState: string,
  ): Promise<{ redirectUri: string; codePromise: Promise<string>; close: () => void }> {
    const createServer = this.deps.createServer ?? http.createServer;
    let resolveCode!: (code: string) => void;
    let rejectCode!: (err: Error) => void;
    const codePromise = new Promise<string>((res, rej) => { resolveCode = res; rejectCode = rej; });

    const server = createServer((req, res) => {
      const reqUrl = req.url ?? '/';
      // Ignore stray requests (favicon, etc.) that carry no OAuth params.
      if (!/[?&](code|error)=/.test(reqUrl)) {
        res.statusCode = 204; res.end(); return;
      }
      try {
        const code = parseCallbackUrl(reqUrl, expectedState);
        res.statusCode = 200;
        res.setHeader('content-type', 'text/html');
        res.end(SUCCESS_PAGE_HTML);
        resolveCode(code);
      } catch (e) {
        res.statusCode = 400;
        res.setHeader('content-type', 'text/html');
        res.end(ERROR_PAGE_HTML);
        rejectCode(e instanceof Error ? e : new Error(String(e)));
      }
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    const redirectUri = `http://127.0.0.1:${port}`;

    const timeoutMs = this.deps.signInTimeoutMs ?? 5 * 60_000;
    const timer = setTimeout(
      () => rejectCode(new Error('Google sign-in timed out — no response from the browser.')),
      timeoutMs,
    );
    const close = (): void => { clearTimeout(timer); server.close(); };
    return { redirectUri, codePromise, close };
  }
}

const SUCCESS_PAGE_HTML =
  '<!doctype html><meta charset="utf-8"><title>MeetingNotes</title>' +
  '<body style="font-family:system-ui;text-align:center;padding:3rem;color:#1c1c1f">' +
  '<h2>✓ Connected to Google</h2><p>You can close this tab and return to MeetingNotes.</p></body>';

const ERROR_PAGE_HTML =
  '<!doctype html><meta charset="utf-8"><title>MeetingNotes</title>' +
  '<body style="font-family:system-ui;text-align:center;padding:3rem;color:#b91c1c">' +
  '<h2>Sign-in failed</h2><p>Return to MeetingNotes and try again.</p></body>';
