-- =============================================================================
-- Migration 014 — KGR corpus-write governance
--
-- Makes KGR sign-off the exclusive route to the promulgated corpus
-- (system_prompt + implemented qa_pairs), enforced by role privilege, and
-- finishes three half-built pieces of the KGR lifecycle:
--   * a signed-off / escalated question leaves the actionable queue,
--   * a replacement answer retires the answer it replaces (atomically),
--   * an answer being reworked in an open case can be served with a caveat.
--
-- Design: scratchpad/kgr-corpus-write-governance-plan.md (v3.2). All parts
-- lettered to match plan §4.1.
--
-- SCOPE OF THIS FILE: schema + function bodies only. It is deliberately
-- PGlite-applicable (plain SECURITY INVOKER functions, no role attributes, no
-- ALTER FUNCTION ... OWNER), so the isolated-DB test harness can exercise the
-- lifecycle logic. The database-enforcement layer — the kgr_corpus_writer
-- BYPASSRLS role, the enumerated grant contract, the service_role corpus-DML
-- revoke, and sign_off_kgr_resolution's SECURITY DEFINER + OWNER — is migration
-- 015, which requires real PostgreSQL. Applying 014 without 015 yields the
-- application-enforced fallback: editor write routes are gone and the Worker is
-- trusted, but the database does not itself block a service_role corpus write.
-- =============================================================================

BEGIN;

-- ═══ (a) gap_resolution_requests — closure and companion columns ═══════════════
ALTER TABLE gap_resolution_requests
  ADD COLUMN IF NOT EXISTS resolved_at                 TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS resolved_kgr_case_id        BIGINT REFERENCES kgr_cases(id),
  ADD COLUMN IF NOT EXISTS resolved_qa_pair_id         UUID   REFERENCES qa_pairs(id),
  ADD COLUMN IF NOT EXISTS resolved_system_prompt_page TEXT,
  ADD COLUMN IF NOT EXISTS escalated_at                TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS companion_of_request_id     BIGINT REFERENCES gap_resolution_requests(id);

COMMENT ON COLUMN gap_resolution_requests.resolved_at IS
  'Set only by sign_off_kgr_resolution, in the same transaction that publishes. Non-null = promulgated-resolved; the question leaves the actionable queue.';
COMMENT ON COLUMN gap_resolution_requests.escalated_at IS
  'Set only by escalate_kgr_case. Non-null = the case hit the constitutional boundary and is suspended, pending a future Phase. The question leaves the actionable queue but is NOT resolved.';
COMMENT ON COLUMN gap_resolution_requests.companion_of_request_id IS
  'Set only by open_companion_case. Points at the parent request when a single problem needs two corpus targets; the companion has its own question/route/case/lifecycle.';

-- ═══ (b) kgr_cases — resolution target + frozen system-prompt predecessor ═══════
ALTER TABLE kgr_cases
  ADD COLUMN IF NOT EXISTS resolution_target         TEXT NOT NULL DEFAULT 'qa_pair'
    CHECK (resolution_target IN ('qa_pair', 'system_prompt')),
  ADD COLUMN IF NOT EXISTS supersedes_qa_pair_id     UUID REFERENCES qa_pairs(id),
  ADD COLUMN IF NOT EXISTS target_system_prompt_page TEXT
    CHECK (target_system_prompt_page IS NULL OR target_system_prompt_page IN
      ('all','home','intake','discovery','yours','admin','proposal','resources')),
  ADD COLUMN IF NOT EXISTS target_sp_expected_present BOOLEAN,
  ADD COLUMN IF NOT EXISTS target_sp_expected_md5     TEXT,
  ADD COLUMN IF NOT EXISTS target_revision           INTEGER NOT NULL DEFAULT 0;

COMMENT ON COLUMN kgr_cases.resolution_target IS
  'What this case will change at sign-off. qa_pair + supersedes NULL = new answer; qa_pair + supersedes set = replacement; system_prompt = a page revision. Set via set_kgr_case_target while in_development; frozen when the case leaves in_development; read (never re-chosen) at sign-off.';
