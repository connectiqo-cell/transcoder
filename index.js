import http from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp } from 'node:fs/promises';
import { createClient } from '@supabase/supabase-js';
import { buildHls, drawWatermark, grabPoster, readLocal, cleanup } from './transcode.js';

const {
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  WEBHOOK_SECRET,
  PORT = 8080,
  BUCKET = 'mentor-videos',
} = process.env;

// Same bucket the apps upload a hand-picked cover to.
const THUMB_BUCKET = 'mentor-videos-thumbnail';

for (const [k, v] of Object.entries({ SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, WEBHOOK_SECRET })) {
  if (!v) throw new Error(`Missing required env var: ${k}`);
}

// CollabHub submissions: fixed bucket names, created by the website's migration
// (campaign-submissions is private, -watermarked is public).
// ponytail: fixed 5-minute sweep, no backoff. A row that fails every sweep
// burns one ffmpeg run per 5 min; add an attempt counter if that shows up.
const SWEEP_MS = 5 * 60 * 1000;
const SUBMISSIONS_BUCKET = 'campaign-submissions';
const WATERMARKED_BUCKET = 'campaign-submissions-watermarked';
// Long enough for ffmpeg to stream a big file end to end.
const SIGNED_URL_TTL = 60 * 60;
const CONTENT_TYPE_BY_EXT = {
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
};

// Service role: the worker writes HLS output and status on behalf of the system,
// so it must not be subject to the per-mentor RLS policies.
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

// ponytail: one job at a time, in-process. ffmpeg is CPU-bound, so running N jobs in
// parallel on a small box just thrashes. Swap for a real queue if throughput matters.
let chain = Promise.resolve();
// Keyed in-flight set: the periodic sweep and a webhook can name the same job,
// and running ffmpeg twice over one row wastes the one CPU slot there is.
const inFlight = new Set();
const enqueue = (key, fn) => {
  if (inFlight.has(key)) return chain;
  inFlight.add(key);
  chain = chain
    .then(fn)
    .catch(e => console.error('[queue]', e?.message || e))
    .finally(() => inFlight.delete(key));
  return chain;
};

// `posterOnly` is for the backfill sweep: it must never start a ladder encode on
// an old video the migration deliberately marked 'skipped'. A webhook or a manual
// POST still transcodes whatever it is handed.
async function transcodeVideo(videoId, { posterOnly = false } = {}) {
  const { data: video, error } = await supabase
    .from('mentor_videos')
    .select('id, mentor_id, storage_path, transcode_status, thumbnail_url')
    .eq('id', videoId)
    .maybeSingle();

  if (error) throw error;
  if (!video?.storage_path) return;

  // A row can come back here only for its poster — an older video that was
  // transcoded before posters existed, or one whose owner never picked a cover.
  const needsHls = !posterOnly && video.transcode_status !== 'ready';
  const needsPoster = !video.thumbnail_url;
  if (!needsHls && !needsPoster) return;

  if (needsHls) {
    await supabase.from('mentor_videos')
      .update({ transcode_status: 'processing', transcode_error: null })
      .eq('id', videoId);
  }

  let workDir;
  let hlsDir;
  try {
    const { data: blob, error: dlErr } = await supabase.storage
      .from(BUCKET).download(video.storage_path);
    if (dlErr) throw dlErr;

    workDir = await mkdtemp(join(tmpdir(), 'src-'));
    const srcFile = join(workDir, 'source.mp4');
    await writeFile(srcFile, Buffer.from(await blob.arrayBuffer()));

    if (needsPoster) {
      // Fixed path per video: a re-run overwrites its own poster instead of
      // leaving an orphan behind in the bucket.
      const posterPath = `${video.mentor_id}/${videoId}_poster.jpg`;
      const posterFile = join(workDir, 'poster.jpg');
      await grabPoster(srcFile, posterFile);
      const { error: posterErr } = await supabase.storage.from(THUMB_BUCKET).upload(
        posterPath,
        await readFile(posterFile),
        { upsert: true, contentType: 'image/jpeg', cacheControl: '31536000' },
      );
      if (posterErr) throw posterErr;
      const { data: posterPub } = supabase.storage.from(THUMB_BUCKET).getPublicUrl(posterPath);
      // Written now, not with the hls_url below: the ladder takes minutes on a
      // long video and the card should stop looking broken within seconds.
      await supabase.from('mentor_videos')
        .update({ thumbnail_url: posterPub.publicUrl })
        .eq('id', videoId);
      console.log(`[poster] ${videoId} generated`);
    }

    if (!needsHls) return;

    const { dir, files, masterName } = await buildHls(srcFile);
    hlsDir = dir;

    const prefix = `hls/${videoId}`;
    for (const name of files) {
      const body = await readLocal(dir, name);
      const { error: upErr } = await supabase.storage.from(BUCKET).upload(
        `${prefix}/${name}`,
        body,
        {
          upsert: true,
          contentType: name.endsWith('.m3u8')
            ? 'application/vnd.apple.mpegurl'
            : 'video/mp2t',
          cacheControl: '31536000',
        },
      );
      if (upErr) throw upErr;
    }

    const { data: pub } = supabase.storage.from(BUCKET).getPublicUrl(`${prefix}/${masterName}`);
    await supabase.from('mentor_videos').update({
      hls_url: pub.publicUrl,
      transcode_status: 'ready',
      transcoded_at: new Date().toISOString(),
    }).eq('id', videoId);

    console.log(`[transcode] ${videoId} ready (${files.length} files)`);
  } catch (e) {
    console.error(`[transcode] ${videoId} failed:`, e?.message || e);
    // A poster-only run must not reopen a row that already transcoded fine.
    if (needsHls) {
      await supabase.from('mentor_videos').update({
        transcode_status: 'failed',
        transcode_error: String(e?.message || e).slice(0, 500),
      }).eq('id', videoId);
    }
  } finally {
    if (workDir) await cleanup(workDir);
    if (hlsDir) await cleanup(hlsDir);
  }
}

