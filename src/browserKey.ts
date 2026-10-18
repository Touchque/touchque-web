// Device-bound browser key for silent sign-ins.
//
// One ECDSA P-256 key pair per origin, made with WebCrypto as non-extractable
// and kept in IndexedDB (database "touchque", store "keys", key
// "browser-key-v1"). Script on the page can sign with it but never read the
// private key out, so a proof cannot be copied to another browser. Every proof
// is fresh: it signs `touchque-browser:v1\n{aud}\n{iat}\n{nonce}` with a new
// random nonce, and the server accepts each nonce once.
//
// Your server passes the proof (`X-TouchQue-Browser`) to TouchQue untouched:
// with the push (`login.request`), so the user's approval makes this browser
// known, and to `risk.check` (the server SDKs' `silentSignIn` option), so a
// later sign-in from the same browser skips the phone when nothing about it is
// new.
//
//   import { browserKey } from '@touchque/web';
//   const proof = await browserKey.proof(); // base64url JSON, or null

/** The header a proof travels in from the browser to your server. */
export const BROWSER_PROOF_HEADER = 'X-TouchQue-Browser';

const DB_NAME = 'touchque';
const STORE_NAME = 'keys';
const KEY_NAME = 'browser-key-v1';

/** The public half of the browser key: exactly these four members (no `d`, `ext` or `key_ops`). */
export interface BrowserKeyJwk {
  kty: 'EC';
  crv: 'P-256';
  x: string;
  y: string;
}

/** What `X-TouchQue-Browser` carries, as base64url(JSON.stringify(proof)). */
export interface BrowserProof {
  v: 1;
  jwk: BrowserKeyJwk;
  /** The page's origin (`location.origin`). */
  aud: string;
  /** Unix seconds. */
  iat: number;
  /** base64url of 16 random bytes (22 characters). */
  nonce: string;
  /** base64url of the 64-byte IEEE P1363 r||s ECDSA signature over `browserProofMessage(aud, iat, nonce)`. */
  sig: string;
}

/**
 * Where the key pair is kept. The default is IndexedDB; pass your own to
 * `createBrowserKey` only for tests or an unusual runtime.
 */
export interface BrowserKeyStore {
  /** The stored key pair, or undefined when there is none. */
  load(): Promise<CryptoKeyPair | undefined>;
  /**
   * Stores `pair` unless a pair is already there (another tab may have made
   * one first). Resolves with the pair that is stored.
   */
  save(pair: CryptoKeyPair): Promise<CryptoKeyPair>;
  remove(): Promise<void>;
}

export interface BrowserKeyOptions {
  /** Default: IndexedDB. `null` means no storage, so `proof()` resolves `null`. */
  store?: BrowserKeyStore | null;
  /** Default: `globalThis.crypto` (needs `subtle`, so an https page or localhost). */
  crypto?: Crypto;
  /** The proof's audience. Default: `location.origin`. */
  origin?: string;
  /** Clock in milliseconds. Default: `Date.now`. */
  now?: () => number;
  /**
   * How long `proof()` and `thumbprint()` may take before they give up and
   * resolve `null`, so a stuck IndexedDB never holds up a sign-in. Default 2000 ms.
   */
  timeoutMs?: number;
}

export interface BrowserKey {
  /**
   * A fresh proof of this browser's key, base64url JSON for the
   * `X-TouchQue-Browser` header. Makes the key on first use. Resolves `null`
   * (never throws) when WebCrypto or IndexedDB is unavailable or too slow.
   */
  proof(): Promise<string | null>;
  /**
   * RFC 7638 thumbprint of this browser's key, as the server SDKs'
   * `risk.browsers` lists it (to mark "this browser"), or `null` when this
   * browser has no key yet. Never makes a key and never throws.
   */
  thumbprint(): Promise<string | null>;
  /**
   * Deletes this browser's key: the next proof uses a new key, so TouchQue
   * treats it as a new browser. Use it on shared computers or when the user
   * signs out everywhere (and forget it on the server too). Never throws.
   */
  forget(): Promise<void>;
}

/** The exact UTF-8 message the browser key signs. */
export function browserProofMessage(aud: string, iat: number, nonce: string): string {
  return `touchque-browser:v1\n${aud}\n${iat}\n${nonce}`;
}

/** RFC 7638 thumbprint input for an EC key: the required members in lexicographic order, no whitespace. */
export function browserKeyThumbprintInput(jwk: { crv: string; kty: string; x: string; y: string }): string {
  return JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y });
}

/** RFC 7638 thumbprint: base64url(SHA-256(browserKeyThumbprintInput(jwk))). */
export async function browserKeyThumbprint(
  jwk: { crv: string; kty: string; x: string; y: string },
  subtle: SubtleCrypto = globalThis.crypto.subtle,
): Promise<string> {
  const digest = await subtle.digest('SHA-256', utf8(browserKeyThumbprintInput(jwk)));
  return base64url(new Uint8Array(digest));
}

function utf8(s: string) {
  return new TextEncoder().encode(s);
}

function base64url(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 1) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function isKeyPair(v: unknown): v is CryptoKeyPair {
  const p = v as Partial<CryptoKeyPair> | null | undefined;
  return !!p && typeof p === 'object'
    && !!p.privateKey && p.privateKey.type === 'private'
    && !!p.publicKey && p.publicKey.type === 'public';
}