COMMENT ON COLUMN kgr_cases.target_revision IS
  'Bumped by every set_kgr_case_target call. A contribution (submit_kgr_solution) must still match this at insert, or it is rejected as stale.';

-- ═══ (c) qa_pairs — retirement link columns ═══════════════════════════════════
ALTER TABLE qa_pairs
  ADD COLUMN IF NOT EXISTS superseded_by_qa_pair_id UUID REFERENCES qa_pairs(id),
  ADD COLUMN IF NOT EXISTS superseded_at            TIMESTAMPTZ;

COMMENT ON COLUMN qa_pairs.superseded_by_qa_pair_id IS
  'Set only by sign_off_kgr_resolution on a replacement outcome, together with status=redundant. Points at the row that replaced this one.';

-- ═══ (d) system_prompt_history + the durable prompt-outcome link ══════════════
CREATE TABLE IF NOT EXISTS system_prompt_history (
  id                          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  page                        TEXT NOT NULL,
  prior_content               TEXT,            -- NULL <=> the page did not previously exist
  prior_content_present       BOOLEAN NOT NULL,
  adopted_content             TEXT NOT NULL,   -- the exact version published by this sign-off
  replaced_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  kgr_resolution_statement_id BIGINT REFERENCES kgr_resolution_statements(id)
);
ALTER TABLE system_prompt_history ENABLE ROW LEVEL SECURITY;   -- no policy; corpus-writer + service_role (BYPASSRLS) only

COMMENT ON TABLE system_prompt_history IS
  'One immutable row per KGR system_prompt revision: the prior page content (or NULL if the page was new), the exact adopted content, and the signed-off statement it came from. Never served, never re-enters KGR. Written only by sign_off_kgr_resolution.';

ALTER TABLE kgr_resolution_statements
  ADD COLUMN IF NOT EXISTS system_prompt_history_id BIGINT REFERENCES system_prompt_history(id);

COMMENT ON COLUMN kgr_resolution_statements.system_prompt_history_id IS
  'Durable publication reference for a system_prompt outcome (mirrors qa_pair_id for a qa_pair outcome). Exactly one of the two is set after sign-off.';

-- ═══ (j-prep) routes.route_reason — allow the companion origin ═════════════════
ALTER TABLE public.routes DROP CONSTRAINT IF EXISTS routes_route_reason_check;
ALTER TABLE public.routes ADD CONSTRAINT routes_route_reason_check
  CHECK (route_reason = ANY (ARRAY[
    'scr'::text, 'knowledge_gap'::text, 'constitutional_candidate'::text,
    'kb_grounded'::text, 'source_conflict'::text, 'scr_fallthrough'::text,
    'kgr_companion'::text
  ]));

-- questions.source may carry a CHECK constraint (the table predates this repo).
-- Widen whatever CHECK references only `source` to also allow 'kgr_companion',
-- without needing to know its name up front.
DO $mig$
DECLARE
  v_conname TEXT;
  v_def     TEXT;
BEGIN
  SELECT c.conname, pg_get_constraintdef(c.oid)
    INTO v_conname, v_def
  FROM pg_constraint c
  JOIN pg_class t ON t.oid = c.conrelid
  WHERE t.relname = 'questions'
    AND c.contype = 'c'
    AND pg_get_constraintdef(c.oid) ILIKE '%source%'
  LIMIT 1;

  IF v_conname IS NOT NULL AND v_def NOT ILIKE '%kgr_companion%' THEN
    -- Insert 'kgr_companion' as the last element of the first ARRAY[...] literal
    -- in the constraint definition (the usual `source = ANY (ARRAY[...])` shape).
    -- If the constraint is not of that shape, this leaves it unchanged and the
    -- companion INSERT will surface it loudly at first use.
    IF v_def ~ 'ARRAY\[[^\]]*\]' THEN
      v_def := regexp_replace(v_def, '(ARRAY\[[^\]]*?)(\s*\])',
                              '\1, ''kgr_companion''::text\2');
      EXECUTE format('ALTER TABLE public.questions DROP CONSTRAINT %I', v_conname);
      EXECUTE format('ALTER TABLE public.questions ADD CONSTRAINT %I %s', v_conname, v_def);
      RAISE NOTICE 'widened questions constraint % to allow source=kgr_companion', v_conname;
    ELSE
      RAISE WARNING 'questions has a source CHECK (%) not of ARRAY shape; widen it by hand before using open_companion_case', v_conname;
    END IF;
  END IF;
