import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { startBackdrop } from '../assets/js/backdrop.js';
import { createMatchMedia, createPage, waitFor } from './helpers/dom.js';

const REDUCED = '(prefers-reduced-motion: reduce)';

/** A 2D context that records every drawing call and property write. */
function fakeContext() {
  const state = { calls: [], fillStyle: '', strokeStyle: '', lineWidth: 1 };
  return new Proxy(state, {
    get: (target, property) => (property in target ? target[property] : (...args) => void target.calls.push([property, ...args])),
    set: (target, property, value) => ((target[property] = value), true),
  });
}

/** jsdom serialises custom properties without spaces ("1,2,3"); browsers keep them. Both are valid colours. */
const compact = (value) => value.replace(/\s+/g, '');

/** Deterministic pseudo-random numbers so node positions are reproducible. */
function seeded(seed = 7) {
  let value = seed;
  return () => ((value = (value * 16807) % 2147483647) - 1) / 2147483646;
}

function setup({ reducedMotion = false, width = 1024, height = 768, pixelRatio = 1, rgb } = {}) {
  const { window } = createPage();
  const { document } = window;
  const media = createMatchMedia({ [REDUCED]: reducedMotion });
  const context = fakeContext();
  const frames = new Map();
  let frameId = 0;

  window.matchMedia = media.matchMedia;
  window.innerWidth = width;
  window.innerHeight = height;
  window.devicePixelRatio = pixelRatio;
  window.requestAnimationFrame = (callback) => {
    frameId += 1;
    frames.set(frameId, callback);
    return frameId;
  };
  window.cancelAnimationFrame = (id) => void frames.delete(id);

  const style = document.createElement('style');
  if (rgb) style.textContent = `:root { --backdrop-rgb: ${rgb}; }`;
  document.head.append(style);

  const canvas = document.getElementById('backdrop');
  canvas.getContext = () => context;

  const arcs = () => context.calls.filter(([name]) => name === 'arc');
  return {
    window,
    document,
    media,
    canvas,
    context,
    frames,
    style,
    arcs,
    /** Runs the pending animation frame, as the browser would. */
    runFrame() {
      const [[id, callback]] = [...frames];
      frames.delete(id);
      callback(0);
    },
    hide(hidden) {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
      document.dispatchEvent(new window.Event('visibilitychange'));
    },
    start: () => startBackdrop(canvas, { random: seeded() }),
  };
}