function indexedDbStore(idb: IDBFactory): BrowserKeyStore {
  const open = () => new Promise<IDBDatabase>((resolve, reject) => {
    const req = idb.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE_NAME)) req.result.createObjectStore(STORE_NAME);
    };
    let failed = false;
    req.onsuccess = () => { if (failed) req.result.close(); else resolve(req.result); };
    req.onerror = () => { failed = true; reject(req.error); };
    req.onblocked = () => { failed = true; reject(new Error('IndexedDB open blocked')); };
  });
  // One transaction; resolves with what `fn` reports once the transaction has committed.
  async function run<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore, report: (value: T) => void) => void): Promise<T> {
    const db = await open();
    try {
      return await new Promise<T>((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, mode);
        let value: T;
        fn(tx.objectStore(STORE_NAME), (v) => { value = v; });
        tx.oncomplete = () => resolve(value);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
      });
    } finally {
      db.close();
    }
  }
  return {
    load: () => run<CryptoKeyPair | undefined>('readonly', (store, report) => {
      const req = store.get(KEY_NAME);
      req.onsuccess = () => report(isKeyPair(req.result) ? req.result : undefined);
    }),
    // Read and write in one readwrite transaction: they are serialized across
    // tabs, so two tabs making a key at once end up with the same one.
    save: (pair) => run<CryptoKeyPair>('readwrite', (store, report) => {
      const req = store.get(KEY_NAME);
      req.onsuccess = () => {
        if (isKeyPair(req.result)) return report(req.result);
        store.put({ privateKey: pair.privateKey, publicKey: pair.publicKey }, KEY_NAME);
        report(pair);
      };
    }),
    remove: () => run<void>('readwrite', (store, report) => {
      store.delete(KEY_NAME);
      report(undefined);
    }),
  };
}

/** Resolves `null` when `work` takes longer than `ms` (or fails). */
function within<T>(work: () => Promise<T | null>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    work().then(
      (value) => { clearTimeout(timer); resolve(value); },
      () => { clearTimeout(timer); resolve(null); },
    );
  });
}

function defaultStore(): BrowserKeyStore | null {
  try {
    // Reading `indexedDB` itself throws in some sandboxed frames.
    return typeof indexedDB !== 'undefined' && indexedDB ? indexedDbStore(indexedDB) : null;
  } catch {
    return null;
  }
}

/**
 * A browser key with its own storage, crypto or audience. Most pages use the
 * shared `browserKey` instead.
 */
export function createBrowserKey(options: BrowserKeyOptions = {}): BrowserKey {
  let storeMemo: BrowserKeyStore | null | undefined;
  const store = () => {
    if (storeMemo === undefined) storeMemo = options.store !== undefined ? options.store : defaultStore();
    return storeMemo;
  };
  const cryptoImpl = (): Crypto | null => {
    try {
      const c = options.crypto ?? globalThis.crypto;
      return c && c.subtle && typeof c.getRandomValues === 'function' ? c : null;
    } catch {
      return null;
    }
  };
  const audience = (): string | null => {
    let aud = options.origin;
    if (aud === undefined) {
      try { aud = typeof location !== 'undefined' ? location.origin : undefined; } catch { aud = undefined; }
    }
    // An opaque origin (sandboxed frame, file://) serializes as "null".
    return typeof aud === 'string' && aud !== '' && aud !== 'null' ? aud : null;
  };

  // The key pair and its public JWK, loaded (or made) once per page.
  let current: Promise<{ pair: CryptoKeyPair; jwk: BrowserKeyJwk }> | undefined;
  const keys = (c: Crypto, s: BrowserKeyStore) => {
    if (!current) {
      const loading = (async () => {
        let pair = await s.load();
        if (!isKeyPair(pair)) {
          const made = await c.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']) as CryptoKeyPair;
          pair = await s.save(made);
          if (!isKeyPair(pair)) throw new Error('browser key not stored');
        }
        const pub = await c.subtle.exportKey('jwk', pair.publicKey);
        if (pub.kty !== 'EC' || pub.crv !== 'P-256' || typeof pub.x !== 'string' || typeof pub.y !== 'string') {
          throw new Error('browser key is not P-256');
        }
        return { pair, jwk: { kty: 'EC' as const, crv: 'P-256' as const, x: pub.x, y: pub.y } };
      })();
      current = loading;
      // A failure is not cached: the next call tries again.
      loading.catch(() => { if (current === loading) current = undefined; });
    }
    return current;
  };

  const timeoutMs = options.timeoutMs ?? 2000;

  return {
    proof: () => within(async () => {
      const c = cryptoImpl();
      const s = store();
      const aud = audience();
      if (!c || !s || !aud) return null;
      const { pair, jwk } = await keys(c, s);
      const iat = Math.floor((options.now ?? Date.now)() / 1000);
      const nonce = base64url(c.getRandomValues(new Uint8Array(16)));
      const sig = new Uint8Array(await c.subtle.sign(
        { name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, utf8(browserProofMessage(aud, iat, nonce)),
      ));
      if (sig.length !== 64) return null; // WebCrypto gives r||s; anything else would never verify
      const proof: BrowserProof = { v: 1, jwk, aud, iat, nonce, sig: base64url(sig) };
      return base64url(utf8(JSON.stringify(proof)));
    }, timeoutMs),

    thumbprint: () => within(async () => {
      const c = cryptoImpl();
      const s = store();
      if (!c || !s) return null;
      if (!current) {
        const stored = await s.load();
        if (!isKeyPair(stored)) return null;
      }
      const { jwk } = await keys(c, s);
      return browserKeyThumbprint(jwk, c.subtle);
    }, timeoutMs),

    async forget() {
      current = undefined;
      // Nothing stored, no storage, or a stuck one: nothing more to do.
      await within(async () => { await store()?.remove(); return null; }, timeoutMs);
    },
  };
}

/** This page's browser key (IndexedDB, WebCrypto, `location.origin`). */
export const browserKey: BrowserKey = createBrowserKey();
