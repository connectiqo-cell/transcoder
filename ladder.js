/**
 * Ladder maths, kept free of ffmpeg so it can be tested directly.
 *
 * Rung sizes name the SHORTER side, not the height. The feed is vertical video:
 * constraining height on a 1080x1920 clip would produce a 202x360 rung, which is
 * useless. Constraining the short side gives 360x640 portrait / 640x360 landscape.
 */

export const LADDER = [
  { name: '360p', short: 360, crf: 26, maxrate: '800k', bufsize: '1600k', bandwidth: 800000 },
  { name: '720p', short: 720, crf: 24, maxrate: '2500k', bufsize: '5000k', bandwidth: 2500000 },
  { name: '1080p', short: 1080, crf: 23, maxrate: '5000k', bufsize: '10000k', bandwidth: 5000000 },
];

/** Even dimensions only — H.264 4:2:0 cannot encode odd width/height. */
const even = (n) => Math.max(2, Math.round(n / 2) * 2);

/**
 * Rungs worth producing for a source of the given dimensions.
 * Never upscales: a 480-short-side source gets 360p only, never a fake 1080p.
 * Unknown dimensions (probe failed) fall back to the whole ladder.
 */
export function selectRungs(width, height) {
  if (!width || !height) return LADDER.map(r => ({ ...r, width: null, height: null }));

  const sourceShort = Math.min(width, height);
  const portrait = height >= width;

  const usable = LADDER.filter(r => r.short <= sourceShort);
  // Source smaller than the lowest rung: emit one rung at the source's own size.
  if (!usable.length) {
    return [{ ...LADDER[0], width: even(width), height: even(height) }];
  }

  return usable.map((r) => {
    const scale = r.short / sourceShort;
    return {
      ...r,
      width: even(portrait ? r.short : width * scale),
      height: even(portrait ? height * scale : r.short),
    };
  });
}

/**
 * ffmpeg -vf value for a rung. Pins the short side and lets the long side follow,
 * so the same expression works for portrait and landscape sources.
 */
export function scaleFilter(rung) {
  if (rung.width && rung.height) return `scale=${rung.width}:${rung.height}`;
  // Dimensions unknown: pin whichever side is shorter at runtime.
  return `scale='if(gt(iw,ih),-2,${rung.short})':'if(gt(iw,ih),${rung.short},-2)'`;
}

export function buildMasterManifest(rungs) {
  const lines = ['#EXTM3U', '#EXT-X-VERSION:3'];
  for (const r of rungs) {
    const res = r.width && r.height ? `,RESOLUTION=${r.width}x${r.height}` : '';
    lines.push(`#EXT-X-STREAM-INF:BANDWIDTH=${r.bandwidth}${res}`);
    lines.push(`${r.name}.m3u8`);
  }
  return `${lines.join('\n')}\n`;
}
