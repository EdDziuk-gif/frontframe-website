-- 019: server-held chat sessions, handoff transcript, consent record.
--
-- Repair plan 2026-10-01, Decisions 1, 12, 13, 15, 16, 17, 19, 20. Not yet applied.
--
-- What this adds:
--   * chat_sessions.flow_state / flow_data - where a visitor is in the contact
--     handoff (the server decides this, not the browser). flow_data holds the
--     details collected so far and the exact summary the visitor was shown.
--   * An index on chat_sessions.last_active_at, and discard_idle_chat_sessions():
--     held messages of chats that never reach a handoff are deleted after a
--     number of idle hours (Decision 19: option B, 4 hours is the working value).
--   * lead_alerts.transcript - the held conversation, copied here only when a
--     handoff is made (Decision 15). A trigger clears it whenever the alert's
--     status becomes 'closed', which only a human reviewer sets (Decision 20).
--   * leads.consented_at / consent_notice_version - the visitor's affirmation
--     and the wording version they saw (Appendix C, rule 5).
--
--   * discard_chat_session() / discard_idle_chat_sessions(): chat_sessions is
--     referenced by proposals.session_id (no cascade) and review_queue.session_id
--     (ON DELETE CASCADE). A held chat that either table points at is therefore
--     emptied (conversation, flow state) rather than deleted, so a proposal is
--     never blocked and a review item is never cascaded away.
--
-- Rollback (only while no handoff has been recorded; check first):
--   select count(*) from public.lead_alerts where transcript is not null;
--   drop trigger lead_alerts_clear_transcript_on_close on public.lead_alerts;
--   drop function public.lead_alerts_clear_transcript_on_close();
--   drop function public.discard_idle_chat_sessions(integer);
--   drop function public.discard_chat_session(uuid);
--   alter table public.lead_alerts drop column transcript;
--   alter table public.leads drop column consented_at, drop column consent_notice_version;
--   drop index public.chat_sessions_last_active_idx;
--   alter table public.chat_sessions drop constraint chat_sessions_flow_state_check,
--     drop column flow_state, drop column flow_data;

alter table public.chat_sessions
  add column if not exists flow_state text not null default 'chat',
  add column if not exists flow_data  jsonb not null default '{}'::jsonb;

alter table public.chat_sessions
  add constraint chat_sessions_flow_state_check
  check (flow_state = any (array[
    'chat'::text, 'offered'::text, 'ask_name'::text, 'ask_method'::text,
    'ask_contact'::text, 'ask_zip'::text, 'confirm'::text
  ]));

create index if not exists chat_sessions_last_active_idx
  on public.chat_sessions (last_active_at);

alter table public.lead_alerts
  add column if not exists transcript jsonb;

create or replace function public.lead_alerts_clear_transcript_on_close()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.status = 'closed' then
    new.transcript := null;
  end if;
  return new;
end;
$$;

create trigger lead_alerts_clear_transcript_on_close
  before insert or update on public.lead_alerts
  for each row execute function public.lead_alerts_clear_transcript_on_close();

alter table public.leads
  add column if not exists consented_at timestamptz,
  add column if not exists consent_notice_version text;

create or replace function public.discard_chat_session(p_session_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
begin
  if exists (select 1 from public.proposals where session_id = p_session_id)
     or exists (select 1 from public.review_queue where session_id = p_session_id) then
    update public.chat_sessions
       set conversation = '[]'::jsonb, flow_state = 'chat', flow_data = '{}'::jsonb
     where session_id = p_session_id;
  else
    delete from public.chat_sessions where session_id = p_session_id;
  end if;
  return 1;
end;
$$;

create or replace function public.discard_idle_chat_sessions(p_idle_hours integer)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  n integer := 0;
  r record;
begin
  if p_idle_hours is null or p_idle_hours < 1 then
    raise exception 'p_idle_hours must be at least 1';
  end if;
  for r in
    select session_id from public.chat_sessions
     where last_active_at < now() - make_interval(hours => p_idle_hours)
       -- skip only a session that is already empty and still referenced
       and (conversation <> '[]'::jsonb or flow_state <> 'chat' or flow_data <> '{}'::jsonb
            or (not exists (select 1 from public.proposals p where p.session_id = chat_sessions.session_id)
                and not exists (select 1 from public.review_queue q where q.session_id = chat_sessions.session_id)))
  loop
    perform public.discard_chat_session(r.session_id);
    n := n + 1;
  end loop;
  return n;
end;
$$;

revoke all on function public.discard_chat_session(uuid) from public, anon, authenticated;
revoke all on function public.discard_idle_chat_sessions(integer) from public, anon, authenticated;
grant execute on function public.discard_chat_session(uuid) to service_role;
grant execute on function public.discard_idle_chat_sessions(integer) to service_role;