/**
 * CollabHub: watermark one creator submission so the brand can review it
 * without getting the usable file. Same shape as transcodeVideo above —
 * read, ffmpeg, upload, flip the row. The output is a small review proxy,
 * not a copy of the original (see drawWatermark).
 */
async function watermarkSubmission(submissionId) {
  const { data: sub, error } = await supabase
    .from('campaign_submissions')
    .select('id, original_storage_path, status, watermark_error')
    .eq('id', submissionId)
    .maybeSingle();

  if (error) throw error;
  if (!sub?.original_storage_path) return;
  // Only 'processing' is ours to act on; a resubmission sets it back to that.
  if (sub.status !== 'processing') return;
  // A failure writes watermark_error, and that UPDATE fires the webhook again.
  // Without this the row would retry itself forever, pinning the one CPU slot.
  // Retries are deliberate instead: the sweep clears the error, as does a
  // resubmission.
  if (sub.watermark_error) return;

  let workDir;
  try {
    // Signed URL, not download(): ffmpeg streams it, so a 500MB submission
    // never becomes a 500MB Buffer in this process.
    const { data: signed, error: signErr } = await supabase.storage
      .from(SUBMISSIONS_BUCKET).createSignedUrl(sub.original_storage_path, SIGNED_URL_TTL);
    if (signErr) throw signErr;

    // Extension comes from a client-chosen storage key: whitelist it, so an odd
    // value cannot land in a temp path or a Content-Type.
    const rawExt = (sub.original_storage_path.split('.').pop() || '').toLowerCase();
    const ext = rawExt in CONTENT_TYPE_BY_EXT ? rawExt : 'mp4';
    workDir = await mkdtemp(join(tmpdir(), 'wm-'));
    const outName = `watermarked.${ext}`;
    await drawWatermark(signed.signedUrl, join(workDir, outName));

    // Same object path in the watermarked bucket, so the pair is obvious.
    const { error: upErr } = await supabase.storage.from(WATERMARKED_BUCKET).upload(
      sub.original_storage_path,
      await readLocal(workDir, outName),
      {
        upsert: true,
        contentType: CONTENT_TYPE_BY_EXT[ext],
        // Paths are timestamped per submission, so the object never changes
        // under a URL — cache it like the HLS segments.
        cacheControl: '31536000',
      },
    );
    if (upErr) throw upErr;

    const { data: pub } = supabase.storage
      .from(WATERMARKED_BUCKET).getPublicUrl(sub.original_storage_path);

    const { error: updErr } = await supabase.from('campaign_submissions').update({
      watermarked_storage_path: sub.original_storage_path,
      watermarked_video_url: pub.publicUrl,
      status: 'submitted',
      watermark_error: null,
      updated_at: new Date().toISOString(),
    }).eq('id', submissionId);
    if (updErr) throw updErr;

    console.log(`[watermark] ${submissionId} submitted`);
  } catch (e) {
    console.error(`[watermark] ${submissionId} failed:`, e?.message || e);
    // Status stays 'processing' so the sweep can pick it up again; the
    // creator's screen reads watermark_error instead of spinning forever.
    await supabase.from('campaign_submissions').update({
      watermark_error: String(e?.message || e).slice(0, 500),
      updated_at: new Date().toISOString(),
    }).eq('id', submissionId);
  } finally {
    if (workDir) await cleanup(workDir);
  }
}

