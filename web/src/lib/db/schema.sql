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
  status text not null check (status in ('PENDING','UPLOADING','DELETING','READY','INVALID','DELETED')),
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

-- migration v3: cancellation claims must work on databases created before DELETING existed
do $$
begin
  if not exists(select 1 from schema_migrations where version = 3) then
    alter table artifacts drop constraint if exists artifacts_status_check;
    alter table artifacts add constraint artifacts_status_check check (
      status in ('PENDING','UPLOADING','DELETING','READY','INVALID','DELETED')
    );
  end if;
end $$;

insert into schema_migrations(version) values (3) on conflict (version) do nothing;

create table if not exists drive_provisioning_claims (
  resource_kind text not null check (resource_kind in ('PROJECT','SOURCE')),
  resource_id text not null check (resource_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  claim_token text not null check (claim_token ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key(resource_kind, resource_id)
);
create index if not exists drive_provisioning_claims_expires_at_idx
  on drive_provisioning_claims(expires_at);

insert into schema_migrations(version) values (4) on conflict (version) do nothing;

create table if not exists drive_upload_reservations (
  artifact_id text primary key check (artifact_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  project_id text not null unique references projects(id),
  drive_parent_id text not null check (length(drive_parent_id) between 10 and 256),
  display_name text not null check (display_name = btrim(display_name) and length(display_name) between 1 and 255),
  mime_type text not null check (mime_type = btrim(mime_type) and length(mime_type) between 1 and 127),
  expected_size_bytes bigint not null check (expected_size_bytes between 1 and 1099511627776),
  observed_size_bytes bigint not null default 0 check (observed_size_bytes >= 0),
  remaining_bytes bigint not null check (remaining_bytes >= 0),
  released_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (observed_size_bytes <= expected_size_bytes),
  check (
    (released_at is null and observed_size_bytes + remaining_bytes = expected_size_bytes)
    or (released_at is not null and remaining_bytes = 0)
  )
);

insert into drive_upload_reservations(
  artifact_id,project_id,drive_parent_id,display_name,mime_type,
  expected_size_bytes,observed_size_bytes,remaining_bytes
)
select
  id,project_id,drive_parent_id,display_name,mime_type,
  expected_size_bytes,0,expected_size_bytes
from artifacts
where kind='SOURCE' and status in ('PENDING','UPLOADING')
on conflict(artifact_id) do nothing;

create or replace function reserve_drive_upload_capacity(
  p_artifact_id text,
  p_project_id text,
  p_drive_parent_id text,
  p_display_name text,
  p_mime_type text,
  p_expected_size_bytes bigint,
  p_claim_token text,
  p_now timestamptz,
  p_soft_percent integer,
  p_stale_after_seconds integer
) returns text
language plpgsql as $$
declare
  quota usage_guards%rowtype;
  reservation drive_upload_reservations%rowtype;
  artifact_status text;
  has_artifact boolean;
  has_reservation boolean;
  replacing_unbound boolean := false;
  total_remaining numeric;
  retained_reason text;
begin
  if p_soft_percent < 1 or p_soft_percent > 90
     or p_stale_after_seconds < 0 or p_stale_after_seconds > 900
     or p_expected_size_bytes < 1 or p_now is null then
    return 'QUOTA_INVALID';
  end if;

  select * into quota from usage_guards where provider='DRIVE' for update;
  if not found then return 'DRIVE_QUOTA_STALE'; end if;
  if quota.used_bytes > quota.limit_bytes or quota.app_managed_bytes > quota.used_bytes then
    return 'QUOTA_INVALID';
  end if;
  if quota.observed_at > p_now
     or quota.observed_at < p_now - make_interval(secs => p_stale_after_seconds) then
    return 'DRIVE_QUOTA_STALE';
  end if;
  if quota.mode <> 'READ_WRITE' then
    retained_reason := quota.reason_codes ->> 0;
    if retained_reason is null or retained_reason not in (
      'DRIVE_STORAGE_HIGH','NEON_STORAGE_HIGH','DRIVE_QUOTA_STALE','QUOTA_INVALID'
    ) then retained_reason := 'QUOTA_INVALID'; end if;
    return retained_reason;
  end if;
  if not exists(
    select 1 from drive_provisioning_claims
    where resource_kind='SOURCE' and resource_id=p_artifact_id
      and claim_token=p_claim_token and expires_at > now()
  ) then return 'DRIVE_TEMPORARILY_UNAVAILABLE'; end if;
  if not exists(
    select 1 from projects
    where id=p_project_id and status='READY' and drive_input_folder_id=p_drive_parent_id
  ) then return 'CONFLICT'; end if;

  select status into artifact_status from artifacts where id=p_artifact_id for update;
  has_artifact := found;
  select * into reservation
  from drive_upload_reservations where artifact_id=p_artifact_id for update;
  has_reservation := found;

  if has_reservation and reservation.released_at is null then
    if reservation.project_id=p_project_id
       and reservation.drive_parent_id=p_drive_parent_id
       and reservation.display_name=p_display_name
       and reservation.mime_type=p_mime_type
       and reservation.expected_size_bytes=p_expected_size_bytes
       and (not has_artifact or artifact_status in ('PENDING','UPLOADING')) then
      return 'EXISTING';
    end if;
    if not has_artifact then
      replacing_unbound := true;
    else
      return 'CONFLICT';
    end if;
  end if;

  if has_artifact and artifact_status not in ('INVALID','DELETED') then
    return 'CONFLICT';
  end if;

  select coalesce(sum(
    case
      when released_at is null then
        remaining_bytes + case
          when observed_size_bytes > 0 and updated_at > quota.observed_at
            then observed_size_bytes
          else 0
        end
      when observed_size_bytes > 0 and updated_at > quota.observed_at
        then observed_size_bytes
      else 0
    end
  ),0)::numeric into total_remaining
  from drive_upload_reservations;
  if replacing_unbound then
    total_remaining := total_remaining - reservation.remaining_bytes;
  end if;
  if (quota.used_bytes::numeric + total_remaining + p_expected_size_bytes::numeric) * 100
       >= quota.limit_bytes::numeric * p_soft_percent then
    return 'DRIVE_STORAGE_HIGH';
  end if;

  insert into drive_upload_reservations(
    artifact_id,project_id,drive_parent_id,display_name,mime_type,
    expected_size_bytes,observed_size_bytes,remaining_bytes,released_at
  ) values (
    p_artifact_id,p_project_id,p_drive_parent_id,p_display_name,p_mime_type,
    p_expected_size_bytes,0,p_expected_size_bytes,null
  ) on conflict(artifact_id) do update set
    project_id=excluded.project_id,
    drive_parent_id=excluded.drive_parent_id,
    display_name=excluded.display_name,
    mime_type=excluded.mime_type,
    expected_size_bytes=excluded.expected_size_bytes,
    observed_size_bytes=0,
    remaining_bytes=excluded.expected_size_bytes,
    released_at=null,
    updated_at=now();
  return 'RESERVED';
end $$;

drop function if exists observe_drive_upload_progress(text,bigint);
create or replace function observe_drive_upload_progress(
  p_artifact_id text,
  p_observed_size_bytes bigint,
  p_claim_token text
) returns bigint
language plpgsql as $$
declare
  remaining bigint;
begin
  perform provider from usage_guards where provider='DRIVE' for update;
  if p_claim_token is not null then
    if not exists(
      select 1 from drive_provisioning_claims
      where resource_kind='SOURCE' and resource_id=p_artifact_id
        and claim_token=p_claim_token and expires_at > now()
    ) then return null; end if;
  elsif exists(
    select 1 from drive_provisioning_claims
    where resource_kind='SOURCE' and resource_id=p_artifact_id and expires_at > now()
  ) then
    return null;
  end if;
  update drive_upload_reservations set
    observed_size_bytes=p_observed_size_bytes,
    remaining_bytes=expected_size_bytes-p_observed_size_bytes,
    updated_at=now()
  where artifact_id=p_artifact_id and released_at is null
    and p_observed_size_bytes between 0 and expected_size_bytes
  returning remaining_bytes into remaining;
  return remaining;
end $$;

create or replace function claim_source_deletion(p_artifact_id text) returns text
language plpgsql as $$
declare
  current_status text;
begin
  perform provider from usage_guards where provider='DRIVE' for update;
  select status into current_status
  from artifacts where id=p_artifact_id and kind='SOURCE' for update;
  if not found then return 'CONFLICT'; end if;
  if current_status in ('PENDING','UPLOADING') then
    update artifacts set status='DELETING',updated_at=now() where id=p_artifact_id;
    update drive_upload_reservations set
      observed_size_bytes=0,remaining_bytes=expected_size_bytes,updated_at=now()
    where artifact_id=p_artifact_id and released_at is null;
    return 'CLAIMED';
  end if;
  if current_status='DELETING' then return 'RECONCILE'; end if;
  if current_status='DELETED' then return 'DELETED'; end if;
  return 'CONFLICT';
end $$;

insert into schema_migrations(version) values (5) on conflict (version) do nothing;

-- migration v6: keep progress and terminal bytes charged until a newer
-- authoritative Drive usage observation has had a chance to include them
insert into schema_migrations(version) values (6) on conflict (version) do nothing;

-- migration v7: outbound native worker control, queue, and fenced leases
create table if not exists worker_enrollment_tokens (
  token_digest text primary key check (token_digest ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  check (not (consumed_at is not null and revoked_at is not null))
);
create index if not exists worker_enrollment_tokens_expires_at_idx
  on worker_enrollment_tokens(expires_at);

create table if not exists workers (
  id text primary key check (id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  session_digest text not null unique check (session_digest ~ '^[0-9a-f]{64}$'),
  state text not null check (state in ('SETTING_UP','DOCTOR_FAILED','READY','BUSY','OFFLINE','REVOKED')),
  account_label text check (account_label is null or (account_label = btrim(account_label) and length(account_label) between 1 and 80)),
  capabilities jsonb not null check (jsonb_typeof(capabilities) = 'object' and pg_column_size(capabilities) <= 4096),
  doctor_report jsonb not null check (jsonb_typeof(doctor_report) = 'object' and pg_column_size(doctor_report) <= 4096),
  session_expires_at timestamptz not null,
  heartbeat_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((state = 'REVOKED') = (revoked_at is not null))
);
create index if not exists workers_heartbeat_at_idx on workers(heartbeat_at desc);

alter table jobs add column if not exists project_id text references projects(id);
alter table jobs add column if not exists active_stage text;
alter table jobs add column if not exists error_code text;
alter table jobs add column if not exists request_key_digest text;
create unique index if not exists jobs_request_key_digest_idx on jobs(request_key_digest);
create index if not exists jobs_queue_idx on jobs(created_at) where state = 'QUEUED';

create table if not exists job_leases (
  job_id text primary key references jobs(id),
  worker_id text not null references workers(id),
  fencing_token bigint not null check (fencing_token > 0),
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists job_leases_expires_at_idx on job_leases(expires_at);

create table if not exists job_attempts (
  id bigint generated always as identity primary key,
  job_id text not null references jobs(id),
  worker_id text not null references workers(id),
  fencing_token bigint not null check (fencing_token > 0),
  started_at timestamptz not null,
  ended_at timestamptz,
  outcome text check (outcome is null or outcome in ('COMPLETED','FAILED','LEASE_LOST','CANCELLED')),
  error_code text check (error_code is null or error_code ~ '^[A-Z][A-Z0-9_]{0,79}$'),
  check ((ended_at is null and outcome is null) or (ended_at is not null and outcome is not null))
);
create unique index if not exists job_attempts_fence_idx
  on job_attempts(job_id, fencing_token);

insert into schema_migrations(version) values (7) on conflict (version) do nothing;

-- migration v8: persisted human-reviewed blur rectangles and voice preview settings
create table if not exists project_scene_settings (
  project_id text primary key references projects(id),
  settings jsonb not null check (jsonb_typeof(settings) = 'object' and pg_column_size(settings) <= 4096),
  updated_at timestamptz not null default now()
);
insert into schema_migrations(version) values (8) on conflict (version) do nothing;

-- migration v9: one fenced output artifact per media job
alter table artifacts add column if not exists job_id text references jobs(id);
do $$
begin
  if not exists(select 1 from schema_migrations where version = 12) then
    create unique index if not exists artifacts_one_live_output_per_job_idx
      on artifacts(job_id) where kind='OUTPUT' and status <> 'DELETED';
  end if;
end $$;
insert into schema_migrations(version) values (9) on conflict (version) do nothing;

-- migration v10: durable job settings snapshots, telemetry, progress history,
-- and reusable render settings presets
alter table jobs add column if not exists settings_snapshot jsonb;
alter table jobs add column if not exists source_metadata jsonb;
alter table jobs add column if not exists active_phase text;
alter table jobs add column if not exists phase_progress_percent integer;
alter table jobs add column if not exists latest_message text;
alter table jobs add column if not exists eta_seconds integer;
alter table jobs add column if not exists started_at timestamptz;
alter table jobs add column if not exists completed_at timestamptz;
alter table jobs add column if not exists cancel_requested_at timestamptz;
alter table jobs add column if not exists error_message text;

create or replace function job_source_metadata_keys_are_safe(value jsonb)
returns boolean
language plpgsql
immutable
as $$
declare
  object_entry record;
  child jsonb;
begin
  if value is null then
    return true;
  end if;
  if jsonb_typeof(value) = 'object' then
    for object_entry in
      select object_key, object_value
      from jsonb_each(value) as entries(object_key, object_value)
    loop
      if object_entry.object_key ~* '(access[_-]?token|refresh[_-]?token|worker[_-]?secret|session[_-]?secret|authorization|cookie|stack[_-]?trace|raw[_-]?log)' then
        return false;
      end if;
      if jsonb_typeof(object_entry.object_value) in ('object', 'array')
         and not job_source_metadata_keys_are_safe(object_entry.object_value) then
        return false;
      end if;
    end loop;
    return true;
  elsif jsonb_typeof(value) = 'array' then
    for child in select jsonb_array_elements(value) loop
      if not job_source_metadata_keys_are_safe(child) then
        return false;
      end if;
    end loop;
    return true;
  end if;
  return false;
end
$$;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'jobs'::regclass and conname = 'jobs_settings_snapshot_check'
  ) then
    alter table jobs add constraint jobs_settings_snapshot_check check (
      settings_snapshot is null
      or (
        jsonb_typeof(settings_snapshot) = 'object'
        and pg_column_size(settings_snapshot) <= 8192
      )
    );
  end if;
  update jobs
  set error_code = null
  where error_code is not null
    and error_code !~ '^[A-Z][A-Z0-9_]{0,79}$';
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'jobs'::regclass and conname = 'jobs_source_metadata_check'
  ) then
    alter table jobs add constraint jobs_source_metadata_check check (
      source_metadata is null
      or (
        jsonb_typeof(source_metadata) = 'object'
        and pg_column_size(source_metadata) <= 4096
        and job_source_metadata_keys_are_safe(source_metadata)
      )
    );
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'jobs'::regclass and conname = 'jobs_active_phase_check'
  ) then
    alter table jobs add constraint jobs_active_phase_check check (
      active_phase is null
      or (
        active_phase = btrim(active_phase)
        and length(active_phase) between 1 and 80
        and position(E'\n' in active_phase) = 0
      )
    );
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'jobs'::regclass and conname = 'jobs_phase_progress_percent_check'
  ) then
    alter table jobs add constraint jobs_phase_progress_percent_check check (
      phase_progress_percent is null or phase_progress_percent between 0 and 100
    );
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'jobs'::regclass and conname = 'jobs_latest_message_check'
  ) then
    alter table jobs add constraint jobs_latest_message_check check (
      latest_message is null
      or (
        latest_message = btrim(latest_message)
        and length(latest_message) between 1 and 500
        and position(E'\n' in latest_message) = 0
      )
    );
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'jobs'::regclass and conname = 'jobs_eta_seconds_check'
  ) then
    alter table jobs add constraint jobs_eta_seconds_check check (
      eta_seconds is null or eta_seconds between 0 and 31536000
    );
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'jobs'::regclass and conname = 'jobs_error_code_safe_check'
  ) then
    alter table jobs add constraint jobs_error_code_safe_check check (
      error_code is null or error_code ~ '^[A-Z][A-Z0-9_]{0,79}$'
    );
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'jobs'::regclass and conname = 'jobs_error_message_check'
  ) then
    alter table jobs add constraint jobs_error_message_check check (
      error_message is null
      or (
        error_message = btrim(error_message)
        and length(error_message) between 1 and 500
        and position(E'\n' in error_message) = 0
      )
    );
  end if;
