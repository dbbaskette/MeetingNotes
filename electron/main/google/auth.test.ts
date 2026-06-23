import { describe, it, expect, vi } from 'vitest';
import { GoogleAuth, type GoogleAuthDeps } from './auth.js';
import { GOOGLE_TOKEN_ENDPOINT, GOOGLE_USERINFO_ENDPOINT } from './oauth.js';

/** A fetch that routes by URL to scripted JSON responses. */
function routedFetch(routes: Record<string, { status: number; body: unknown }>): typeof fetch {
  return vi.fn(async (url: string | URL) => {
    const key = String(url);
    const r = routes[key];
    if (!r) throw new Error(`unexpected fetch: ${key}`);
    return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body };
  }) as unknown as typeof fetch;
}

function makeDeps(over: Partial<GoogleAuthDeps> = {}): GoogleAuthDeps & {
  store: { refresh: string | null; email: string | null };
} {
  const store = { refresh: null as string | null, email: null as string | null };
  const deps: GoogleAuthDeps = {
    getCredentials: () => ({ clientId: 'cid', clientSecret: 'sec' }),
    getRefreshToken: () => store.refresh,
    setRefreshToken: (t) => { store.refresh = t; },
    getAccountEmail: () => store.email,
    setAccountEmail: (e) => { store.email = e; },
    openExternal: async () => {},
    ...over,
  };
  return Object.assign(deps, { store });
}

describe('GoogleAuth.completeAuthorization', () => {
  it('exchanges the code, stores the refresh token, and records the email', async () => {
    const deps = makeDeps({
      fetchImpl: routedFetch({
        [GOOGLE_TOKEN_ENDPOINT]: { status: 200, body: { access_token: 'AT', refresh_token: 'RT', expires_in: 3600 } },
        [GOOGLE_USERINFO_ENDPOINT]: { status: 200, body: { email: 'me@example.com' } },
      }),
    });
    const auth = new GoogleAuth(deps);
    const out = await auth.completeAuthorization('CODE', 'verifier', 'http://127.0.0.1:5000');
    expect(out.email).toBe('me@example.com');
    expect(deps.store.refresh).toBe('RT');
    expect(deps.store.email).toBe('me@example.com');
    expect(auth.isSignedIn()).toBe(true);
    // Access token is cached — getAccessToken shouldn't need to refresh.
    expect(await auth.getAccessToken()).toBe('AT');
  });
});

describe('GoogleAuth.getAccessToken', () => {
  it('refreshes using the stored refresh token when there is no cached token', async () => {
    const deps = makeDeps({
      getRefreshToken: () => 'RT',
      fetchImpl: routedFetch({
        [GOOGLE_TOKEN_ENDPOINT]: { status: 200, body: { access_token: 'FRESH', expires_in: 3600 } },
      }),
    });
    const auth = new GoogleAuth(deps);
    expect(await auth.getAccessToken()).toBe('FRESH');
  });

  it('throws when not signed in', async () => {
    const auth = new GoogleAuth(makeDeps({ getRefreshToken: () => null }));
    await expect(auth.getAccessToken()).rejects.toThrow(/Not signed in/);
  });

  it('clears the session and asks to reconnect when the refresh token is revoked', async () => {
    const deps = makeDeps({
      fetchImpl: routedFetch({
        [GOOGLE_TOKEN_ENDPOINT]: { status: 400, body: { error: 'invalid_grant' } },
      }),
    });
    deps.store.refresh = 'RT'; // default getRefreshToken reads store.refresh
    const auth = new GoogleAuth(deps);
    await expect(auth.getAccessToken()).rejects.toThrow(/reconnect/i);
    expect(deps.store.refresh).toBeNull(); // session cleared
    expect(auth.isSignedIn()).toBe(false);
  });
});

describe('GoogleAuth.signOut', () => {
  it('clears stored tokens + email', () => {
    const deps = makeDeps();
    deps.store.refresh = 'RT'; deps.store.email = 'me@x.com';
    const auth = new GoogleAuth(deps);
    auth.signOut();
    expect(deps.store.refresh).toBeNull();
    expect(deps.store.email).toBeNull();
    expect(auth.isSignedIn()).toBe(false);
  });
});

describe('GoogleAuth.startSignIn', () => {
  it('refuses when no credentials are configured', async () => {
    const auth = new GoogleAuth(makeDeps({ getCredentials: () => null }));
    await expect(auth.startSignIn()).rejects.toThrow(/Client ID/i);
  });
});
