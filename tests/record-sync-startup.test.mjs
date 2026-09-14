import test from 'node:test';
import assert from 'node:assert/strict';
import { RecordTransportError } from '../src/sync-v2/transport.ts';
import { RecordSyncStartupGate, recordSyncStartupRetryDelay } from '../src/sync-v2/startup.ts';

test('duplicate restored-session notifications share one startup inspection', async () => {
  const gate = new RecordSyncStartupGate();
  let calls = 0;
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  const operation = async () => {
    calls += 1;
    await blocked;
  };

  const first = gate.run(operation);
  const second = gate.run(operation);
  assert.equal(first, second);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(calls, 1);
  release();
  await Promise.all([first, second]);

  await gate.run(operation);
  assert.equal(calls, 2);
});

test('startup retries transient auth and network failures with bounded backoff', () => {
  assert.equal(recordSyncStartupRetryDelay(
    new RecordTransportError('auth-required', 'Sign in to use cloud sync.', true), 0,
  ), 1_000);
  assert.equal(recordSyncStartupRetryDelay(
    new RecordTransportError('offline', 'Cloud sync is offline.', true), 3,
  ), 8_000);
  assert.equal(recordSyncStartupRetryDelay(new Error('The cloud sync check timed out.'), 20), 30_000);
  assert.equal(recordSyncStartupRetryDelay(
    new RecordTransportError('permission', 'Cloud sync permission was denied.'), 0,
  ), null);
});
