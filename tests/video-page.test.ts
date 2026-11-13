import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import React from 'react';
import ts from 'typescript';
import * as feed from '../src/lib/feed.ts';
import * as playback from '../src/lib/playback.ts';

const require = createRequire(import.meta.url);
const { create, act } = require('react-test-renderer');
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Run the real page with a controllable native player and Android lifecycle events.
function harness(initialStatus = 'readyToPlay') {
  const lifecycle = new Map<string, Set<(value?: string) => void>>();
  const events = new Map<string, Set<(value: any) => void>>();
  const appState = {
    currentState: 'active',
    addEventListener(event: string, listener: (value?: string) => void) {
      if (!lifecycle.has(event)) lifecycle.set(event, new Set());
      lifecycle.get(event)!.add(listener);
      return { remove: () => lifecycle.get(event)!.delete(listener) };
    },
  };
  const player = {
    status: initialStatus, duration: 60, currentTime: 0, volume: 1,
    muted: false, playing: false, plays: 0,
    play() { this.playing = true; this.plays++; },
    pause() { this.playing = false; },
    async replaceAsync() {},
  };
  function useListener(event: string, handler: (value: any) => void) {
    const latest = React.useRef(handler);
    latest.current = handler;
    React.useEffect(() => {
      const listener = (value: any) => latest.current(value);
      if (!events.has(event)) events.set(event, new Set());
      events.get(event)!.add(listener);
      return () => { events.get(event)!.delete(listener); };
    }, [event]);
  }
  const source = readFileSync(new URL('../src/components/video-page.tsx', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX,
    esModuleInterop: true, target: ts.ScriptTarget.ES2022,
  } }).outputText;
  const module = { exports: {} as any };
  new Function('require', 'module', 'exports', compiled)((name: string) => {
    if (name === 'react-native') return {
      View: 'View', Text: 'Text', Pressable: 'Pressable', ActivityIndicator: 'ActivityIndicator',
      StyleSheet: { create: (styles: unknown) => styles, absoluteFill: {} }, AppState: appState,
    };
    if (name === 'expo') return {
      useEvent(_player: unknown, event: string, initial: unknown) {
        const [value, setValue] = React.useState(initial);
        useListener(event, setValue);
        return value;
      },
      useEventListener(_player: unknown, event: string, handler: (value: any) => void) {
        useListener(event, handler);
      },
    };
    if (name === 'expo-video') return {
      VideoView: 'VideoView',
      useVideoPlayer(_id: string, setup: (instance: any) => void) {
        return React.useState(() => { setup(player); return player; })[0];
      },
    };
    if (name === '@react-native-community/slider') return { __esModule: true, default: 'Slider' };
    if (name === '@/components/feed-icon') return { FeedIcon: 'FeedIcon' };
    if (name === '@/components/video-actions') return { VideoActions: 'VideoActions' };
    if (name === '@/lib/feed') return feed;
    if (name === '@/lib/playback') return playback;
    return require(name);
  }, module, module.exports);
  return {
    Component: module.exports.VideoPage, player,
    emit(event: string, value?: string) {
      if (event === 'change' && value) appState.currentState = value;
      lifecycle.get(event)?.forEach((listener) => listener(value));
    },
    status(status: string) {
      player.status = status;
      events.get('statusChange')?.forEach((listener) => listener({ status }));
    },
  };
}

function props(muted = false) {
  return {
    video: { id: 'local-video-1', filename: 'first.mp4', createdAt: 1 },
    height: 800, selected: true, canPlay: true, playbackRevision: 0,
    muted, repeat: true, autoAdvance: false, bookmarked: false,
    sharing: false, hasNext: true, onBookmark() {}, onMute() {}, onRepeat() {},
    onAutoAdvance() {}, onShare() {}, onFinished() {}, onScrubbing() {}, onNavigate() {},
  };
}

test('the first visible video restores sound after returning from the background', async () => {
  const h = harness();
  const page = props();
  let renderer: any;
  await act(() => { renderer = create(React.createElement(h.Component, page)); });
  await act(() => { h.emit('change', 'background'); h.emit('blur'); });
  assert.equal(h.player.playing, false);
  await act(() => { renderer.update(React.createElement(h.Component, { ...page, canPlay: false })); });
  h.player.volume = 0; // Simulate native audio state lost during the interruption.
  await act(() => { h.emit('change', 'active'); h.emit('focus'); });
  await act(() => { renderer.update(React.createElement(h.Component, { ...page, playbackRevision: 1 })); });
  assert.equal(h.player.playing, true);
  assert.equal(h.player.muted, false);
  assert.equal(h.player.volume, 1);
  await act(() => { renderer.unmount(); });
});

test('a late Android focus event resumes the same page without waiting for a swipe', async () => {
  const h = harness();
  const page = props();
  let renderer: any;
  await act(() => { renderer = create(React.createElement(h.Component, page)); });
  await act(() => { h.emit('blur'); });
  await act(() => { renderer.update(React.createElement(h.Component, { ...page, playbackRevision: 1 })); });
  assert.equal(h.player.playing, false);
  h.player.volume = 0;
  await act(() => { h.emit('focus'); });
  assert.equal(h.player.playing, true);
  assert.equal(h.player.muted, false);
  assert.equal(h.player.volume, 1);
  await act(() => { renderer.unmount(); });
});

test('readiness restores audio after native loading without changing the selected video', async () => {
  const h = harness('loading');
  let renderer: any;
  await act(() => { renderer = create(React.createElement(h.Component, props())); });
  h.player.volume = 0;
  await act(() => { h.status('readyToPlay'); });
  assert.equal(h.player.volume, 1);
  assert.equal(h.player.muted, false);
  assert.equal(h.player.playing, true);
  await act(() => { renderer.unmount(); });
});

test('returning to the app respects the user mute setting and a manual pause', async () => {
  const h = harness();
  let renderer: any;
  await act(() => { renderer = create(React.createElement(h.Component, props(true))); });
  await act(() => { h.emit('change', 'background'); h.emit('change', 'active'); h.emit('focus'); });
  assert.equal(h.player.muted, true);
  const touch = renderer.root.findAllByType('Pressable').find((node: any) => node.props.accessibilityLabel === 'Поставить видео на паузу');
  await act(() => { touch.props.onPress(); });
  await act(() => { h.emit('blur'); h.emit('change', 'background'); h.emit('change', 'active'); h.emit('focus'); });
  assert.equal(h.player.playing, false);
  assert.equal(h.player.muted, true);
  await act(() => { renderer.unmount(); });
});
