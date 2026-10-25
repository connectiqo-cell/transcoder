import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { grabPoster, cleanup } from './transcode.js';

const execFileAsync = promisify(execFile);

const makeClip = (path, duration) =>
  execFileAsync('ffmpeg', [
    '-y', '-f', 'lavfi',
    '-i', `testsrc=size=320x240:duration=${duration}:rate=10`,
    path,
  ]);

// Real ffmpeg, because the -ss fallback is the thing that breaks. Skipped on a
// dev laptop without ffmpeg; runs in the container, which is what matters.
test('grabPoster writes a JPEG, including for clips shorter than the seek', async (t) => {
  try { await execFileAsync('ffmpeg', ['-version']); } catch { return t.skip('ffmpeg not installed'); }

  const dir = await mkdtemp(join(tmpdir(), 'postertest-'));
  try {
    for (const [name, duration] of [['long', 3], ['short', 0.4]]) {
      const src = join(dir, `${name}.mp4`);
      const out = join(dir, `${name}.jpg`);
      await makeClip(src, duration);
      await grabPoster(src, out);

      assert.ok((await stat(out)).size > 0, `${name}: poster must not be empty`);
      const { stdout } = await execFileAsync('ffprobe', [
        '-v', 'error', '-select_streams', 'v:0',
        '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', out,
      ]);
      assert.match(stdout.trim(), /mjpeg/, `${name}: must be a JPEG`);
    }
  } finally {
    await cleanup(dir);
  }
});