end $$;

create or replace function prevent_job_settings_snapshot_change()
returns trigger
language plpgsql
as $$
begin
  if old.settings_snapshot is not null
     and new.settings_snapshot is distinct from old.settings_snapshot then
    raise exception 'job settings snapshot is immutable';
  end if;
  if old.source_metadata is not null
     and new.source_metadata is distinct from old.source_metadata then
    raise exception 'job source metadata is immutable';
  end if;
  return new;
end
$$;
drop trigger if exists jobs_settings_snapshot_immutable on jobs;
create trigger jobs_settings_snapshot_immutable
before update on jobs
for each row execute function prevent_job_settings_snapshot_change();

create table if not exists job_progress_history (
  id bigint generated always as identity primary key,
  job_id text not null references jobs(id),
  phase text not null check (
    phase = btrim(phase)
    and length(phase) between 1 and 80
    and position(E'\n' in phase) = 0
  ),
  progress_percent integer not null check (progress_percent between 0 and 100),
  message text check (
    message is null
    or (
      message = btrim(message)
      and length(message) between 1 and 500
      and position(E'\n' in message) = 0
    )
  ),
  recorded_at timestamptz not null default now()
);
create index if not exists job_progress_history_job_recorded_idx
  on job_progress_history(job_id, recorded_at desc, id desc);

