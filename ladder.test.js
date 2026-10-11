import test from 'node:test';
import assert from 'node:assert/strict';
import { selectRungs, scaleFilter, buildMasterManifest } from './ladder.js';

test('vertical source sizes rungs by the short side, not height', () => {
  const rungs = selectRungs(1080, 1920);
  assert.equal(rungs.length, 3);
  // 360p of a portrait clip must be 360 WIDE (360x640), not 360 tall (202x360).
  assert.deepEqual(
    rungs.map(r => `${r.width}x${r.height}`),
    ['360x640', '720x1280', '1080x1920'],
  );
});

test('landscape source sizes rungs by height', () => {
  const rungs = selectRungs(1920, 1080);
  assert.deepEqual(
    rungs.map(r => `${r.width}x${r.height}`),
    ['640x360', '1280x720', '1920x1080'],
  );
});

test('never upscales beyond the source', () => {
  const rungs = selectRungs(720, 1280); // 720 short side
  assert.deepEqual(rungs.map(r => r.name), ['360p', '720p']);
});

test('source below the lowest rung yields one rung at source size', () => {
  const rungs = selectRungs(240, 426);
  assert.equal(rungs.length, 1);
  assert.equal(rungs[0].width, 240);
  assert.equal(rungs[0].height, 426);
});

test('all dimensions are even (H.264 4:2:0 requires it)', () => {
  for (const [w, h] of [[1079, 1921], [641, 361], [1080, 1920], [333, 777]]) {
    for (const r of selectRungs(w, h)) {
      assert.equal(r.width % 2, 0, `width ${r.width} odd for ${w}x${h}`);
      assert.equal(r.height % 2, 0, `height ${r.height} odd for ${w}x${h}`);
    }
  }
});

test('unknown dimensions fall back to a runtime orientation check', () => {
  const rungs = selectRungs(0, 0);
  assert.equal(rungs.length, 3);
  assert.match(scaleFilter(rungs[0]), /if\(gt\(iw,ih\)/);
});

test('known dimensions produce a fixed scale filter', () => {
  const [first] = selectRungs(1080, 1920);
  assert.equal(scaleFilter(first), 'scale=360:640');
});

test('master manifest lists every rung with bandwidth and resolution', () => {
  const m = buildMasterManifest(selectRungs(1080, 1920));
  assert.match(m, /^#EXTM3U/);
  assert.match(m, /BANDWIDTH=800000,RESOLUTION=360x640\n360p\.m3u8/);
  assert.match(m, /BANDWIDTH=5000000,RESOLUTION=1080x1920\n1080p\.m3u8/);
});
