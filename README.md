# Connectiqo transcoder

Turns each uploaded mentor video into an HLS adaptive-bitrate ladder so viewers on
weak connections drop to a lower rung instead of buffering.

```
app / website  ──upload──>  Supabase Storage (mentor-videos)
                                    │
                            database webhook
                                    ▼
                            this worker (ffmpeg)
                                    │
                     hls/<video id>/master.m3u8  +  segments
                                    ▼
                        mentor_videos.hls_url = <master.m3u8>
```

Players use `hls_url` when it exists and fall back to `video_url`, so videos are
watchable the moment they upload and simply get better once transcoding finishes.
Nothing breaks if the worker is down — you just don't get the ladder.

## What it produces

Rungs are sized by the **short side**, so vertical feed video scales correctly
(360×640, not 202×360). It never upscales: a 720p source yields 360p and 720p only.

| Rung | Short side | CRF | Peak |
|---|---|---|---|
| 360p | 360 | 26 | 800k |
| 720p | 720 | 24 | 2.5M |
| 1080p | 1080 | 23 | 5M |

CRF targets a quality level rather than a fixed bitrate, so the encoder spends bits
where the content needs them and **never inflates an already-efficient source**.

## Deploy

This follows the same pattern as the web app on your VPS: the container binds to
`127.0.0.1` only, and Caddy is the single public entry point that terminates TLS.
That matters more here than for the website — this service holds the Supabase
service role key, which bypasses every RLS policy you have.

### 1. Get the files onto the server

```bash
# from the repo on the VPS
git pull
cd transcoder
```

Or copy just this directory:

```bash
scp -r transcoder/ user@vps:/opt/connectiqo-transcoder/
```

### 2. Create the .env

```bash
cp .env.example .env
nano .env
```

| Var | Where to get it |
|---|---|
| `SUPABASE_URL` | Supabase dashboard → Settings → API → Project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Same page → `service_role` **secret**. Server only. |
| `WEBHOOK_SECRET` | Generate one: `openssl rand -hex 32` |
| `HOST_PORT` | Only if 8080 is taken on the box. Check with `sudo ss -tlnp \| grep 8080`, pick a free port, and point Caddy at the same one. |

### 3. Start it

```bash
docker compose up -d --build
docker compose logs -f          # should print: [transcoder] listening on 8080
curl localhost:8080/health      # -> ok
```

### 4. Add the Caddy site block

In `/etc/caddy/Caddyfile`, alongside the existing app entry:

```caddy
transcode.connectiqo.com {
    reverse_proxy 127.0.0.1:8080   # match HOST_PORT from .env

    # Only Supabase's webhook should reach this. Everything else gets nothing.
    @notwebhook {
        not path /transcode /health
    }
    respond @notwebhook 404
}
```

Then point a DNS A record for that subdomain at the VPS and reload:

```bash
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

Caddy provisions the TLS certificate automatically.

## Wire up the trigger

Apply `migration.sql` first (paste it into Supabase → SQL Editor), then in the dashboard: **Database → Webhooks → Create**

- Table `mentor_videos`, event **Insert**
- Type **HTTP Request**, method **POST**
- URL `https://<your-host>/transcode`
- Header `x-webhook-secret: <WEBHOOK_SECRET>`

The worker reads `record.id` from the payload, or accepts a plain `{"videoId":"…"}`.

## Behaviour worth knowing

- **One job at a time.** ffmpeg is CPU-bound; running several in parallel on a small
  box just thrashes. Serial is correct until throughput actually becomes a problem.
- **The webhook is acked immediately** (202) and work continues in the background,
  because transcoding outlives any webhook timeout.
- **Crash recovery**: rows stuck in `pending`/`processing` are requeued on boot.
- **Failures are recorded** in `transcode_status='failed'` and `transcode_error`;
  the original stays playable.

## Backfilling existing videos

The migration marks pre-existing rows `skipped` so they are left alone. To transcode
them, POST their ids:

```bash
curl -X POST https://<your-host>/transcode \
  -H 'content-type: application/json' \
  -H 'x-webhook-secret: <WEBHOOK_SECRET>' \
  -d '{"videoId":"<uuid>"}'
```

## Tests

```bash
node --test ladder.test.js
```

Covers the ladder maths: portrait vs landscape sizing, no upscaling, even dimensions,
and master manifest output. The ffmpeg invocation itself is not unit tested — verify
that by transcoding one real video and playing the resulting `master.m3u8`.
