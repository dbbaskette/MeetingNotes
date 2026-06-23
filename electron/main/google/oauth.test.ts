import { describe, it, expect, vi } from 'vitest';
import {
  buildConsentUrl, pkceChallenge, randomUrlSafe, parseCallbackUrl,
  exchangeCodeForTokens, refreshAccessToken, fetchAccountEmail,
  GOOGLE_TOKEN_ENDPOINT, GOOGLE_SCOPES,
} from './oauth.js';

describe('buildConsentUrl', () => {
  it('includes client id, redirect, scopes, PKCE, and offline consent', () => {
    const url = new URL(buildConsentUrl({
      clientId: 'cid', redirectUri: 'http://127.0.0.1:51000/callback',
      state: 'st8', codeChallenge: 'chal',
    }));
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    const q = url.searchParams;
    expect(q.get('client_id')).toBe('cid');
    expect(q.get('redirect_uri')).toBe('http://127.0.0.1:51000/callback');
    expect(q.get('response_type')).toBe('code');
    expect(q.get('state')).toBe('st8');
    expect(q.get('code_challenge')).toBe('chal');
    expect(q.get('code_challenge_method')).toBe('S256');
    expect(q.get('access_type')).toBe('offline');
    expect(q.get('prompt')).toBe('consent');
    expect(q.get('scope')).toBe(GOOGLE_SCOPES.join(' '));
  });
});

describe('pkce', () => {
  it('produces a stable S256 challenge for a verifier', () => {
    expect(pkceChallenge('abc')).toBe(pkceChallenge('abc'));
    expect(pkceChallenge('abc')).not.toBe(pkceChallenge('xyz'));
    expect(randomUrlSafe(8)).not.toBe(randomUrlSafe(8));
  });
});

describe('parseCallbackUrl', () => {
  it('returns the code when state matches', () => {
    expect(parseCallbackUrl('/callback?code=AUTH123&state=S', 'S')).toBe('AUTH123');
  });
  it('rejects a state mismatch', () => {
    expect(() => parseCallbackUrl('/callback?code=x&state=BAD', 'S')).toThrow(/state mismatch/i);
  });
  it('surfaces an error param', () => {
    expect(() => parseCallbackUrl('/callback?error=access_denied&state=S', 'S')).toThrow(/access_denied/);
  });
  it('rejects a missing code', () => {
    expect(() => parseCallbackUrl('/callback?state=S', 'S')).toThrow(/no code/i);
  });
});

function fakeFetchOnce(status: number, body: unknown): typeof fetch {
  return vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  })) as unknown as typeof fetch;
}

describe('exchangeCodeForTokens', () => {
  it('POSTs the code + verifier and returns the token set', async () => {
    const fetchImpl = fakeFetchOnce(200, {
      access_token: 'AT', refresh_token: 'RT', expires_in: 3599,
    });
    const out = await exchangeCodeForTokens(fetchImpl, {
      clientId: 'c', clientSecret: 's', code: 'CODE', redirectUri: 'http://127.0.0.1/cb', codeVerifier: 'v',
    });
    expect(out).toEqual({ accessToken: 'AT', refreshToken: 'RT', expiresInSec: 3599 });
    const [url, init] = (fetchImpl as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0]!;
    expect(url).toBe(GOOGLE_TOKEN_ENDPOINT);
    expect(String(init.body)).toContain('grant_type=authorization_code');
    expect(String(init.body)).toContain('code_verifier=v');
  });
  it('throws on an error response', async () => {
    const fetchImpl = fakeFetchOnce(400, { error: 'invalid_grant' });
    await expect(exchangeCodeForTokens(fetchImpl, {
      clientId: 'c', clientSecret: 's', code: 'X', redirectUri: 'r', codeVerifier: 'v',
    })).rejects.toThrow(/invalid_grant/);
  });
});

describe('refreshAccessToken', () => {
  it('returns a fresh access token', async () => {
    const fetchImpl = fakeFetchOnce(200, { access_token: 'AT2', expires_in: 3600 });
    const out = await refreshAccessToken(fetchImpl, { clientId: 'c', clientSecret: 's', refreshToken: 'RT' });
    expect(out).toEqual({ accessToken: 'AT2', expiresInSec: 3600 });
  });
});

describe('fetchAccountEmail', () => {
  it('returns the email on success', async () => {
    const fetchImpl = fakeFetchOnce(200, { email: 'a@b.com' });
    expect(await fetchAccountEmail(fetchImpl, 'AT')).toBe('a@b.com');
  });
  it('returns null on failure rather than throwing', async () => {
    const fetchImpl = fakeFetchOnce(401, {});
    expect(await fetchAccountEmail(fetchImpl, 'AT')).toBeNull();
  });
});
