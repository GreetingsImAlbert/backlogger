import test from 'node:test';
import assert from 'node:assert/strict';
import { AppLifecycleCoordinator } from '../src/platform/lifecycle.ts';

test('mobile lifecycle combines native focus and WebView visibility without duplicate transitions', async () => {
  const events = [];
  const lifecycle = new AppLifecycleCoordinator({
    async onForegroundChanged(foreground) {
      events.push(`foreground:${foreground}`);
    },
    async onOnlineChanged(online) {
      events.push(`online:${online}`);
    },
  });

  await lifecycle.setDocumentVisible(false);
  await lifecycle.setNativeFocused(false);
  await lifecycle.setDocumentVisible(true);
  await lifecycle.setNativeFocused(true);
  await lifecycle.setOnline(false);
  await lifecycle.setOnline(false);
  await lifecycle.setOnline(true);

  assert.deepEqual(events, [
    'foreground:false',
    'foreground:true',
    'online:false',
    'online:true',
  ]);
  assert.deepEqual(lifecycle.snapshot(), { foreground: true, online: true });
});

test('mobile lifecycle serializes rapid background and foreground handlers', async () => {
  const events = [];
  let releaseBackground;
  const background = new Promise(resolve => { releaseBackground = resolve; });
  const lifecycle = new AppLifecycleCoordinator({
    async onForegroundChanged(foreground) {
      events.push(`start:${foreground}`);
      if (!foreground) await background;
      events.push(`end:${foreground}`);
    },
    onOnlineChanged() {},
  });

  const hiding = lifecycle.setNativeFocused(false);
  const showing = lifecycle.setNativeFocused(true);
  await Promise.resolve();
  assert.deepEqual(events, ['start:false']);
  releaseBackground();
  await Promise.all([hiding, showing]);

  assert.deepEqual(events, ['start:false', 'end:false', 'start:true', 'end:true']);
});