END
$mig$;

-- ═══ (e) database-enforced write exclusivity — see migration 015 ══════════════
--   The kgr_corpus_writer BYPASSRLS role, the enumerated grant contract, the
--   service_role corpus-DML revoke, and sign_off_kgr_resolution's SECURITY
--   DEFINER + OWNER TO kgr_corpus_writer all live in 015. They need real
--   PostgreSQL role attributes and ALTER FUNCTION ... OWNER, which PGlite does
--   not implement. 014 alone gives the application-enforced fallback.

-- ═══ (f) sign_off_kgr_resolution — target branch; supersession; history;
--          single-row request closure ═══════════════════════════════════════════
--   Defined here as SECURITY INVOKER. Migration 015 promotes it to SECURITY
--   DEFINER and reassigns it to kgr_corpus_writer; the body is unchanged and is
--   fully schema-qualified + `SET search_path = ''` so the promotion is a pure
--   privilege change.
CREATE OR REPLACE FUNCTION sign_off_kgr_resolution(
  p_statement_id  BIGINT,
  p_candidate_id  BIGINT,
  p_signed_off_by UUID
) RETURNS TABLE(statement_id BIGINT, qa_pair_id UUID)
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_claimed_id            BIGINT;
  v_case_id               BIGINT;
  v_problem_statement     TEXT;
  v_presented_content     TEXT;
  v_winner_hypothesis_id  BIGINT;
  v_qa_pair_id            UUID;
  v_pruned_hypothesis_ids BIGINT[];
  v_target                TEXT;
  v_supersedes_id         UUID;
  v_sp_page               TEXT;
  v_sp_expected_present    BOOLEAN;
  v_sp_expected_md5        TEXT;
  v_pred_page              TEXT;
  v_cur_content            TEXT;
  v_cur_present            BOOLEAN;
  v_sph_id                 BIGINT;
