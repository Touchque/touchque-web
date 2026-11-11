// src/hostedLogin.ts
// Touchque Login for single-page apps: sign in on your tenant's hosted pages
// (acme.login.touchque.com or your own domain) with PKCE, and get tokens for
// your API in the browser.
//
//   const auth = new HostedLoginClient({ domain: 'acme.login.touchque.com', clientId, redirectUri: location.origin + '/callback' });
//   await auth.loginWithRedirect();                     // on a "Sign in" click
//   await auth.handleRedirectCallback();                // on /callback
//   const token = await auth.getAccessToken();          // fresh, refreshed when needed
//   const account = auth.myAccount();                   // the My Account API (/me/v1)
//
// ID tokens are verified in the browser with WebCrypto against the tenant's
// JWKS (RS256, issuer, audience, expiry, nonce). Tokens stay in memory unless
// cacheLocation is 'localstorage' (survives reloads; refresh tokens rotate on
// every use and a reused one ends the whole family).

import { MyAccountClient, issuerFromDomain } from './myAccount';

export class HostedLoginError extends Error {
  readonly code: string;
  readonly description?: string;
  constructor(code: string, description?: string) {
    super(description ? `${code}: ${description}` : code);
    this.name = 'HostedLoginError';
    this.code = code;
    this.description = description;
  }
}

export interface HostedLoginClientOptions {
  domain: string;
  clientId: string;
  redirectUri: string;
  /** Default 'openid profile email offline_access'. */
  scope?: string;
  /** Your API's identifier: access tokens are issued for it. */
  audience?: string;
  /** 'memory' (default) or 'localstorage' (sessions survive reloads). */
  cacheLocation?: 'memory' | 'localstorage';
  /** Seconds of clock difference allowed. Default 60. */
  clockToleranceSec?: number;
}

export interface LoginWithRedirectOptions {
  /** Anything to get back after the sign-in (where the user was). */
  appState?: unknown;
  prompt?: 'none' | 'login' | 'consent' | 'select_account' | 'create';
  screenHint?: 'signup' | 'login';
  loginHint?: string;
  uiLocales?: string;
  connection?: string;
  organization?: string;
  invitation?: string;
  maxAge?: number;
  acrValues?: string;
  extraParams?: Record<string, string>;
}

export interface HostedLoginUser {
  sub: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
  picture?: string;
  org_id?: string;
  [claim: string]: unknown;
}

interface Cached {
  accessToken: string;
  expiresAt: number;
  idToken?: string;
  refreshToken?: string;
  user: HostedLoginUser;
}

const TX_KEY = 'tq.login.tx';
const CACHE_KEY = 'tq.login.session';

