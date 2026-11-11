// src/myAccount.ts
// The Touchque Login My Account API (/me/v1) from the browser: the signed-in
// customer's profile, sign-in methods, devices, apps and data, for your own
// "Account settings" screens.
//
//   const account = auth.myAccount();                   // HostedLoginClient
//   const { profile } = await account.get();
//   await account.updateProfile({ name: 'Zoë Ng' });
//
// Security changes, the data export and deletion need a recent sign-in. When
// it is too old the call throws MyAccountError with stepUp true: sign the
// person in again with loginWithRedirect({ maxAge: 0 }) and retry.
// Passkeys are added on the account page (accountPageUrl('security')).

/**
 * @internal The issuer for a Touchque Login domain (`acme.login.touchque.com`
 * or a full URL), or `null` when it is not a URL or is plaintext http:// to
 * anything but this machine: codes, PKCE verifiers and tokens would travel in
 * the clear.
 */
export function issuerFromDomain(domain: string): string | null {
  const raw = domain.replace(/\/+$/, '');
  const issuer = /^https?:\/\//.test(raw) ? raw : `https://${raw}`;
  let url: URL;
  try { url = new URL(issuer); } catch { return null; }
  if (url.protocol === 'https:') return issuer;
  const host = url.hostname.toLowerCase();
  return host === 'localhost' || host.endsWith('.localhost') || host === '127.0.0.1' || host === '[::1]' ? issuer : null;
}

export class MyAccountError extends Error {
  readonly code: string;
  readonly status: number;
  /** True when the sign-in is too old for this change (RFC 9470). */
  readonly stepUp: boolean;
  readonly maxAge?: number;
  constructor(code: string, status: number, message?: string, maxAge?: number) {
    super(message ? `${code}: ${message}` : code);
    this.name = 'MyAccountError';
    this.code = code;
    this.status = status;
    this.stepUp = code === 'insufficient_user_authentication';
    this.maxAge = maxAge;
  }
}

export interface MyAccountProfile {
  id: string;
  email: string | null;
  emailVerified: boolean;
  name: string | null;
  givenName: string | null;
  familyName: string | null;
  nickname: string | null;
  picture: string | null;
  locale: string | null;
  phone: string | null;
  phoneVerified: boolean;
  userMetadata: Record<string, unknown>;
  createdAt: string;
}

export interface MyAccountMethods {
  password: { set: boolean; updatedAt: string | null };
  passkeys: Array<{ id: string; label: string | null; synced: boolean; host: string; usableHere: boolean; createdAt: string; lastUsedAt: string | null }>;
  passkeysOffered: boolean;
  touchqueApp: { offered: boolean; linked: boolean; since: string | null };
  emailCodes: { offered: boolean; enabled: boolean; available: boolean };
  smsCodes: { offered: boolean; enabled: boolean; phone: string | null };
  identities: Array<{ id: string; connection: string; provider: string; strategy: string; email: string | null; linkedAt: string; lastLoginAt: string | null }>;
}

export interface MyAccountSession {
  id: string;
  device: string | null;
  ip: string | null;
  createdAt: string;
  lastSeenAt: string;
  authTime: string;
  amr: string[];
  current: boolean;
}

export interface MyAccountApp {
  clientId: string;
  name: string;
  logoUrl: string | null;
  firstParty: boolean;
  scopes: string[];
  grantedAt: string | null;
  lastUsedAt: string | null;
  offline: boolean;
}

export interface MyAccountConsents {
  terms: { version: string | null; grantedAt: string; revokedAt: string | null } | null;
  privacy: { version: string | null; grantedAt: string; revokedAt: string | null } | null;
  marketing: { granted: boolean; version?: string | null; grantedAt?: string; revokedAt?: string | null };
}

export interface MyAccountClientOptions {
  /** acme.login.touchque.com, your custom domain, or a full issuer URL. */
  domain: string;
  /** An access token for audience https://<domain>/me/ (HostedLoginClient.getMyAccountToken). */
  getAccessToken: () => Promise<string>;
}

export type ProfileChanges = Partial<Pick<MyAccountProfile, 'name' | 'givenName' | 'familyName' | 'nickname' | 'locale'>> & {
  /** Merged into the stored object; a key set to null is removed. */
  userMetadata?: Record<string, unknown>;
};

export class MyAccountClient {
  readonly issuer: string;
  private readonly getToken: () => Promise<string>;

  constructor(options: MyAccountClientOptions) {
    if (!options?.domain || typeof options.getAccessToken !== 'function') throw new MyAccountError('config', 0, 'domain and getAccessToken are required');
    const issuer = issuerFromDomain(options.domain);
    if (!issuer) throw new MyAccountError('config', 0, 'domain must be an https:// URL or a host name (http:// only for localhost)');
    this.issuer = issuer;
    this.getToken = options.getAccessToken;
  }

