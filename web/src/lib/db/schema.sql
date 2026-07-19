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

create table if not exists projects (
  id text primary key check (id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  status text not null check (status in ('PROVISIONING','READY','FAILED')),
  name text not null check (name = btrim(name) and length(name) between 1 and 160),
  source_status text not null check (source_status in ('NO_SOURCE','UPLOAD_PENDING','SOURCE_READY','UPLOAD_FAILED')),
  creation_idempotency_key_hash text not null unique check (creation_idempotency_key_hash ~ '^[0-9a-f]{64}$'),
  creation_request_hash text not null check (creation_request_hash ~ '^[0-9a-f]{64}$'),
  drive_project_folder_id text check (drive_project_folder_id is null or length(drive_project_folder_id) between 10 and 256),
  drive_input_folder_id text check (drive_input_folder_id is null or length(drive_input_folder_id) between 10 and 256),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    (status = 'READY' and drive_project_folder_id is not null and drive_input_folder_id is not null)
    or status <> 'READY'
  )
);

create table if not exists artifacts (
  id text primary key check (id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  project_id text not null references projects(id),
  kind text not null check (kind in ('SOURCE','CHECKPOINT','OUTPUT')),
  status text not null check (status in ('PENDING','UPLOADING','READY','INVALID','DELETED')),
  drive_file_id text not null check (length(drive_file_id) between 10 and 256),
  drive_parent_id text not null check (length(drive_parent_id) between 10 and 256),
  display_name text not null check (display_name = btrim(display_name) and length(display_name) between 1 and 255),
  mime_type text not null check (mime_type = btrim(mime_type) and length(mime_type) between 1 and 127),
  expected_size_bytes bigint not null check (expected_size_bytes between 1 and 1099511627776),
  actual_size_bytes bigint check (actual_size_bytes is null or actual_size_bytes >= 0),
  checksum_sha256 text check (checksum_sha256 is null or checksum_sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  verified_at timestamptz
);

create unique index if not exists artifacts_one_live_source_per_project_idx
  on artifacts(project_id) where kind = 'SOURCE' and status <> 'DELETED';
create index if not exists artifacts_project_id_idx on artifacts(project_id);

create table if not exists oauth_credentials (
  id smallint primary key check (id = 1),
  status text not null check (status in ('CONNECTED','REAUTH_REQUIRED','REVOKE_PENDING','DISCONNECTED')),
  ciphertext bytea check (ciphertext is null or octet_length(ciphertext) <= 4096),
  nonce bytea,
  auth_tag bytea,
  key_version smallint,
  scope text,
  account_hint text check (
    account_hint is null
    or (length(account_hint) between 1 and 255 and position('*' in account_hint) > 0)
  ),
  account_permission_id_hash text check (
    account_permission_id_hash is null or account_permission_id_hash ~ '^[0-9a-f]{64}$'
  ),
  root_folder_id text check (root_folder_id is null or length(root_folder_id) between 10 and 256),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_verified_at timestamptz,
  check (
    (
      status in ('CONNECTED','REVOKE_PENDING')
      and ciphertext is not null
      and nonce is not null
      and auth_tag is not null
      and octet_length(nonce) = 12
      and octet_length(auth_tag) = 16
      and key_version = 1
      and scope = 'https://www.googleapis.com/auth/drive.file'
      and account_permission_id_hash ~ '^[0-9a-f]{64}$'
      and root_folder_id is not null
    )
    or
    (
      status in ('REAUTH_REQUIRED','DISCONNECTED')
      and ciphertext is null
      and nonce is null
      and auth_tag is null
      and key_version is null
      and scope is null
    )
  )
);

create table if not exists oauth_states (
  nonce_hash text primary key check (nonce_hash ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  consumed_at timestamptz
);
create index if not exists oauth_states_expires_at_idx on oauth_states(expires_at);

create table if not exists usage_guards (
  provider text primary key check (provider in ('DRIVE','NEON')),
  used_bytes bigint not null check (used_bytes >= 0),
  limit_bytes bigint not null check (limit_bytes > 0),
  app_managed_bytes bigint not null check (app_managed_bytes >= 0),
  mode text not null check (mode in ('READ_WRITE','READ_ONLY')),
  reason_codes jsonb not null default '[]'::jsonb check (
    jsonb_typeof(reason_codes) = 'array'
    and pg_column_size(reason_codes) <= 2048
    and not jsonb_path_exists(reason_codes, '$[*] ? (@.type() != "string")')
    and jsonb_path_query_array(
      reason_codes,
      '$[*] ? (@ like_regex "^[A-Z][A-Z0-9_]{0,79}$")'
    ) = reason_codes
  ),
  observed_at timestamptz not null,
  updated_at timestamptz not null default now()
);

insert into schema_migrations(version) values (2) on conflict (version) do nothing;