BEGIN
  -- Selected candidate must belong to this statement.
  SELECT c.presented_content, c.kgr_hypothesis_id
    INTO v_presented_content, v_winner_hypothesis_id
  FROM public.kgr_resolution_candidates c
  WHERE c.id = p_candidate_id AND c.kgr_resolution_statement_id = p_statement_id;
  IF v_presented_content IS NULL THEN
    RAISE EXCEPTION 'candidate % does not belong to statement %', p_candidate_id, p_statement_id;
  END IF;

  -- Serialize against any late submit/withdraw/prepare on the same case.
  SELECT s.kgr_case_id INTO v_case_id
  FROM public.kgr_resolution_statements s
  JOIN public.kgr_cases k ON k.id = s.kgr_case_id
  WHERE s.id = p_statement_id
  FOR UPDATE OF k;

  UPDATE public.kgr_resolution_statements
  SET selected_candidate_id = p_candidate_id,
      signed_off_by = p_signed_off_by,
      signed_off_at = pg_catalog.now()
  WHERE id = p_statement_id AND signed_off_at IS NULL
  RETURNING id, problem_statement INTO v_claimed_id, v_problem_statement;

  IF v_claimed_id IS NULL THEN
    RAISE EXCEPTION 'statement % is already signed off', p_statement_id;
  END IF;

  -- 0033/0035 pruning: losing snapshot candidates' hypotheses, minus the winner's
  -- shared hypothesis, minus anything not still 'accepted'.
  SELECT pg_catalog.array_agg(DISTINCT c.kgr_hypothesis_id) INTO v_pruned_hypothesis_ids
  FROM public.kgr_resolution_candidates c
  JOIN public.kgr_hypotheses h ON h.id = c.kgr_hypothesis_id
  WHERE c.kgr_resolution_statement_id = p_statement_id
    AND c.id <> p_candidate_id
    AND c.kgr_hypothesis_id <> v_winner_hypothesis_id
    AND h.status = 'accepted';

  DELETE FROM public.kgr_resolution_candidates
  WHERE kgr_resolution_statement_id = p_statement_id AND id <> p_candidate_id;

  DELETE FROM public.kgr_candidate_solutions WHERE kgr_case_id = v_case_id;

  IF v_pruned_hypothesis_ids IS NOT NULL THEN
    DELETE FROM public.kgr_hypotheses WHERE id = ANY(v_pruned_hypothesis_ids);
  END IF;

  -- Load the frozen resolution target.
  SELECT k.resolution_target, k.supersedes_qa_pair_id, k.target_system_prompt_page,
         k.target_sp_expected_present, k.target_sp_expected_md5
    INTO v_target, v_supersedes_id, v_sp_page, v_sp_expected_present, v_sp_expected_md5
  FROM public.kgr_cases k WHERE k.id = v_case_id;

  IF v_target = 'qa_pair' THEN
    IF v_supersedes_id IS NULL THEN
      -- New answer: unchanged publication literal.
      INSERT INTO public.qa_pairs (question, answer, page, source, status)
      VALUES (v_problem_statement, v_presented_content, 'all', 'kgr', 'implemented')
      RETURNING id INTO v_qa_pair_id;
    ELSE
      -- Replacement: publish on the predecessor's page; fail on a stale predecessor.
      SELECT page INTO v_pred_page FROM public.qa_pairs
      WHERE id = v_supersedes_id AND status = 'implemented' FOR UPDATE;
      IF v_pred_page IS NULL THEN
        RAISE EXCEPTION 'sign-off blocked: the pair this case replaces (%) is no longer a current implemented row (another case superseded it). A new KGR case is required to resolve against the current answer.', v_supersedes_id;
      END IF;
      INSERT INTO public.qa_pairs (question, answer, page, source, status)
      VALUES (v_problem_statement, v_presented_content, v_pred_page, 'kgr', 'implemented')
      RETURNING id INTO v_qa_pair_id;
      UPDATE public.qa_pairs
        SET status = 'redundant', superseded_by_qa_pair_id = v_qa_pair_id, superseded_at = pg_catalog.now()
      WHERE id = v_supersedes_id AND status = 'implemented';
      IF NOT FOUND THEN
        RAISE EXCEPTION 'sign-off blocked: the pair this case replaces (%) changed during sign-off. A new KGR case is required.', v_supersedes_id;
      END IF;
    END IF;
    UPDATE public.kgr_resolution_statements SET qa_pair_id = v_qa_pair_id WHERE id = p_statement_id;

  ELSIF v_target = 'system_prompt' THEN
    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('kgr_sysprompt:' || v_sp_page, 0));
    SELECT content INTO v_cur_content FROM public.system_prompt WHERE page = v_sp_page;
    v_cur_present := FOUND;
    IF v_cur_present <> COALESCE(v_sp_expected_present, false)
       OR (v_cur_present AND pg_catalog.md5(v_cur_content) IS DISTINCT FROM v_sp_expected_md5) THEN
      RAISE EXCEPTION 'sign-off blocked: system_prompt page % was modified after this case reached Ready. A new KGR case is required to resolve against the current page content.', v_sp_page;
    END IF;
    INSERT INTO public.system_prompt_history
      (page, prior_content, prior_content_present, adopted_content, kgr_resolution_statement_id)
    VALUES (v_sp_page, v_cur_content, v_cur_present, v_presented_content, p_statement_id)
    RETURNING id INTO v_sph_id;
    INSERT INTO public.system_prompt (page, content, updated_at)
    VALUES (v_sp_page, v_presented_content, pg_catalog.now())
    ON CONFLICT (page) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at;
    UPDATE public.kgr_resolution_statements SET system_prompt_history_id = v_sph_id WHERE id = p_statement_id;
    v_qa_pair_id := NULL;
  END IF;

  -- Close the originating request — exactly one row, or fail the whole transaction.
  UPDATE public.gap_resolution_requests grr
     SET resolved_at = pg_catalog.now(),
         resolved_kgr_case_id = v_case_id,
         resolved_qa_pair_id = v_qa_pair_id,
         resolved_system_prompt_page = CASE WHEN v_target = 'system_prompt' THEN v_sp_page END
    FROM public.kgr_cases k
   WHERE k.id = v_case_id AND grr.id = k.gap_resolution_request_id AND grr.resolved_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'sign-off did not close exactly one originating request for case %', v_case_id;
  END IF;

  RETURN QUERY SELECT v_claimed_id, v_qa_pair_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.sign_off_kgr_resolution(BIGINT, BIGINT, UUID) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.sign_off_kgr_resolution(BIGINT, BIGINT, UUID) TO service_role;

