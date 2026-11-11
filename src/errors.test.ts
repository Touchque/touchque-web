import { describe, test, expect } from 'vitest';
import {
  TouchqueWebError,
  PasskeyDismissedError,
  PasskeyNotRegisteredError,
  PasskeyDisabledError,
  TouchqueWebAPIError,
} from './errors';

describe('error classes', () => {
  test('all extend TouchqueWebError and carry a distinct name', () => {
    const errs = [
      new PasskeyDismissedError(),
      new PasskeyNotRegisteredError(),
      new PasskeyDisabledError(),
      new TouchqueWebAPIError(500, { error: 'x' }),
    ];
    for (const e of errs) {
      expect(e).toBeInstanceOf(TouchqueWebError);
      expect(e).toBeInstanceOf(Error);
      expect(e.name).toBe(e.constructor.name);
      expect(e.message.length).toBeGreaterThan(0);
    }
  });

  test('TouchqueWebAPIError exposes status and body', () => {
    const e = new TouchqueWebAPIError(429, { error: 'rate_limited' }, 'slow down');
    expect(e.status).toBe(429);
    expect(e.body).toEqual({ error: 'rate_limited' });
    expect(e.message).toBe('slow down');
  });

  test('TouchqueWebAPIError falls back to a generic message', () => {
    expect(new TouchqueWebAPIError(502, null).message).toContain('502');
  });
});

test('TouchqueWebAPIError carries the case code of a refusal (step first, then body)', () => {
  expect(new TouchqueWebAPIError(403, { touchque: { state: 'blocked', reason: 'risk', caseCode: 'K7P-2QX' } }).caseCode).toBe('K7P-2QX');
  expect(new TouchqueWebAPIError(403, { error: 'blocked', caseCode: 'REF-USE' }).caseCode).toBe('REF-USE');
  expect(new TouchqueWebAPIError(500, { error: 'x' }).caseCode).toBeUndefined();
});

describe('feature errors', () => {
  test('webApiError types the three feature refusals and keeps TouchqueWebAPIError for the rest', async () => {
    const { webApiError, TouchqueWebFeatureError } = await import('./errors');
    const e = webApiError(403, { error: 'feature_not_in_plan', feature: 'mobile_sdk' }, 'This feature is not part of your organization’s plan.');
    expect(e).toBeInstanceOf(TouchqueWebFeatureError);
    expect(e).toBeInstanceOf(TouchqueWebAPIError);
    expect(e).toMatchObject({ status: 403, feature: 'mobile_sdk', reason: 'not_in_plan' });
    expect(webApiError(403, { error: 'feature_read_only' })).toMatchObject({ reason: 'read_only' });
    expect(webApiError(403, { error: 'feature_off', feature: 'ciam' })).toMatchObject({ reason: 'off', feature: 'ciam' });
    expect(webApiError(403, { error: 'forbidden' })).not.toBeInstanceOf(TouchqueWebFeatureError);
  });
});
