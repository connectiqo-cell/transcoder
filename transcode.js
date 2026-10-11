import { spawn } from 'node:child_process';
import { mkdtemp, rm, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { selectRungs, scaleFilter, buildMasterManifest } from './ladder.js';

const run = (cmd, args) =>
  new Promise((resolve, reject) => {
    const p = spawn(cmd, args);
    let stderr = '';
    p.stderr.on('data', d => { stderr += d.toString().slice(-2000); });
    p.on('error', reject);
    p.on('close', code =>
      code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}: ${stderr.slice(-800)}`)));
  });

/** Source dimensions, or zeros if ffprobe can't read them. */
export function probeSize(file) {
  return new Promise((resolve) => {
    const p = spawn('ffprobe', [
      '-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height', '-of', 'csv=p=0:s=x', file,
    ]);
    let out = '';
    p.stdout.on('data', d => { out += d.toString(); });
    p.on('close', () => {
      const [w, h] = out.trim().split('x').map(n => parseInt(n, 10));
      resolve({ width: w || 0, height: h || 0 });
    });
    p.on('error', () => resolve({ width: 0, height: 0 }));
  });
}

/**
 * Build an HLS ladder from `inputFile` into a fresh temp directory.
 * Returns { dir, files, masterName }; the caller uploads then cleans up.
 */
export async function buildHls(inputFile) {
  const { width, height } = await probeSize(inputFile);
  const rungs = selectRungs(width, height);
  const dir = await mkdtemp(join(tmpdir(), 'hls-'));

  for (const r of rungs) {
    await run('ffmpeg', [
      '-i', inputFile,
      '-vf', scaleFilter(r),
      // CRF, not constant bitrate: spends bits on what needs them and never
      // inflates an already-efficient source. maxrate caps the peak so a busy
      // scene cannot stall a weak connection.
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(r.crf),
      '-maxrate', r.maxrate, '-bufsize', r.bufsize,
      '-profile:v', 'main', '-pix_fmt', 'yuv420p',
      // Keyframe every 2s (at 30fps) so the player can switch rungs at segment edges.
      '-g', '60', '-keyint_min', '60', '-sc_threshold', '0',
      '-c:a', 'aac', '-b:a', '128k', '-ac', '2',
      '-f', 'hls', '-hls_time', '4', '-hls_playlist_type', 'vod',
      '-hls_segment_filename', join(dir, `${r.name}_%03d.ts`),
      join(dir, `${r.name}.m3u8`),
    ]);
  }

  await writeFile(join(dir, 'master.m3u8'), buildMasterManifest(rungs));
  return { dir, files: await readdir(dir), masterName: 'master.m3u8' };
}

export const readLocal = (dir, name) => readFile(join(dir, name));
export const cleanup = (dir) => rm(dir, { recursive: true, force: true }).catch(() => {});