-- ═══ (g) escalate_kgr_case — stamp the originating request ════════════════════
CREATE OR REPLACE FUNCTION escalate_kgr_case(
  p_case_id BIGINT,
  p_reason  TEXT
) RETURNS SETOF kgr_cases
LANGUAGE plpgsql
AS $$
DECLARE
  v_status TEXT;
BEGIN
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN
    RAISE EXCEPTION 'an escalation reason is required';
  END IF;

  SELECT status INTO v_status FROM kgr_cases WHERE id = p_case_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'case % not found', p_case_id;
  END IF;
  IF v_status <> 'in_development' THEN
    RAISE EXCEPTION 'case % is already %', p_case_id, v_status;
  END IF;

  UPDATE gap_resolution_requests grr
     SET escalated_at = now()
    FROM kgr_cases k
   WHERE k.id = p_case_id AND grr.id = k.gap_resolution_request_id AND grr.escalated_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'escalation did not stamp exactly one originating request for case %', p_case_id;
  END IF;

  RETURN QUERY
  UPDATE kgr_cases
    SET status = 'escalated', escalation_reason = p_reason, updated_at = now()
    WHERE id = p_case_id
    RETURNING *;
END;
$$;

REVOKE EXECUTE ON FUNCTION escalate_kgr_case(BIGINT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION escalate_kgr_case(BIGINT, TEXT) TO service_role;

-- ═══ (h) start_kgr_case — atomic Start Case (replaces the non-atomic handler) ══
CREATE OR REPLACE FUNCTION start_kgr_case(
  p_request_id BIGINT,
  p_reviewer   UUID
) RETURNS SETOF kgr_cases
LANGUAGE plpgsql
AS $$
DECLARE
  v_resolved   TIMESTAMPTZ;
  v_escalated  TIMESTAMPTZ;
  v_authorized TIMESTAMPTZ;
  v_new_id     BIGINT;
BEGIN
  SELECT resolved_at, escalated_at, authorized_at
    INTO v_resolved, v_escalated, v_authorized
  FROM gap_resolution_requests WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'gap_resolution_requests row % not found', p_request_id;
  END IF;
  IF v_resolved IS NOT NULL THEN
    RAISE EXCEPTION 'request % is already resolved', p_request_id;
  END IF;
  IF v_escalated IS NOT NULL THEN
    RAISE EXCEPTION 'request % is escalated', p_request_id;
  END IF;
  IF EXISTS (SELECT 1 FROM kgr_cases WHERE gap_resolution_request_id = p_request_id) THEN
    RAISE EXCEPTION 'a case already exists for request %', p_request_id;
  END IF;

  IF v_authorized IS NULL THEN
    UPDATE gap_resolution_requests
      SET authorized_at = now(), authorized_by = p_reviewer
      WHERE id = p_request_id;
  END IF;

  INSERT INTO kgr_cases (gap_resolution_request_id, status, created_by, resolution_target, target_revision)
  VALUES (p_request_id, 'in_development', p_reviewer, 'qa_pair', 0)
  RETURNING id INTO v_new_id;

  RETURN QUERY SELECT * FROM kgr_cases WHERE id = v_new_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION start_kgr_case(BIGINT, UUID) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION start_kgr_case(BIGINT, UUID) TO service_role;

-- ═══ (i) set_kgr_case_target — guarded target-setting; revision bump ══════════
CREATE OR REPLACE FUNCTION set_kgr_case_target(
  p_case_id                BIGINT,
  p_target                 TEXT,
  p_supersedes_qa_pair_id  UUID,
  p_sp_page                TEXT,
  p_reviewer               UUID
) RETURNS SETOF kgr_cases
LANGUAGE plpgsql
AS $$
DECLARE
  v_status      TEXT;
  v_old_target  TEXT;
  v_old_sp_page TEXT;
  v_kind_change BOOLEAN;
  v_page_change BOOLEAN;
  v_cur_content TEXT;
  v_cur_present BOOLEAN;
BEGIN
  IF p_target NOT IN ('qa_pair', 'system_prompt') THEN
    RAISE EXCEPTION 'resolution_target must be qa_pair or system_prompt';
  END IF;
  IF p_target = 'system_prompt' THEN
    IF p_sp_page IS NULL OR p_sp_page NOT IN
       ('all','home','intake','discovery','yours','admin','proposal','resources') THEN
      RAISE EXCEPTION 'a valid system_prompt page is required for a system_prompt target';
    END IF;
    IF p_supersedes_qa_pair_id IS NOT NULL THEN
      RAISE EXCEPTION 'supersedes_qa_pair_id is not valid for a system_prompt target';
    END IF;
  ELSE  -- qa_pair
    IF p_sp_page IS NOT NULL THEN
      RAISE EXCEPTION 'a page is not valid for a qa_pair target';
    END IF;
    IF p_supersedes_qa_pair_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM qa_pairs WHERE id = p_supersedes_qa_pair_id AND status = 'implemented') THEN
      RAISE EXCEPTION 'supersedes_qa_pair_id % is not a current implemented row', p_supersedes_qa_pair_id;
    END IF;
  END IF;

  SELECT status, resolution_target, target_system_prompt_page
    INTO v_status, v_old_target, v_old_sp_page
  FROM kgr_cases WHERE id = p_case_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'case % not found', p_case_id;
  END IF;
  IF v_status <> 'in_development' THEN
    RAISE EXCEPTION 'case % is % - the target can only be changed while in_development', p_case_id, v_status;
  END IF;

  v_kind_change := (v_old_target IS DISTINCT FROM p_target);
  v_page_change := (p_target = 'system_prompt' AND v_old_sp_page IS DISTINCT FROM p_sp_page);

  IF v_kind_change OR v_page_change THEN
    DELETE FROM kgr_candidate_solutions WHERE kgr_case_id = p_case_id;
  END IF;

  IF p_target = 'system_prompt' THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('kgr_sysprompt:' || p_sp_page, 0));
    SELECT content INTO v_cur_content FROM system_prompt WHERE page = p_sp_page;
    v_cur_present := FOUND;
    UPDATE kgr_cases SET
      resolution_target = 'system_prompt',
      supersedes_qa_pair_id = NULL,
      target_system_prompt_page = p_sp_page,
      target_sp_expected_present = v_cur_present,
      target_sp_expected_md5 = CASE WHEN v_cur_present THEN md5(v_cur_content) END,
      target_revision = target_revision + 1,
      updated_at = now()
    WHERE id = p_case_id;
  ELSE
    UPDATE kgr_cases SET
      resolution_target = 'qa_pair',
      supersedes_qa_pair_id = p_supersedes_qa_pair_id,
      target_system_prompt_page = NULL,
      target_sp_expected_present = NULL,
      target_sp_expected_md5 = NULL,
      target_revision = target_revision + 1,
      updated_at = now()
    WHERE id = p_case_id;
  END IF;

  RETURN QUERY SELECT * FROM kgr_cases WHERE id = p_case_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION set_kgr_case_target(BIGINT, TEXT, UUID, TEXT, UUID) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION set_kgr_case_target(BIGINT, TEXT, UUID, TEXT, UUID) TO service_role;

