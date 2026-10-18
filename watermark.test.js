import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, mkdtemp, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { drawWatermark, WATERMARK_FONT, cleanup } from './transcode.js';

const execFileAsync = promisify(execFile);
const exists = async (f) => { try { await access(f); return true; } catch { return false; } };

// Real ffmpeg, because the filter string is the thing that breaks. Skipped
// where ffmpeg or the font is absent (a dev laptop); runs in the container,
// which is the environment the args have to be correct for.
test('drawWatermark writes a file and keeps the audio stream', async (t) => {
  try { await execFileAsync('ffmpeg', ['-version']); } catch { return t.skip('ffmpeg not installed'); }
  if (!(await exists(WATERMARK_FONT))) return t.skip(`font missing: ${WATERMARK_FONT}`);

  const dir = await mkdtemp(join(tmpdir(), 'wmtest-'));
  try {
    const src = join(dir, 'source.mp4');
    const out = join(dir, 'out.mp4');
    await execFileAsync('ffmpeg', [
      '-y',
      '-f', 'lavfi', '-i', 'testsrc=size=320x240:duration=1:rate=10',
      '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono',
      '-shortest', '-c:a', 'aac', src,
    ]);

    await drawWatermark(src, out);

    assert.ok((await stat(out)).size > 0, 'output must not be empty');
    const { stdout } = await execFileAsync('ffprobe', [
      '-v', 'error', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', out,
    ]);
    assert.ok(stdout.includes('audio'), 'audio must survive -codec:a copy');
  } finally {
    await cleanup(dir);
  }
});
