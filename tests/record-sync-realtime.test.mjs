import test from 'node:test';
import assert from 'node:assert/strict';
import { SupabaseRealtimeManager } from '../src/sync-v2/realtime.ts';

const BINDING = { accountId: 'account-a', projectRef: 'project-a', notebookId: 'notebook-a' };

const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

class FakeWorker {
  constructor() {
    this.cycles = 0;
    this.periodicStarts = [];
    this.periodicStops = 0;
    this.realtimeStates = [];
    this.events = [];
  }

  async runCycle() {
    this.cycles += 1;
    this.events.push('cycle');
    return { pulled: 0, pushed: 0, staleResponses: 0, lastChangeSeq: 0 };
  }

  startPeriodicPull(runImmediately = true) {
    this.periodicStarts.push(runImmediately);
    this.events.push(`poll:${runImmediately}`);
  }

  stopPeriodicPull() {
    this.periodicStops += 1;
    this.events.push('poll:stop');
  }

  async setRealtimeDegraded(message) {
    this.realtimeStates.push(message);
    this.events.push(message === null ? 'realtime:ready' : `realtime:${message}`);
  }
}

class FakeChannel {
  constructor(name, options) {
    this.name = name;
    this.options = options;
    this.bindings = [];
    this.statusCallback = null;
  }

  on(type, filter, callback) {
    this.bindings.push({ type, filter, callback });
    return this;
  }

  subscribe(callback) {
    this.statusCallback = callback;
    return this;
  }

  status(status, error) {
    this.statusCallback?.(status, error);
  }

  event(index = 0, payload = { malicious: 'ignored' }) {
    this.bindings[index].callback(payload);
  }
}

class FakeClient {
  constructor() {
    this.session = { access_token: 'token-a', user: { id: BINDING.accountId } };
    this.sessionError = null;
    this.channels = [];
    this.removed = [];
    this.tokens = [];
    this.authCallback = null;
    this.events = [];
    this.auth = {
      getSession: async () => ({ data: { session: this.session }, error: this.sessionError }),
      onAuthStateChange: callback => {
        this.authCallback = callback;
        return { data: { subscription: { unsubscribe: () => { this.authCallback = null; } } } };
      },
    };
    this.realtime = {
      setAuth: async token => {
        this.tokens.push(token);
        this.events.push(`token:${token}`);
      },
    };
  }

  channel(name, options) {
    const channel = new FakeChannel(name, options);
    this.channels.push(channel);
    this.events.push('channel');
    return channel;
  }

  async removeChannel(channel) {
    this.removed.push(channel);
    this.events.push('remove');
    return 'ok';
  }

  authEvent(event, session = this.session) {
    this.authCallback?.(event, session);
  }
}

class FakeLifecycle {
  constructor() {
    this.visible = true;
    this.online = true;
    this.listeners = new Map();
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type, listener) {
    this.listeners.get(type)?.delete(listener);
  }

  isVisible() {
    return this.visible;
  }

  isOnline() {
    return this.online;
  }

  emit(type) {
    for (const listener of this.listeners.get(type) ?? []) listener();
  }
}

function manager(client, worker, options = {}) {
  return new SupabaseRealtimeManager(BINDING, worker, {
    client,
    lifecycle: null,
    eventDebounceMs: 5,
    connectTimeoutMs: 50,
    reconnectBaseMs: 5,
    reconnectMaxMs: 10,
    ...options,
  });
}

async function subscribe(managerInstance, client, index = 0) {
  const start = managerInstance.start();
  await wait(0);
  client.channels[index].status('SUBSCRIBED');
  await start;
  return client.channels[index];
}

test('subscribes to both record tables before cursor catch-up and uses events only as coalesced wake-ups', async () => {
  const client = new FakeClient();
  const worker = new FakeWorker();
  const instance = manager(client, worker);
  const start = instance.start();
  await wait(0);
  const channel = client.channels[0];

  assert.equal(worker.cycles, 0);
  assert.equal(channel.bindings.length, 6);
  assert.deepEqual(new Set(channel.bindings.map(item => item.filter.event)), new Set(['INSERT', 'UPDATE', 'DELETE']));
  assert.deepEqual(new Set(channel.bindings.map(item => item.filter.table)), new Set(['sync_v2_categories', 'sync_v2_tasks']));
  assert.ok(channel.bindings.every(item => item.filter.filter === 'notebook_id=eq.notebook-a'));
  assert.deepEqual(client.events.slice(0, 2), ['token:undefined', 'channel']);

  channel.status('SUBSCRIBED');
  await start;
  assert.equal(worker.cycles, 1);
  assert.deepEqual(worker.periodicStarts, [false]);
  channel.event(0);
  channel.event(1);
  channel.event(5);
  await wait(15);
  assert.equal(worker.cycles, 2);
  await instance.stop();
});

test('channel failures degrade Realtime, retain polling, remove the channel, and back off to one replacement', async () => {
  const client = new FakeClient();
  const worker = new FakeWorker();
  const instance = manager(client, worker);
  const channel = await subscribe(instance, client);

  channel.status('CHANNEL_ERROR', new Error('private socket detail'));
  await wait(15);

  assert.ok(worker.realtimeStates.some(message => /connection failed/i.test(message)));
  assert.ok(worker.periodicStarts.includes(true));
  assert.deepEqual(client.removed, [channel]);
  assert.equal(client.channels.length, 2);
  assert.equal(client.channels[1].bindings.length, 6);
  assert.ok(!worker.realtimeStates.some(message => message?.includes('private')));
  await instance.stop();
});