-- ═══ (j) open_companion_case — a second corpus target for one problem ═════════
CREATE OR REPLACE FUNCTION open_companion_case(
  p_parent_request_id BIGINT,
  p_problem_text      TEXT,
  p_reviewer          UUID
) RETURNS TABLE(request_id BIGINT, case_id BIGINT)
LANGUAGE plpgsql
AS $$
DECLARE
  v_parent_case  BIGINT;
  v_question_id  BIGINT;
  v_route_id     BIGINT;
  v_request_id   BIGINT;
  v_case_id      BIGINT;
BEGIN
  IF p_problem_text IS NULL OR btrim(p_problem_text) = '' THEN
    RAISE EXCEPTION 'a problem statement is required for a companion case';
  END IF;

  SELECT k.id INTO v_parent_case
  FROM gap_resolution_requests grr
  JOIN kgr_cases k ON k.gap_resolution_request_id = grr.id
  WHERE grr.id = p_parent_request_id
  FOR UPDATE OF grr;
  IF v_parent_case IS NULL THEN
    RAISE EXCEPTION 'parent request % has no case - a companion hangs off a real case', p_parent_request_id;
  END IF;

  INSERT INTO questions (source, question_text, asked_by)
  VALUES ('kgr_companion', p_problem_text, NULL)
  RETURNING id INTO v_question_id;

  INSERT INTO routes (score_id, route_decision, route_reason)
  VALUES (NULL, 'resolve_gap', 'kgr_companion')
  RETURNING id INTO v_route_id;

  INSERT INTO gap_resolution_requests
    (route_id, question_id, candidate_answer_id, companion_of_request_id, authorized_at, authorized_by)
  VALUES (v_route_id, v_question_id, NULL, p_parent_request_id, now(), p_reviewer)
  RETURNING id INTO v_request_id;

  INSERT INTO kgr_cases (gap_resolution_request_id, status, created_by, resolution_target, target_revision)
  VALUES (v_request_id, 'in_development', p_reviewer, 'qa_pair', 0)
  RETURNING id INTO v_case_id;

  request_id := v_request_id;
  case_id    := v_case_id;
  RETURN NEXT;