create table if not exists render_settings_presets (
  id text primary key check (
    id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  ),
  name text not null check (
    name = btrim(name)
    and length(name) between 1 and 100
  ),
  settings jsonb not null check (
    jsonb_typeof(settings) = 'object'
    and pg_column_size(settings) <= 8192
  ),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

insert into schema_migrations(version) values (10) on conflict (version) do nothing;

-- migration v11: YouTube channel connections, cached stats, and per-channel prompts
do $$
begin
  if not exists(select 1 from schema_migrations where version = 11) then
    alter table artifacts drop constraint if exists artifacts_kind_check;
    alter table artifacts add constraint artifacts_kind_check check (
      kind in ('SOURCE','CHECKPOINT','OUTPUT','TRANSCRIPT','THUMB_CANDIDATE')
    );
  end if;
end $$;

create table if not exists youtube_channels (
  id text primary key check (id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  channel_id text not null unique check (channel_id ~ '^UC[A-Za-z0-9_-]{22}$'),
  title text not null check (title = btrim(title) and length(title) between 1 and 160),
  avatar_url text check (avatar_url is null or (length(avatar_url) between 1 and 1024 and avatar_url like 'https://%')),
  published_at timestamptz,
  status text not null check (status in ('CONNECTED','REAUTH_REQUIRED','DISCONNECTED')),
  ciphertext bytea check (ciphertext is null or octet_length(ciphertext) <= 4096),
  nonce bytea,
  auth_tag bytea,
  key_version smallint,
  scope text,
  title_prompt text check (title_prompt is null or length(title_prompt) <= 4000),
  description_prompt text check (description_prompt is null or length(description_prompt) <= 4000),
  description_template text check (description_template is null or length(description_template) <= 5000),
  default_tags jsonb not null default '[]'::jsonb check (
    jsonb_typeof(default_tags) = 'array' and pg_column_size(default_tags) <= 2048
  ),
  thumbnail_prompt_template text check (
    thumbnail_prompt_template is null or length(thumbnail_prompt_template) <= 4000
  ),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    (
      status = 'CONNECTED'
      and ciphertext is not null
      and nonce is not null
      and auth_tag is not null
      and octet_length(nonce) = 12
      and octet_length(auth_tag) = 16
      and key_version = 1
      and scope is not null
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

create table if not exists youtube_channel_stats (
  channel_id text primary key references youtube_channels(id),
  subscriber_count bigint check (subscriber_count is null or subscriber_count >= 0),
  view_count bigint check (view_count is null or view_count >= 0),
  video_count bigint check (video_count is null or video_count >= 0),
  watch_hours bigint check (watch_hours is null or watch_hours >= 0),
  top_videos jsonb not null default '[]'::jsonb check (
    jsonb_typeof(top_videos) = 'array' and pg_column_size(top_videos) <= 8192
  ),
  observed_at timestamptz not null,
  updated_at timestamptz not null default now()
);

insert into schema_migrations(version) values (11) on conflict (version) do nothing;

-- migration v12: one independently resumable OUTPUT artifact per media Part
alter table artifacts add column if not exists part_index integer;
alter table artifacts add column if not exists part_count integer;

do $$
begin
  if not exists(select 1 from schema_migrations where version = 12) then
    update artifacts
    set part_index=1,part_count=1
    where kind='OUTPUT'
      and (part_index is distinct from 1 or part_count is distinct from 1);

    update artifacts
    set part_index=null,part_count=null
    where kind<>'OUTPUT'
      and (part_index is not null or part_count is not null);

    alter table artifacts
      drop constraint if exists artifacts_part_identity_check;
    alter table artifacts
      add constraint artifacts_part_identity_check check (
        (
          kind='OUTPUT'
          and part_index between 1 and part_count
          and part_count between 1 and 999
        )
        or
        (
          kind<>'OUTPUT'
          and part_index is null
          and part_count is null
        )
      );
  end if;
end $$;

drop index if exists artifacts_one_live_output_per_job_idx;
create unique index if not exists artifacts_one_live_output_per_job_part_idx
  on artifacts(job_id,part_index)
  where kind='OUTPUT' and status <> 'DELETED';

insert into schema_migrations(version) values (12) on conflict (version) do nothing;
