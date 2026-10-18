-- CollabHub watermarking moved off the website's Next.js route and onto this
-- worker. The website's own migrations already created campaign_submissions
-- and both buckets; this only adds what the worker needs.

-- A failed ffmpeg pass used to leave the row on 'processing' with nothing to
-- show the creator. Mirrors mentor_videos.transcode_error.
alter table public.campaign_submissions
  add column if not exists watermark_error text;

-- The worker claims jobs off this index (and requeues stuck rows on boot).
create index if not exists campaign_submissions_processing_idx
  on public.campaign_submissions (status, submitted_at)
  where status = 'processing';