/**
 * A crash leaves rows stuck mid-job, and Supabase webhooks are fire-and-forget,
 * so nothing else retries. Runs on boot and on an interval; the in-flight set
 * keeps a sweep from re-enqueuing work already running.
 */
async function requeueStuck() {
  const { data } = await supabase
    .from('mentor_videos')
    .select('id')
    .in('transcode_status', ['pending', 'processing'])
    .order('created_at', { ascending: true })
    .limit(50);
  for (const row of data || []) enqueue(`v:${row.id}`, () => transcodeVideo(row.id));
  if (data?.length) console.log(`[boot] requeued ${data.length} transcode job(s)`);

  // Videos with no cover image: the ones uploaded before posters existed, and
  // any whose insert webhook never landed. Poster only — an old 'skipped' row
  // stays skipped, exactly as the transcode migration intended.
  // ponytail: no failure marker, so a video ffmpeg can never read is re-downloaded
  // every sweep. Add a poster_error column if that ever shows up in the logs.
  const { data: noPoster } = await supabase
    .from('mentor_videos')
    .select('id')
    .is('thumbnail_url', null)
    .order('created_at', { ascending: true })
    .limit(50);
  for (const row of noPoster || []) {
    enqueue(`v:${row.id}`, () => transcodeVideo(row.id, { posterOnly: true }));
  }
  if (noPoster?.length) console.log(`[sweep] ${noPoster.length} video(s) missing a poster`);

  // Clearing watermark_error is what makes a failed row eligible again — see
  // the guard in watermarkSubmission.
  const { data: subs } = await supabase
    .from('campaign_submissions')
    .update({ watermark_error: null })
    .eq('status', 'processing')
    .not('watermark_error', 'is', null)
    .select('id');
  const { data: fresh } = await supabase
    .from('campaign_submissions')
    .select('id')
    .eq('status', 'processing')
    .is('watermark_error', null)
    .order('submitted_at', { ascending: true })
    .limit(50);
  for (const row of fresh || []) enqueue(`s:${row.id}`, () => watermarkSubmission(row.id));
  if (subs?.length) console.log(`[sweep] cleared ${subs.length} failed watermark job(s) for retry`);
}

const readBody = (req) =>
  new Promise((resolve) => {
    let b = '';
    req.on('data', c => { b += c; });
    req.on('end', () => resolve(b));
  });

http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200).end('ok');
    return;
  }
  const route = req.method === 'POST' ? req.url : null;
  if (route !== '/transcode' && route !== '/watermark') {
    res.writeHead(404).end();
    return;
  }
  if (req.headers['x-webhook-secret'] !== WEBHOOK_SECRET) {
    res.writeHead(401).end('unauthorized');
    return;
  }

  let id;
  try {
    const body = JSON.parse(await readBody(req));
    // Accepts a Supabase database webhook payload or a plain id.
    id = body?.record?.id || body?.videoId || body?.submissionId;
  } catch {
    res.writeHead(400).end('bad json');
    return;
  }
  if (!id) {
    res.writeHead(400).end('missing id');
    return;
  }

  // Ack immediately: ffmpeg takes far longer than any webhook timeout.
  res.writeHead(202).end('queued');
  enqueue(
    route === '/watermark' ? `s:${id}` : `v:${id}`,
    () => (route === '/watermark' ? watermarkSubmission(id) : transcodeVideo(id)),
  );
}).listen(PORT, () => {
  console.log(`[transcoder] listening on ${PORT}`);
  requeueStuck();
  setInterval(requeueStuck, SWEEP_MS).unref();
});