END;
$$;

REVOKE EXECUTE ON FUNCTION open_companion_case(BIGINT, TEXT, UUID) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION open_companion_case(BIGINT, TEXT, UUID) TO service_role;

-- ═══ (k) submit_kgr_solution — bind the contribution to a target revision ═════
--   The parameter list changes, so DROP the old signature (not CREATE OR REPLACE,
--   which would leave a 10-arg overload with no revision check).
DROP FUNCTION IF EXISTS submit_kgr_solution(BIGINT, BIGINT, TEXT, TEXT, UUID, NUMERIC, TEXT, TEXT, TEXT, TEXT);

CREATE OR REPLACE FUNCTION submit_kgr_solution(
  p_case_id             BIGINT,
  p_hypothesis_id       BIGINT,
  p_proposed_content    TEXT,
  p_origin              TEXT,
  p_submitted_by        UUID,
  p_score               NUMERIC,
  p_rationale           TEXT,
  p_provisions_hash     TEXT,
  p_problem_snapshot    TEXT,
  p_submission_key      TEXT,
  p_target_revision     INTEGER
) RETURNS SETOF kgr_candidate_solutions
LANGUAGE plpgsql
AS $$
DECLARE
  v_case_status         TEXT;
  v_stored_problem      TEXT;
  v_case_target_revision INTEGER;
  v_hyp_status          TEXT;
  v_existing            kgr_candidate_solutions%ROWTYPE;
  v_new_id              BIGINT;
