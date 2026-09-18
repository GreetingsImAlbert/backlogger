import test from 'node:test';
import assert from 'node:assert/strict';
import {
  pauseRecordSyncExecution,
  resumeRecordSyncExecution,
  startRecordSyncExecution,
  stopRecordSyncExecution,
} from '../src/sync-v2/runtime.ts';

function makeWorker(events, { fail = false } = {}) {
  return {
    async runCycle() {
      events.push('cycle');
      if (fail) throw new Error('offline');
      return {};
    },
    startPeriodicPull(runImmediately) {
      events.push(`poll:${String(runImmediately)}`);
    },
    stopPeriodicPull() {
      events.push('stop-poll');
    },
  };
}

function makeRealtime(events) {
  return {
    async start() { events.push('realtime:start'); },
    async pause() { events.push('realtime:pause'); },
    async resume() { events.push('realtime:resume'); },
    async stop() { events.push('realtime:stop'); },
  };
}

test('polling-only runtime catches up immediately and controls its periodic worker', async () => {
  const events = [];
  const worker = makeWorker(events);

  await startRecordSyncExecution(worker, null);
  await pauseRecordSyncExecution(worker, null);
  await resumeRecordSyncExecution(worker, null);
  await stopRecordSyncExecution(worker, null);

  assert.deepEqual(events, [
    'poll:false', 'cycle',
    'stop-poll',
    'poll:false', 'cycle',
    'stop-poll',
  ]);
});

test('polling-only startup remains retryable when the immediate cycle is offline', async () => {
  const events = [];
  await startRecordSyncExecution(makeWorker(events, { fail: true }), null);
  assert.deepEqual(events, ['poll:false', 'cycle']);
});

test('Realtime runtime delegates lifecycle without starting polling directly', async () => {
  const events = [];
  const worker = makeWorker(events);
  const realtime = makeRealtime(events);

  await startRecordSyncExecution(worker, realtime);
  await pauseRecordSyncExecution(worker, realtime);
  await resumeRecordSyncExecution(worker, realtime);
  await stopRecordSyncExecution(worker, realtime);

  assert.deepEqual(events, [
    'realtime:start',
    'realtime:pause',
    'realtime:resume',
    'stop-poll', 'realtime:stop',
  ]);
});
