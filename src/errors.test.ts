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

test('TouchQueWebAPIError carries the case code of a refusal (step first, then body)', () => {
  expect(new TouchQueWebAPIError(403, { touchque: { state: 'blocked', reason: 'risk', caseCode: 'K7P-2QX' } }).caseCode).toBe('K7P-2QX');
  expect(new TouchQueWebAPIError(403, { error: 'blocked', caseCode: 'REF-USE' }).caseCode).toBe('REF-USE');
  expect(new TouchQueWebAPIError(500, { error: 'x' }).caseCode).toBeUndefined();
});