const enc = new TextEncoder();
function b64u(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (let i = 0; i < arr.length; i += 1) s += String.fromCharCode(arr[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64uBytes(text: string): Uint8Array<ArrayBuffer> {
  const s = atob(text.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((text.length + 3) % 4));
  const out = new Uint8Array(new ArrayBuffer(s.length));
  for (let i = 0; i < s.length; i += 1) out[i] = s.charCodeAt(i);
  return out;
}
function random(n = 32): string {
  return b64u(crypto.getRandomValues(new Uint8Array(n)));
}
async function sha256(text: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest('SHA-256', enc.encode(text));
}

export class HostedLoginClient {
  readonly issuer: string;
  private readonly o: HostedLoginClientOptions;
  private cache: Cached | null = null;
  private keys: Map<string, CryptoKey> = new Map();
  private keysAt = 0;
  private refreshing: Promise<Cached> | null = null;
  // Every refresh-token use runs one after another: a refresh token is good
  // for one use, and two at once would look like theft and end the session.
  private queue: Promise<unknown> = Promise.resolve();
  private meTokens: Map<string, { accessToken: string; expiresAt: number }> = new Map();

  constructor(options: HostedLoginClientOptions) {
    if (!options?.domain || !options.clientId || !options.redirectUri) throw new HostedLoginError('config', 'domain, clientId and redirectUri are required');
    const issuer = issuerFromDomain(options.domain);
    if (!issuer) throw new HostedLoginError('config', 'domain must be an https:// URL or a host name (http:// only for localhost)');
    this.issuer = issuer;
    this.o = options;
    if (options.cacheLocation === 'localstorage') {
      try {
        const stored = localStorage.getItem(CACHE_KEY);
        if (stored) this.cache = JSON.parse(stored) as Cached;
      } catch { /* storage blocked */ }
    }
  }

  private get tolerance(): number {
    return this.o.clockToleranceSec ?? 60;
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private save(c: Cached | null): void {
    if (!c) this.meTokens.clear();
    this.cache = c;
    if (this.o.cacheLocation !== 'localstorage') return;
    try {
      if (c) localStorage.setItem(CACHE_KEY, JSON.stringify(c));
      else localStorage.removeItem(CACHE_KEY);
    } catch { /* storage blocked */ }
  }

  /** The URL of the hosted sign-in page; the PKCE verifier waits in sessionStorage. */
  async buildAuthorizeUrl(opts: LoginWithRedirectOptions = {}): Promise<string> {
    const state = random();
    const nonce = random();
    const verifier = random(48);
    const challenge = b64u(await sha256(verifier));
    sessionStorage.setItem(TX_KEY, JSON.stringify({ state, nonce, verifier, appState: opts.appState ?? null, maxAge: opts.maxAge }));
    const p = new URLSearchParams({
      response_type: 'code',
      client_id: this.o.clientId,
      redirect_uri: this.o.redirectUri,
      scope: this.o.scope || 'openid profile email offline_access',
      state,
      nonce,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });
    const optional: Record<string, string | number | undefined> = {
      audience: this.o.audience, prompt: opts.prompt, screen_hint: opts.screenHint, login_hint: opts.loginHint,
      ui_locales: opts.uiLocales, connection: opts.connection, organization: opts.organization, invitation: opts.invitation,
      max_age: opts.maxAge, acr_values: opts.acrValues,
    };
    for (const [k, v] of Object.entries(optional)) if (v !== undefined && v !== '') p.set(k, String(v));
    for (const [k, v] of Object.entries(opts.extraParams || {})) p.set(k, v);
    return `${this.issuer}/authorize?${p}`;
  }

  async loginWithRedirect(opts: LoginWithRedirectOptions = {}): Promise<void> {
    window.location.assign(await this.buildAuthorizeUrl(opts));
  }

  /** On the callback page: finishes the sign-in and returns your appState. */
  async handleRedirectCallback(url: string = window.location.href): Promise<{ appState: unknown; user: HostedLoginUser }> {
    const params = new URL(url).searchParams;
    const raw = sessionStorage.getItem(TX_KEY);
    sessionStorage.removeItem(TX_KEY);
    if (!raw) throw new HostedLoginError('state_missing', 'No sign-in was started in this tab');
    const tx = JSON.parse(raw) as { state: string; nonce: string; verifier: string; appState: unknown; maxAge?: number };
    if (params.get('state') !== tx.state) throw new HostedLoginError('state_mismatch', 'The state does not match this sign-in');
    // RFC 9207: a response that carries iss (even an empty one) must name this issuer,
    // the one the ID token is checked against. Servers that do not send iss yet are accepted.
    if (params.has('iss') && params.get('iss') !== this.issuer) {
      const iss = params.get('iss');
      throw new HostedLoginError('issuer_mismatch', iss ? `The response came from ${iss}` : 'The response has an empty iss');
    }
    if (params.get('error')) throw new HostedLoginError(params.get('error') as string, params.get('error_description') || undefined);
    const code = params.get('code');
    if (!code) throw new HostedLoginError('invalid_request', 'The callback has no code');
    const cached = await this.token({ grant_type: 'authorization_code', code, redirect_uri: this.o.redirectUri, code_verifier: tx.verifier }, { nonce: tx.nonce, maxAge: tx.maxAge });
    // A new sign-in (for example after a step-up): My Account tokens start over with its auth_time.
    this.meTokens.clear();
    this.save(cached);
    return { appState: tx.appState, user: cached.user };
  }

  /** True when the URL looks like a sign-in callback for this app. */
  static isCallback(url: string = window.location.href): boolean {
    const p = new URL(url).searchParams;
    return p.has('state') && (p.has('code') || p.has('error'));
  }

  isAuthenticated(): boolean {
    return Boolean(this.cache && (this.cache.expiresAt > Date.now() / 1000 || this.cache.refreshToken));
  }

  getUser(): HostedLoginUser | null {
    return this.cache?.user || null;
  }

  /** A valid access token, refreshed (and the refresh token rotated) when needed. */
  async getAccessToken(): Promise<string> {
    const c = this.cache;
    if (!c) throw new HostedLoginError('login_required', 'Not signed in');
    if (c.expiresAt - 30 > Date.now() / 1000) return c.accessToken;
    if (!c.refreshToken) {
      this.save(null);
      throw new HostedLoginError('login_required', 'The session ended');
    }
    if (!this.refreshing) {
      this.refreshing = this.serial(() => {
        const cur = this.cache || c;
        return this.token({ grant_type: 'refresh_token', refresh_token: cur.refreshToken as string }, {}, cur);
      })
        .then((next) => { this.save(next); return next; })
        // Only a refused refresh token ends the session: offline or a 5xx, the next call tries again.
        .catch((err) => { if (err instanceof HostedLoginError && err.code === 'invalid_grant') this.save(null); throw err; })
        .finally(() => { this.refreshing = null; });
    }
    return (await this.refreshing).accessToken;
  }

  /**
   * An access token for the My Account API (audience https://<domain>/me/),
   * got with the refresh token this app holds (first-party apps with
   * offline_access). Scopes: read:me, update:me, manage:me:security, delete:me.
   */
  async getMyAccountToken(scope = 'read:me update:me'): Promise<string> {
    const key = scope.split(' ').filter(Boolean).sort().join(' ');
    const hit = this.meTokens.get(key);
    if (hit && hit.expiresAt - 30 > Date.now() / 1000) return hit.accessToken;
    const fresh = await this.serial(async () => {
      const cur = this.cache;
      if (!cur?.refreshToken) throw new HostedLoginError('login_required', 'Not signed in, or no refresh token (ask for offline_access)');
      const res = await fetch(`${this.issuer}/oauth/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: cur.refreshToken, audience: `${this.issuer}/me/`, scope: key, client_id: this.o.clientId }),
      });
      const d = (await res.json().catch(() => ({}))) as Record<string, string | number>;
      if (!res.ok) {
        if (d.error === 'invalid_grant') this.save(null);
        throw new HostedLoginError(String(d.error || `http_${res.status}`), d.error_description ? String(d.error_description) : undefined);
      }
      if (typeof d.refresh_token === 'string') this.save({ ...cur, refreshToken: d.refresh_token });
      return { accessToken: String(d.access_token), expiresAt: Math.floor(Date.now() / 1000) + Number(d.expires_in || 0) };
    });
    this.meTokens.set(key, fresh);
    return fresh.accessToken;
  }

  /** The My Account API for the signed-in person, with tokens for `scope`. */
  myAccount(scope = 'read:me update:me manage:me:security'): MyAccountClient {
    return new MyAccountClient({ domain: this.issuer, getAccessToken: () => this.getMyAccountToken(scope) });
  }

  /** The hosted account page (profile, security, devices, privacy). */
  accountUrl(section?: 'security' | 'devices' | 'privacy'): string {
    return `${this.issuer}/account${section ? `/${section}` : ''}`;
  }

  /** Signs out here and on the hosted pages; `returnTo` must be a registered sign-out URL. */
  async logout({ returnTo }: { returnTo?: string } = {}): Promise<void> {
    const c = this.cache;
    if (c?.refreshToken) {
      fetch(`${this.issuer}/oauth/revoke`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: c.refreshToken, client_id: this.o.clientId }) }).catch(() => {});
    }
    this.save(null);
    const p = new URLSearchParams({ client_id: this.o.clientId });
    if (c?.idToken) p.set('id_token_hint', c.idToken);
    if (returnTo) p.set('post_logout_redirect_uri', returnTo);
    window.location.assign(`${this.issuer}/oidc/logout?${p}`);
  }

  // ── internals ────────────────────────────────────────────────────────────

  private async token(fields: Record<string, string>, checks: { nonce?: string; maxAge?: number }, previous?: Cached): Promise<Cached> {
    const res = await fetch(`${this.issuer}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({ ...fields, client_id: this.o.clientId }),
    });
    const d = (await res.json().catch(() => ({}))) as Record<string, string | number>;
    if (!res.ok) throw new HostedLoginError(String(d.error || `http_${res.status}`), d.error_description ? String(d.error_description) : undefined);
    let user = previous?.user as HostedLoginUser;
    if (typeof d.id_token === 'string') user = await this.verifyIdToken(d.id_token, String(d.access_token), checks);
    if (!user) throw new HostedLoginError('invalid_token', 'No ID token: ask for the openid scope');
    return {
      accessToken: String(d.access_token),
      expiresAt: Math.floor(Date.now() / 1000) + Number(d.expires_in || 0),
      idToken: typeof d.id_token === 'string' ? d.id_token : previous?.idToken,
      refreshToken: typeof d.refresh_token === 'string' ? d.refresh_token : previous?.refreshToken,
      user,
    };
  }

  private async loadKeys(force: boolean): Promise<void> {
    if (!force && this.keys.size && Date.now() - this.keysAt < 3600_000) return;
    if (force && Date.now() - this.keysAt < 30_000) return;
    const res = await fetch(`${this.issuer}/.well-known/jwks.json`);
    if (!res.ok) throw new HostedLoginError('jwks_unavailable', `JWKS answered ${res.status}`);
    const { keys } = (await res.json()) as { keys: Array<{ kty: string; kid?: string; n?: string; e?: string; use?: string }> };
    const next = new Map<string, CryptoKey>();
    for (const k of keys || []) {
      if (k.kty === 'RSA' && k.kid && k.n && k.e && (!k.use || k.use === 'sig')) {
        next.set(k.kid, await crypto.subtle.importKey('jwk', { kty: 'RSA', n: k.n, e: k.e, alg: 'RS256', ext: true }, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']));
      }
    }
    this.keys = next;
    this.keysAt = Date.now();
  }

  private async verifyIdToken(token: string, accessToken: string, { nonce, maxAge }: { nonce?: string; maxAge?: number }): Promise<HostedLoginUser> {
    const parts = token.split('.');
    if (parts.length !== 3) throw new HostedLoginError('invalid_token', 'not a JWT');
    const header = JSON.parse(new TextDecoder().decode(b64uBytes(parts[0])));
    const payload = JSON.parse(new TextDecoder().decode(b64uBytes(parts[1])));
    if (header.alg !== 'RS256') throw new HostedLoginError('invalid_token', 'Unexpected alg');
    await this.loadKeys(false);
    if (!this.keys.has(header.kid)) await this.loadKeys(true);
    const key = this.keys.get(header.kid);
    if (!key) throw new HostedLoginError('invalid_token', 'Unknown signing key');
    const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64uBytes(parts[2]), enc.encode(`${parts[0]}.${parts[1]}`));
    if (!ok) throw new HostedLoginError('invalid_token', 'Bad signature');
    const now = Date.now() / 1000;
    const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (payload.iss !== this.issuer) throw new HostedLoginError('invalid_token', 'Wrong issuer');
    if (!auds.includes(this.o.clientId)) throw new HostedLoginError('invalid_token', 'The ID token is for another app');
    if (typeof payload.exp !== 'number' || now > payload.exp + this.tolerance) throw new HostedLoginError('invalid_token', 'The ID token expired');
    if (nonce !== undefined && payload.nonce !== nonce) throw new HostedLoginError('nonce_mismatch', 'The nonce does not match this sign-in');
    if (typeof payload.at_hash === 'string' && payload.at_hash !== b64u((await sha256(accessToken)).slice(0, 16))) {
      throw new HostedLoginError('invalid_token', 'at_hash does not match the access token');
    }
    if (maxAge !== undefined && typeof payload.auth_time === 'number' && now - payload.auth_time > maxAge + this.tolerance) {
      throw new HostedLoginError('login_required', 'The sign-in is older than maxAge');
    }
    return payload as HostedLoginUser;
  }
}