describe('startBackdrop', () => {
  test('does nothing when the canvas has no 2D context', () => {
    const page = setup();
    page.canvas.getContext = () => null;
    const handle = page.start();
    assert.equal(page.frames.size, 0);
    assert.equal(page.media.listenerCount(REDUCED), 0);
    assert.doesNotThrow(() => handle.stop());
  });

  test('paints straight away and keeps exactly one animation frame queued', () => {
    const page = setup();
    page.start();
    assert.ok(page.context.calls.some(([name]) => name === 'clearRect'));
    assert.ok(page.arcs().length > 0);
    assert.equal(page.frames.size, 1);

    const firstDot = page.arcs()[0].slice(1, 3);
    page.context.calls.length = 0;
    page.runFrame();
    assert.notDeepEqual(page.arcs()[0].slice(1, 3), firstDot, 'the dots should have moved');
    assert.equal(page.frames.size, 1);
  });

  test('sizes the canvas to the viewport and caps the device pixel ratio at 2', () => {
    const page = setup({ width: 800, height: 600, pixelRatio: 3 });
    page.start();
    assert.equal(page.canvas.width, 1600);
    assert.equal(page.canvas.height, 1200);
    assert.deepEqual(page.context.calls.find(([name]) => name === 'setTransform').slice(1), [2, 0, 0, 2, 0, 0]);
  });

  test('scales the number of dots with the viewport, within sensible bounds', () => {
    const small = setup({ width: 320, height: 480 });
    small.start();
    assert.equal(small.arcs().length, 14);

    const huge = setup({ width: 3840, height: 2160 });
    huge.start();
    assert.equal(huge.arcs().length, 70);
  });

  test('draws connecting lines only between nearby dots', () => {
    const page = setup();
    page.start();
    const lines = page.context.calls.filter(([name]) => name === 'lineTo');
    assert.ok(lines.length > 0, 'a 1024x768 field should have some nearby pairs');
    assert.ok(lines.length < (page.arcs().length * (page.arcs().length - 1)) / 2, 'but not every pair');
  });

  test('keeps the dots inside the viewport as they drift', () => {
    const page = setup({ width: 300, height: 300 });
    page.start();
    for (let frame = 0; frame < 300; frame += 1) page.runFrame();
    for (const [, x, y] of page.arcs().slice(-14)) {
      assert.ok(x > -5 && x < 305 && y > -5 && y < 305, `dot escaped to ${x}, ${y}`);
    }
  });

  describe('reduced motion', () => {
    test('draws one still frame and never schedules animation', () => {
      const page = setup({ reducedMotion: true });
      page.start();
      assert.ok(page.arcs().length > 0);
      assert.equal(page.frames.size, 0);
    });

    test('reacts when the preference changes while the page is open', () => {
      const page = setup();
      page.start();
      assert.equal(page.frames.size, 1);

      page.media.set(REDUCED, true);
      assert.equal(page.frames.size, 0, 'animation stops');

      page.media.set(REDUCED, false);
      assert.equal(page.frames.size, 1, 'animation resumes');
    });
  });

  test('pauses while the tab is hidden and resumes when it is visible again', () => {
    const page = setup();
    page.start();
    assert.equal(page.frames.size, 1);
    page.hide(true);
    assert.equal(page.frames.size, 0);
    page.hide(false);
    assert.equal(page.frames.size, 1);
  });

  test('does not start animating when the page is already hidden', () => {
    const page = setup();
    Object.defineProperty(page.document, 'hidden', { configurable: true, get: () => true });
    page.start();
    assert.equal(page.frames.size, 0);
  });

  test('stop() cancels animation and removes every listener', () => {
    const page = setup();
    const handle = page.start();
    handle.stop();
    assert.equal(page.frames.size, 0);
    assert.equal(page.media.listenerCount(REDUCED), 0);

    page.hide(false);
    page.media.set(REDUCED, false);
    page.window.dispatchEvent(new page.window.Event('resize'));
    assert.equal(page.frames.size, 0, 'nothing may restart after stop()');
  });

  test('after stop(), a pending resize is cancelled and later resizes are ignored', async () => {
    const page = setup({ reducedMotion: true });
    const handle = page.start();
    assert.equal(page.canvas.width, 1024);

    page.window.innerWidth = 500;
    page.window.dispatchEvent(new page.window.Event('resize')); // debounced: still pending when we stop
    handle.stop();
    page.window.innerWidth = 400;
    page.window.dispatchEvent(new page.window.Event('resize')); // listener must be gone

    await new Promise((resolve) => setTimeout(resolve, 250)); // longer than the 120ms debounce
    assert.equal(page.canvas.width, 1024, 'the canvas must not be touched after stop()');
  });

  test('uses the theme colour from --backdrop-rgb', () => {
    const page = setup({ reducedMotion: true, rgb: '1, 2, 3' });
    page.start();
    assert.equal(compact(page.context.fillStyle), 'rgba(1,2,3,0.7)');
  });

  test('repaints in the new colour when the theme changes, even while still', async () => {
    const page = setup({ reducedMotion: true, rgb: '1, 2, 3' });
    page.start();

    page.style.textContent = ':root { --backdrop-rgb: 9, 8, 7; }';
    page.document.documentElement.dataset.theme = 'light';
    await waitFor(() => compact(page.context.fillStyle) === 'rgba(9,8,7,0.7)');
  });

  test('re-measures after a resize, debounced', async () => {
    const page = setup({ reducedMotion: true });
    page.start();
    assert.equal(page.canvas.width, 1024);

    page.window.innerWidth = 500;
    page.window.innerHeight = 400;
    page.window.dispatchEvent(new page.window.Event('resize'));
    page.window.dispatchEvent(new page.window.Event('resize'));
    assert.equal(page.canvas.width, 1024, 'not immediately');
    await waitFor(() => page.canvas.width === 500);
    assert.equal(page.canvas.height, 400);
  });
});
