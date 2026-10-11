-- Server-side HLS transcoding for mentor videos.
--
-- Uploads land as a single progressive MP4. A worker then produces an adaptive
-- bitrate ladder so viewers on weak connections drop a rung instead of buffering.
-- Players keep using video_url until hls_url is ready, so nothing breaks mid-flight
-- and the 95 pre-existing videos keep working untouched.

alter table public.mentor_videos
  add column if not exists hls_url text,
  add column if not exists transcode_status text not null default 'pending',
  add column if not exists transcode_error text,
  add column if not exists transcoded_at timestamptz;

-- 'pending' -> 'processing' -> 'ready' | 'failed'
alter table public.mentor_videos
  drop constraint if exists mentor_videos_transcode_status_check;
alter table public.mentor_videos
  add constraint mentor_videos_transcode_status_check
  check (transcode_status in ('pending', 'processing', 'ready', 'failed', 'skipped'));

-- Rows that existed before transcoding: leave them alone, they play from video_url.
update public.mentor_videos
   set transcode_status = 'skipped'
 where transcode_status = 'pending'
   and created_at < now();

-- The worker claims jobs off this index.
create index if not exists mentor_videos_transcode_pending_idx
  on public.mentor_videos (transcode_status, created_at)
  where transcode_status in ('pending', 'processing');

-- HLS writes land under hls/<video id>/… in the existing bucket. The worker uses the
-- service role (RLS-exempt); these policies only cover player reads.
drop policy if exists "Public read mentor video hls" on storage.objects;
create policy "Public read mentor video hls"
  on storage.objects for select
  to public
  using (bucket_id = 'mentor-videos' and (storage.foldername(name))[1] = 'hls');