BEGIN
  IF p_origin NOT IN ('human', 'assistant_assisted') THEN
    RAISE EXCEPTION 'origin must be human or assistant_assisted';
  END IF;
  IF p_proposed_content IS NULL OR btrim(p_proposed_content) = '' THEN
    RAISE EXCEPTION 'proposed_content is required';
  END IF;
  IF p_submission_key IS NULL OR btrim(p_submission_key) = '' THEN
    RAISE EXCEPTION 'submission_key is required';
  END IF;
  IF p_score IS NULL OR p_score < 0 OR p_score > 1 THEN
    RAISE EXCEPTION 'score must be between 0 and 1';
  END IF;
  IF p_rationale IS NULL OR btrim(p_rationale) = '' THEN
    RAISE EXCEPTION 'rationale is required';
  END IF;
  IF p_provisions_hash IS NULL OR btrim(p_provisions_hash) = '' THEN
    RAISE EXCEPTION 'constitutional_provisions_hash is required';
  END IF;
  IF p_problem_snapshot IS NULL OR btrim(p_problem_snapshot) = '' THEN
    RAISE EXCEPTION 'problem_snapshot is required';
  END IF;
  IF p_target_revision IS NULL THEN
    RAISE EXCEPTION 'p_target_revision is required';
  END IF;

  -- Serialize every contribution/withdraw/ready/prepare/set-target for this case.
  SELECT status, contribution_problem_snapshot, target_revision
    INTO v_case_status, v_stored_problem, v_case_target_revision
  FROM kgr_cases WHERE id = p_case_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'case % not found', p_case_id;
  END IF;
  IF v_case_status <> 'in_development' THEN
    RAISE EXCEPTION 'case % is % - contributions are closed', p_case_id, v_case_status;
  END IF;
  IF v_case_target_revision IS DISTINCT FROM p_target_revision THEN
    RAISE EXCEPTION 'the case resolution target changed while this contribution was being evaluated (case revision % vs submitted %); re-read the case and re-contribute',
      v_case_target_revision, p_target_revision;
  END IF;

  -- Retry identity: same key + same content -> return the saved row;
  -- same key + different content -> conflict.
  SELECT * INTO v_existing
  FROM kgr_candidate_solutions
  WHERE kgr_case_id = p_case_id
    AND submitted_by = p_submitted_by
    AND submission_key = p_submission_key;
  IF FOUND THEN
    IF v_existing.proposed_content = p_proposed_content THEN
      RETURN NEXT v_existing;
      RETURN;
    END IF;
    RAISE EXCEPTION 'submission_key % already used for different content', p_submission_key;
  END IF;

  -- The hypothesis must be accepted and on this case.
  SELECT status INTO v_hyp_status
  FROM kgr_hypotheses WHERE id = p_hypothesis_id AND kgr_case_id = p_case_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'hypothesis % is not on case %', p_hypothesis_id, p_case_id;
  END IF;
  IF v_hyp_status <> 'accepted' THEN
    RAISE EXCEPTION 'hypothesis % is % - a solution may only be contributed against an accepted hypothesis', p_hypothesis_id, v_hyp_status;
  END IF;

  -- Establish or verify the case-level contribution problem snapshot.
  IF v_stored_problem IS NULL THEN
    UPDATE kgr_cases
      SET contribution_problem_snapshot = p_problem_snapshot, updated_at = now()
      WHERE id = p_case_id;
  ELSIF v_stored_problem <> p_problem_snapshot THEN
    RAISE EXCEPTION 'problem snapshot mismatch - re-read the case and re-score against contribution_problem_snapshot';
  END IF;

  INSERT INTO kgr_candidate_solutions (
    kgr_case_id, kgr_hypothesis_id, proposed_content, submitted_by, origin,
    score, rationale, constitutional_provisions_hash, problem_snapshot, submission_key
  ) VALUES (
    p_case_id, p_hypothesis_id, p_proposed_content, p_submitted_by, p_origin,
    p_score, p_rationale, p_provisions_hash, p_problem_snapshot, p_submission_key
  )
  RETURNING id INTO v_new_id;

  RETURN QUERY SELECT * FROM kgr_candidate_solutions WHERE id = v_new_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION submit_kgr_solution(BIGINT, BIGINT, TEXT, TEXT, UUID, NUMERIC, TEXT, TEXT, TEXT, TEXT, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION submit_kgr_solution(BIGINT, BIGINT, TEXT, TEXT, UUID, NUMERIC, TEXT, TEXT, TEXT, TEXT, INTEGER) TO service_role;

COMMIT;