test('auth refresh updates the channel JWT and sign-out tears the channel down before later reconnect', async () => {
  const client = new FakeClient();
  const worker = new FakeWorker();
  const instance = manager(client, worker);
  const first = await subscribe(instance, client);

  const refreshed = { access_token: 'token-b', user: { id: BINDING.accountId } };
  client.authEvent('TOKEN_REFRESHED', refreshed);
  await wait(0);
  assert.deepEqual(client.tokens, [undefined, undefined]);

  client.authEvent('SIGNED_OUT', null);
  await wait(0);
  assert.ok(client.removed.includes(first));
  assert.match(worker.realtimeStates.at(-1), /sign in/i);

  client.authEvent('SIGNED_IN', refreshed);
  await wait(0);
  assert.equal(client.channels.length, 2);
  client.channels[1].status('SUBSCRIBED');
  await wait(0);
  assert.equal(worker.cycles, 2);
  await instance.stop();
});

test('visibility and network lifecycle remove stale channels and subscribe before each resume catch-up', async () => {
  const client = new FakeClient();
  const worker = new FakeWorker();
  const lifecycle = new FakeLifecycle();
  const instance = manager(client, worker, { lifecycle });
  const first = await subscribe(instance, client);

  lifecycle.visible = false;
  lifecycle.emit('visibilitychange');
  await wait(0);
  assert.ok(client.removed.includes(first));
  assert.ok(worker.periodicStops >= 1);

  lifecycle.visible = true;
  lifecycle.emit('visibilitychange');
  await wait(0);
  assert.equal(client.channels.length, 2);
  assert.equal(worker.cycles, 1);
  client.channels[1].status('SUBSCRIBED');
  await wait(0);
  assert.equal(worker.cycles, 2);
  first.event();
  await wait(10);
  assert.equal(worker.cycles, 2);

  lifecycle.online = false;
  lifecycle.emit('offline');
  await wait(0);
  assert.ok(client.removed.includes(client.channels[1]));
  lifecycle.online = true;
  lifecycle.emit('online');
  await wait(0);
  assert.equal(client.channels.length, 3);
  await instance.stop();
});

test('manual pause removes the channel and resume subscribes with callback-managed auth', async () => {
  const client = new FakeClient();
  const worker = new FakeWorker();
  const instance = manager(client, worker);
  const first = await subscribe(instance, client);

  await instance.pause();
  assert.ok(client.removed.includes(first));
  assert.equal(worker.periodicStops, 1);

  const resumed = instance.resume();
  await wait(0);
  assert.equal(client.channels.length, 2);
  client.channels[1].status('SUBSCRIBED');
  await resumed;
  assert.deepEqual(client.tokens, [undefined]);
  assert.equal(worker.cycles, 2);
  await instance.stop();
});

test('pausing a pending subscription cancels it so resume cannot inherit a stuck connection', async () => {
  const client = new FakeClient();
  const worker = new FakeWorker();
  const instance = manager(client, worker);
  const starting = instance.start();
  await wait(0);
  const pendingChannel = client.channels[0];

  await instance.pause();
  await starting;
  assert.ok(client.removed.includes(pendingChannel));

  const resumed = instance.resume();
  await wait(0);
  assert.equal(client.channels.length, 2);
  client.channels[1].status('SUBSCRIBED');
  await resumed;
  assert.equal(worker.cycles, 1);
  await instance.stop();
});

test('manual pause is not undone by focus or visibility lifecycle events', async () => {
  const client = new FakeClient();
  const worker = new FakeWorker();
  const lifecycle = new FakeLifecycle();
  const instance = manager(client, worker, { lifecycle });
  await subscribe(instance, client);

  await instance.pause();
  lifecycle.visible = false;
  lifecycle.emit('visibilitychange');
  lifecycle.visible = true;
  lifecycle.emit('visibilitychange');
  lifecycle.emit('focus');
  lifecycle.online = false;
  lifecycle.emit('offline');
  await wait(10);
  assert.equal(client.channels.length, 1);
  assert.equal(worker.realtimeStates.at(-1), null);

  lifecycle.online = true;
  const resumed = instance.resume();
  await wait(0);
  assert.equal(client.channels.length, 2);
  client.channels[1].status('SUBSCRIBED');
  await resumed;
  await instance.stop();
});

test('a silent subscription times out into polling and removes its stale channel', async () => {
  const client = new FakeClient();
  const worker = new FakeWorker();
  const instance = manager(client, worker, {
    connectTimeoutMs: 5,
    reconnectBaseMs: 100,
    reconnectMaxMs: 100,
  });

  await instance.start();
  assert.equal(client.channels.length, 1);
  assert.deepEqual(client.removed, [client.channels[0]]);
  assert.ok(worker.periodicStarts.includes(true));
  assert.match(worker.realtimeStates.at(-1), /periodic sync is continuing/i);
  await instance.stop();
});