  /** The hosted account page, optionally at a section: 'security' | 'devices' | 'privacy'. */
  accountPageUrl(section?: 'security' | 'devices' | 'privacy'): string {
    return `${this.issuer}/account${section ? `/${section}` : ''}`;
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const token = await this.getToken();
    const res = await fetch(`${this.issuer}/me/v1${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...(body !== undefined && { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 204) return undefined as T;
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      const challenge = res.headers.get('WWW-Authenticate') || '';
      const maxAge = /max_age="?(\d+)"?/.exec(challenge)?.[1];
      throw new MyAccountError(String(data.error || `http_${res.status}`), res.status, data.error_description ? String(data.error_description) : undefined, maxAge ? Number(maxAge) : undefined);
    }
    return data as T;
  }

  get() { return this.call<{ profile: MyAccountProfile; authenticationMethods: MyAccountMethods; accountPageUrl: string }>('GET', ''); }
  getProfile() { return this.call<MyAccountProfile>('GET', '/profile'); }
  updateProfile(changes: ProfileChanges) { return this.call<MyAccountProfile>('PATCH', '/profile', changes); }

  authenticationMethods() { return this.call<MyAccountMethods & { addPasskeyUrl: string }>('GET', '/authentication-methods'); }
  renamePasskey(id: string, label: string) { return this.call<void>('PATCH', `/authentication-methods/passkeys/${encodeURIComponent(id)}`, { label }); }
  /** Needs a recent sign-in. */
  removePasskey(id: string) { return this.call<void>('DELETE', `/authentication-methods/passkeys/${encodeURIComponent(id)}`); }
  /** Needs a recent sign-in. */
  unlinkTouchqueApp() { return this.call<void>('DELETE', '/authentication-methods/touchque'); }
  /** Email codes as a second step. Needs a recent sign-in. */
  setEmailCodes(enabled: boolean) { return this.call<{ enabled: boolean }>('PUT', '/authentication-methods/email', { enabled }); }
  /** Texts a code to a new number for text-message codes. Needs a recent sign-in. */
  startSmsEnrollment(phone: string) { return this.call<{ phone: string }>('POST', '/authentication-methods/sms', { phone }); }
  /** The code from that text: text-message codes are on. Needs a recent sign-in. */
  verifySmsEnrollment(code: string) { return this.call<{ phone: string }>('POST', '/authentication-methods/sms/verify', { code }); }
  /** Needs a recent sign-in. */
  removeSmsCodes() { return this.call<void>('DELETE', '/authentication-methods/sms'); }
  /** Disconnects a linked social or enterprise account. Needs a recent sign-in. */
  unlinkIdentity(id: string) { return this.call<void>('DELETE', `/identities/${encodeURIComponent(id)}`); }
  /** Sets or changes the password; other sessions end. Needs a recent sign-in. */
  setPassword(password: string) { return this.call<{ changed: true; sessions: number; refreshTokens: number; warning?: 'breached' }>('PUT', '/password', { password }); }
  /** Needs a recent sign-in and another way to sign in. */
  removePassword() { return this.call<void>('DELETE', '/password'); }
  /** Sends a confirmation link to the new address; it changes when the link is opened. Needs a recent sign-in. */
  changeEmail(email: string) { return this.call<{ sent: true; email: string }>('POST', '/email', { email }); }
  sendVerificationEmail() { return this.call<{ sent: true }>('POST', '/email/verification'); }

  sessions() { return this.call<{ sessions: MyAccountSession[] }>('GET', '/sessions'); }
  endSession(id: string) { return this.call<void>('DELETE', `/sessions/${encodeURIComponent(id)}`); }
  /** Signs out every other device. */
  endOtherSessions() { return this.call<{ sessions: number; refreshTokens: number }>('DELETE', '/sessions'); }

  apps() { return this.call<{ apps: MyAccountApp[] }>('GET', '/apps'); }
  revokeApp(clientId: string) { return this.call<{ consents: number; refreshTokens: number }>('DELETE', `/apps/${encodeURIComponent(clientId)}`); }
  consents() { return this.call<MyAccountConsents>('GET', '/consents'); }
  setMarketing(granted: boolean) { return this.call<{ granted: boolean }>('PUT', '/consents/marketing', { granted }); }

  /** Everything about the person (KVKK/GDPR). Needs a recent sign-in. */
  exportData() { return this.call<Record<string, unknown>>('GET', '/export'); }
  /** Erases the account at once. Needs delete:me and a recent sign-in. */
  deleteAccount() { return this.call<{ deleted: true }>('DELETE', ''); }
}
