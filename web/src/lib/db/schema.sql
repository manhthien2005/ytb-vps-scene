create table if not exists schema_migrations (
  version integer primary key,
  applied_at timestamptz not null default now()
);

create table if not exists jobs (
  id text primary key,
  project_name text not null check (length(project_name) between 1 and 160),
  state text not null check (state in (
    'DRAFT','READY','QUEUED','CLAIMED','DOWNLOADING','OCR','TRANSLATE','REVIEW_READY','PAUSED_REVIEW',
    'TTS','RENDER','UPLOADING','COMPLETED','PAUSED_QUOTA','PAUSED_NO_WORKER',
    'FAILED_RETRYABLE','FAILED_FINAL','CANCEL_REQUESTED','CANCELLED','DELETING','DELETED'
  )),
  progress_percent integer not null default 0 check (progress_percent between 0 and 100),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists audit_events (
  id bigint generated always as identity primary key,
  event_type text not null check (length(event_type) between 1 and 80),
  target_id text,
  actor_class text not null check (actor_class in ('admin','worker','cron','system')),
  payload jsonb not null default '{}'::jsonb check (pg_column_size(payload) <= 16384),
  created_at timestamptz not null default now()
);

create table if not exists auth_login_windows (
  key_hash text primary key check (length(key_hash) = 64),
  window_started timestamptz not null,
  attempt_count integer not null check (attempt_count between 1 and 1000),
  blocked_until timestamptz
);

create index if not exists jobs_updated_at_idx on jobs(updated_at desc);
create index if not exists audit_events_created_at_idx on audit_events(created_at desc);
insert into schema_migrations(version) values (1) on conflict (version) do nothing;
