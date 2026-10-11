import http from 'node:http';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp } from 'node:fs/promises';
import { createClient } from '@supabase/supabase-js';
import { buildHls, readLocal, cleanup } from './transcode.js';

const {
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  WEBHOOK_SECRET,
  PORT = 8080,
  BUCKET = 'mentor-videos',
} = process.env;

for (const [k, v] of Object.entries({ SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, WEBHOOK_SECRET })) {
  if (!v) throw new Error(`Missing required env var: ${k}`);
}

// Service role: the worker writes HLS output and status on behalf of the system,
// so it must not be subject to the per-mentor RLS policies.
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

// ponytail: one job at a time, in-process. ffmpeg is CPU-bound, so running N jobs in
// parallel on a small box just thrashes. Swap for a real queue if throughput matters.
let chain = Promise.resolve();
const enqueue = (fn) => {
  chain = chain.then(fn).catch(e => console.error('[queue]', e?.message || e));
  return chain;
};

async function transcodeVideo(videoId) {
  const { data: video, error } = await supabase
    .from('mentor_videos')
    .select('id, storage_path, transcode_status')
    .eq('id', videoId)
    .maybeSingle();

  if (error) throw error;
  if (!video?.storage_path) return;
  if (video.transcode_status === 'ready') return;

  await supabase.from('mentor_videos')
    .update({ transcode_status: 'processing', transcode_error: null })
    .eq('id', videoId);

  let workDir;
  let hlsDir;
  try {
    const { data: blob, error: dlErr } = await supabase.storage
      .from(BUCKET).download(video.storage_path);
    if (dlErr) throw dlErr;

    workDir = await mkdtemp(join(tmpdir(), 'src-'));
    const srcFile = join(workDir, 'source.mp4');
    await writeFile(srcFile, Buffer.from(await blob.arrayBuffer()));

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
    await supabase.from('mentor_videos').update({
      transcode_status: 'failed',
      transcode_error: String(e?.message || e).slice(0, 500),
    }).eq('id', videoId);
  } finally {
    if (workDir) await cleanup(workDir);
    if (hlsDir) await cleanup(hlsDir);
  }
}

/** A crash leaves rows stuck in 'processing'; reclaim them on boot. */
async function requeueStuck() {
  const { data } = await supabase
    .from('mentor_videos')
    .select('id')
    .in('transcode_status', ['pending', 'processing'])
    .order('created_at', { ascending: true })
    .limit(50);
  for (const row of data || []) enqueue(() => transcodeVideo(row.id));
  if (data?.length) console.log(`[boot] requeued ${data.length} job(s)`);
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
  if (req.method !== 'POST' || req.url !== '/transcode') {
    res.writeHead(404).end();
    return;
  }
  if (req.headers['x-webhook-secret'] !== WEBHOOK_SECRET) {
    res.writeHead(401).end('unauthorized');
    return;
  }

  let videoId;
  try {
    const body = JSON.parse(await readBody(req));
    // Accepts a Supabase database webhook payload or a plain { videoId }.
    videoId = body?.record?.id || body?.videoId;
  } catch {
    res.writeHead(400).end('bad json');
    return;
  }
  if (!videoId) {
    res.writeHead(400).end('missing videoId');
    return;
  }

  // Ack immediately: transcoding takes far longer than any webhook timeout.
  res.writeHead(202).end('queued');
  enqueue(() => transcodeVideo(videoId));
}).listen(PORT, () => {
  console.log(`[transcoder] listening on ${PORT}`);
  requeueStuck();
});
