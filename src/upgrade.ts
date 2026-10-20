// Password → passkey: when to offer "Add a passkey" after a password or
// email-link sign-in, remembered per browser.
//
//   if (await shouldOfferPasskey({ user: email })) showOffer();
//   // "Add a passkey": await tq.passkeys.upgrade({ user: email })
//   // "Not now":        dismissPasskeyOffer(email)
//
// Nothing here talks to a server. The marks live in this browser's
// localStorage under `touchque:passkey:*`, keyed by a hash of the user id
// (not the id itself), and a browser without localStorage simply offers again.

import { browserSupportsWebAuthn, platformAuthenticatorIsAvailable } from '@simplewebauthn/browser';

const HAS_PREFIX = 'touchque:passkey:has:';
const DISMISSED_PREFIX = 'touchque:passkey:dismissed:';
const DAY_MS = 24 * 60 * 60 * 1000;

export interface PasskeyOfferOptions {
  /** Your user's id (the same one you sign in with, e.g. the email). */
  user: string;
  /**
   * Offer again this many days after "Not now". Default: never again in this
   * browser for this user.
   */
  remindAfterDays?: number;
  /** Storage for the marks (default `localStorage`). */
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
  /**
   * Offer only when a built-in authenticator (Touch ID, Face ID, Windows
   * Hello, Android screen lock) is available. Default true: a security-key-only
   * browser is not asked after every sign-in.
   */
  requirePlatformAuthenticator?: boolean;
}

/** A short, stable, non-reversible key for `user` (not a security boundary: it keeps the address out of storage). */
function userKey(user: string): string {
  const s = String(user ?? '').trim().toLowerCase();
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(16).padStart(8, '0') + (h1 >>> 0).toString(16).padStart(8, '0');
}

function store(custom?: PasskeyOfferOptions['storage']): PasskeyOfferOptions['storage'] | null {
  if (custom) return custom;
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null; // blocked site data
  }
}

function read(s: PasskeyOfferOptions['storage'] | null, key: string): string | null {
  try {
    return s ? s.getItem(key) : null;
  } catch {
    return null;
  }
}

function write(s: PasskeyOfferOptions['storage'] | null, key: string, value: string | null): void {
  try {
    if (!s) return;
    if (value === null) s.removeItem(key);
    else s.setItem(key, value);
  } catch {
    // Full or blocked storage: the offer may show again, nothing breaks.
  }
}

/**
 * Whether to offer "Add a passkey" to `user` in this browser now: WebAuthn
 * works here (with a built-in authenticator, unless
 * `requirePlatformAuthenticator: false`), the user has not said "Not now" here,
 * and this browser has not registered or used a passkey of theirs. Never throws.
 */
export async function shouldOfferPasskey(options: PasskeyOfferOptions): Promise<boolean> {
  if (!options?.user) return false;
  try {
    if (!browserSupportsWebAuthn()) return false;
    if (options.requirePlatformAuthenticator !== false && !(await platformAuthenticatorIsAvailable())) return false;
  } catch {
    return false;
  }
  const s = store(options.storage);
  const key = userKey(options.user);
  if (read(s, HAS_PREFIX + key)) return false;
  const dismissed = Number(read(s, DISMISSED_PREFIX + key));
  if (dismissed) {
    if (options.remindAfterDays === undefined) return false;
    if (Date.now() - dismissed < options.remindAfterDays * DAY_MS) return false;
  }
  return true;
}

/** "Not now": don't offer `user` a passkey in this browser again (or until `remindAfterDays`). */
export function dismissPasskeyOffer(user: string, storage?: PasskeyOfferOptions['storage']): void {
  if (!user) return;
  write(store(storage), DISMISSED_PREFIX + userKey(user), String(Date.now()));
}

/**
 * Marks that this browser has a passkey of `user` (after registering one or
 * signing in with one), so no offer is shown here. `passkeys.upgrade()` and a
 * successful `passkeys.authenticate()` call it for you.
 */
export function rememberPasskey(user: string, storage?: PasskeyOfferOptions['storage']): void {
  if (!user) return;
  write(store(storage), HAS_PREFIX + userKey(user), '1');
}

/** Clears this browser's marks for `user` (e.g. after they removed the passkey made here, or on a shared computer). */
export function forgetPasskeyOffer(user: string, storage?: PasskeyOfferOptions['storage']): void {
  if (!user) return;
  const s = store(storage);
  const key = userKey(user);
  write(s, HAS_PREFIX + key, null);
  write(s, DISMISSED_PREFIX + key, null);
}
