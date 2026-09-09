import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AuthCallbackValidationError,
  parseAuthCallbackUrl,
  sanitizeAuthError,
} from '../src/supabase/auth.ts';
import { parseSupabaseConfig } from '../src/supabase/config.ts';

test('missing Supabase configuration keeps local mode available', () => {
  assert.deepEqual(parseSupabaseConfig({}), {
    configured: false,
    reason: 'missing',
    message: 'Sync is not configured.',
  });
});

test('valid Supabase configuration exposes only the project ref and client-safe key', () => {
  const result = parseSupabaseConfig({
    VITE_SUPABASE_URL: 'https://abc-123.supabase.co/',
    VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test-key',
  });
  assert.deepEqual(result, {
    configured: true,
    config: {
      url: 'https://abc-123.supabase.co',
      projectRef: 'abc-123',
      publishableKey: 'sb_publishable_test-key',
    },
  });
});

test('invalid or secret Supabase configuration is rejected without exposing its values', () => {
  assert.equal(parseSupabaseConfig({
    VITE_SUPABASE_URL: 'http://abc-123.supabase.co',
    VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test-key',
  }).configured, false);
  assert.equal(parseSupabaseConfig({
    VITE_SUPABASE_URL: 'https://abc-123.supabase.co',
    VITE_SUPABASE_PUBLISHABLE_KEY: 'service_role_secret_value',
  }).configured, false);
  const invalid = parseSupabaseConfig({ VITE_SUPABASE_URL: 'https://abc-123.supabase.co' });
  assert.equal(invalid.configured, false);
  if (!invalid.configured) assert.doesNotMatch(invalid.message, /abc-123|secret/i);
});

test('exact callback URLs accept one PKCE code and optional flow id', () => {
  assert.deepEqual(parseAuthCallbackUrl('backlogger://auth/callback?code=one-time-code&sb_flow_id=flow-1'), {
    kind: 'code',
    code: 'one-time-code',
    flowId: 'flow-1',
  });
});

test('callback validation rejects wrong routes, missing codes, and duplicate parameters', () => {
  for (const url of [
    'https://auth/callback?code=code',
    'backlogger://wrong/callback?code=code',
    'backlogger://auth/other?code=code',
    'backlogger://auth/callback',
    'backlogger://auth/callback?code=one&code=two',
    'backlogger://auth/callback?code=one&error=access_denied',
  ]) {
    assert.throws(() => parseAuthCallbackUrl(url), AuthCallbackValidationError);
  }
});

test('OAuth cancellation is mapped to a sanitized callback error', () => {
  assert.deepEqual(parseAuthCallbackUrl('backlogger://auth/callback?error=access_denied&error_description=private-value'), {
    kind: 'error',
    message: 'Google sign-in was cancelled.',
  });
  assert.equal(sanitizeAuthError(new Error('exchange failed for access_token=secret-value')), 'Google sign-in could not be completed. Please try again.');
  assert.equal(sanitizeAuthError(new Error('network timeout')), 'Could not reach Supabase. Check your connection and try again.');
});
