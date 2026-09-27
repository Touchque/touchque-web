import { describe, test, expect } from 'vitest';
import {
  TouchQueWebError,
  PasskeyDismissedError,
  PasskeyNotRegisteredError,
  PasskeyDisabledError,
  TouchQueWebAPIError,
} from './errors';

describe('error classes', () => {
  test('all extend TouchQueWebError and carry a distinct name', () => {
    const errs = [
      new PasskeyDismissedError(),
      new PasskeyNotRegisteredError(),
      new PasskeyDisabledError(),
      new TouchQueWebAPIError(500, { error: 'x' }),
    ];
    for (const e of errs) {
      expect(e).toBeInstanceOf(TouchQueWebError);
      expect(e).toBeInstanceOf(Error);
      expect(e.name).toBe(e.constructor.name);
      expect(e.message.length).toBeGreaterThan(0);
    }
  });

  test('TouchQueWebAPIError exposes status and body', () => {
    const e = new TouchQueWebAPIError(429, { error: 'rate_limited' }, 'slow down');
    expect(e.status).toBe(429);
    expect(e.body).toEqual({ error: 'rate_limited' });
    expect(e.message).toBe('slow down');
  });

  test('TouchQueWebAPIError falls back to a generic message', () => {
    expect(new TouchQueWebAPIError(502, null).message).toContain('502');
  });
});
