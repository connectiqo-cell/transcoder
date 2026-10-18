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

// Alpine's font-dejavu package (see Dockerfile). drawtext needs an explicit
// fontfile — the image ships no fontconfig families to resolve a bare name.
export const WATERMARK_FONT =
  process.env.WATERMARK_FONT || '/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf';

// The review copy is deliberately small: the brand is judging the content, not
// buying this file. 480 on the short side costs ~5x less CPU and storage than
// full res, and what leaks is visibly worse than what they pay for. min() keeps
// it from upscaling a smaller source, and -2 lets the long side follow.
const REVIEW_SCALE =
  "scale='if(gt(iw,ih),-2,min(480,iw))':'if(gt(iw,ih),min(480,ih),-2)'";

/**
 * Burn the semi-transparent "Connectiqo" watermark into `input` (a local file
 * or a URL ffmpeg can read — a signed URL streams, which keeps whole videos
 * out of this process's memory).
 *
 * This is the copy a brand reviews before paying; the clean original is never
 * shown to them. Video is re-encoded (the text has to live in the pixels),
 * audio is copied untouched.
 */
export async function drawWatermark(input, outputFile, fontFile = WATERMARK_FONT) {
  await run('ffmpeg', [
    '-y', '-i', input,
    '-vf',
    `${REVIEW_SCALE},drawtext=fontfile=${fontFile}:text='Connectiqo'` +
      // fontsize scales with the frame: a fixed 28px is a fleck on 1080p.
      ':fontcolor=white@0.45:fontsize=h/18:x=(w-text_w)/2:y=(h-text_h)/2' +
      ':shadowcolor=black@0.4:shadowx=2:shadowy=2',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26',
    '-profile:v', 'main', '-pix_fmt', 'yuv420p',
    // Front-load the moov atom so the brand's player starts immediately
    // instead of fetching the whole file first.
    '-movflags', '+faststart',
    '-codec:a', 'copy',
    outputFile,
  ]);
}
