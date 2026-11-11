import type { TouchqueWebConfig } from './types';
import { touchqueFetch, TouchqueFetchOptions } from './action';
import {
  PasskeyDisabledError,
  PasskeyNotRegisteredError,
  webApiError,
} from './errors';

/**
 * Thin fetch wrapper for the partner relay backend. Joins `baseUrl` + path,
 * sends/parses JSON, and normalizes the relay's error responses into the
 * SDK's error classes.
 */
export class RelayHttp {
  private readonly baseUrl: string;
  private readonly credentials: RequestCredentials;
  private readonly headers: Record<string, string>;
  private readonly fetchImpl: typeof fetch;

  constructor(config: TouchqueWebConfig) {
    if (!config.baseUrl) {
      throw new Error('createTouchqueWeb: `baseUrl` is required.');
    }
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.credentials = config.credentials ?? 'same-origin';
    this.headers = config.headers ?? {};
    const f = config.fetch ?? (typeof fetch !== 'undefined' ? fetch : undefined);
    if (!f) {
      throw new Error('createTouchqueWeb: no `fetch` available — pass `fetch` in the config.');
    }
    // Bind so a passed-in global fetch keeps its `this`.
    this.fetchImpl = f.bind(globalThis);
  }

  /** Step-up request to a relay route (two-phase Touchque contract); resolves with the final Response. */
  stepUp(path: string, body: unknown, options: TouchqueFetchOptions = {}): Promise<Response> {
    return touchqueFetch(this.baseUrl + path, {
      method: 'POST',
      credentials: this.credentials,
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', ...this.headers },
      body: JSON.stringify(body ?? {}),
    }, { fetch: this.fetchImpl, ...options });
  }

  post<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('POST', path, body);
  }

  get<T>(path: string): Promise<T> {
    return this.request<T>('GET', path);
  }

  del<T>(path: string): Promise<T> {
    return this.request<T>('DELETE', path);
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(this.baseUrl + path, {
      method,
      credentials: this.credentials,
      headers: {
        Accept: 'application/json',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...this.headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    const text = await res.text();
    let parsed: unknown = undefined;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }

    if (!res.ok) {
      const errCode =
        parsed && typeof parsed === 'object' && 'error' in parsed
          ? String((parsed as Record<string, unknown>).error)
          : undefined;

      // Map to a specific fallback error only on an exact error-code match,
      // or on the bare status ONLY when the relay sent no body at all.
      // (A generic 403 or 404 from a WAF / rate-limiter / CSRF check / router,
      // HTML or JSON, must not be mistaken for "passwordless disabled" and
      // trigger a password fallback.)
      const bare = !text;
      if (errCode === 'no_passkey_registered' || (res.status === 404 && bare)) {
        throw new PasskeyNotRegisteredError();
      }
      if (errCode === 'passwordless_login_disabled' || (res.status === 403 && bare)) {
        throw new PasskeyDisabledError();
      }
      const message =
        parsed && typeof parsed === 'object' && 'message' in parsed
          ? String((parsed as Record<string, unknown>).message)
          : errCode;
      throw webApiError(res.status, parsed, message);
    }

    return parsed as T;
  }
}
