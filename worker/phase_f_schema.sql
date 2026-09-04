-- Phase F Candidate 1 — Constitutional Amendment Proposals and Authorization Incidents
-- Apply against live Supabase project ifjsepyzdnpmwyuytppr via the SQL editor.
-- Requires: constitution_amendments and reviewers tables already exist (Phase B).

-- ============================================================
-- constitution_amendment_proposals
-- Pre-promulgation durable working object (REQ-PROF-15).
-- Lifecycle enforced in application code:
--   draft → pending_review → returned → draft
--   pending_review → rejected
--   pending_review → promulgated
-- ============================================================
CREATE TABLE IF NOT EXISTS public.constitution_amendment_proposals (
  id                                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  constitutional_matter               TEXT NOT NULL,
  factual_context                     TEXT NOT NULL,
  material_assumptions                TEXT NOT NULL,
  proposed_decision                   TEXT NOT NULL,
  proposed_provision_title            TEXT,
  affected_provision_number           TEXT,
  expected_preceding_text             TEXT,
  proposed_resulting_text             TEXT NOT NULL,
  interactions_with_other_provisions  TEXT NOT NULL,
  no_conflict_explanation             TEXT NOT NULL,
  source_type                         TEXT NOT NULL
                                      CHECK (source_type IN ('Staff','Operator','Delegate','assistant','outside_resource')),
  submitted_by                        UUID REFERENCES public.reviewers(id) ON DELETE SET NULL,
  status                              TEXT NOT NULL DEFAULT 'draft'
                                      CHECK (status IN ('draft','pending_review','returned','rejected','promulgated')),
  review_notes                        TEXT,
  reviewed_by                         UUID REFERENCES public.reviewers(id) ON DELETE SET NULL,
  returned_at                         TIMESTAMPTZ,
  rejected_at                         TIMESTAMPTZ,
  promulgated_at                      TIMESTAMPTZ,
  resulting_amendment_id              BIGINT REFERENCES public.constitution_amendments(id) ON DELETE SET NULL,
  created_at                          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- authorization_incidents
-- Denied privileged amendment actions (REQ-PROF-18/19/21/22).
-- Aggregation rule: open/reviewed row with matching fingerprint
-- → increment, not insert. Resolved fingerprint recurring → new row.
-- Fingerprint: SHA-256(action|target|actor) computed by worker.
-- ============================================================
CREATE TABLE IF NOT EXISTS public.authorization_incidents (
  id                   BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  acting_reviewer_id   UUID REFERENCES public.reviewers(id) ON DELETE SET NULL,
  acting_identity_text TEXT,
  attempted_action     TEXT NOT NULL,
  target_object        TEXT NOT NULL,
  denial_reason        TEXT NOT NULL,
  incident_fingerprint TEXT NOT NULL,
  first_occurred_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_occurred_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  occurrence_count     INTEGER NOT NULL DEFAULT 1,
  status               TEXT NOT NULL DEFAULT 'open'
                       CHECK (status IN ('open','reviewed','resolved')),
  resolution_notes     TEXT,
  resolved_by          UUID REFERENCES public.reviewers(id) ON DELETE SET NULL,
  resolved_at          TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_authorization_incidents_fingerprint
  ON public.authorization_incidents(incident_fingerprint);

-- ============================================================
-- RPC: promulgate_constitutional_amendment
-- Six-step atomic promulgation (REQ-PROF-05..09).
-- Authority check (can_amend_constitution) is enforced by the
-- worker before calling this function; the RPC enforces lifecycle
-- and stale-text rules only.
-- ============================================================
CREATE OR REPLACE FUNCTION public.promulgate_constitutional_amendment(
  p_proposal_id  BIGINT,
  p_operator_id  UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_proposal        public.constitution_amendment_proposals%ROWTYPE;
  v_provision       public.constitution_provisions%ROWTYPE;
  v_amendment_id    BIGINT;
  v_provision_id    BIGINT;
  v_preceding_text  TEXT;
  v_title           TEXT;
BEGIN
  SELECT * INTO v_proposal
  FROM public.constitution_amendment_proposals
  WHERE id = p_proposal_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'proposal_not_found';
  END IF;

  IF v_proposal.status != 'pending_review' THEN
    RAISE EXCEPTION 'proposal_not_pending: %', v_proposal.status;
  END IF;

  IF v_proposal.affected_provision_number IS NOT NULL
     AND v_proposal.expected_preceding_text IS NOT NULL THEN
    -- Amending an existing provision: stale-text check (REQ-PROF-05(1), REQ-PROF-06)
    SELECT * INTO v_provision
    FROM public.constitution_provisions
    WHERE provision_number = v_proposal.affected_provision_number
    FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'provision_not_found: %', v_proposal.affected_provision_number;
    END IF;

    IF v_provision.current_text != v_proposal.expected_preceding_text THEN
      RAISE EXCEPTION 'stale_text: provision % has changed since proposal was drafted',
        v_proposal.affected_provision_number;
    END IF;

    v_preceding_text := v_provision.current_text;
    v_provision_id   := v_provision.id;
  ELSE
    -- New provision: no stale-text check (REQ-PROF-07)
    v_preceding_text := NULL;
    v_provision_id   := NULL;
  END IF;

  -- Step 2: insert amendment history record
  INSERT INTO public.constitution_amendments (
    provision_id, provision_number, problem_statement,
    factual_context, material_assumptions, constitutional_decision,
    preceding_text, resulting_text, promulgated_by, promulgated_at
  ) VALUES (
    v_provision_id,
    v_proposal.affected_provision_number,
    v_proposal.constitutional_matter,
    v_proposal.factual_context,
    v_proposal.material_assumptions,
    v_proposal.proposed_decision,
    v_preceding_text,
    v_proposal.proposed_resulting_text,
    p_operator_id,
    now()
  )
  RETURNING id INTO v_amendment_id;

  -- Step 3: update or create provision
  IF v_provision_id IS NOT NULL THEN
    UPDATE public.constitution_provisions SET
      current_text        = v_proposal.proposed_resulting_text,
      last_promulgated_by = p_operator_id,
      updated_at          = now()
    WHERE id = v_provision_id;
  ELSE
    v_title := COALESCE(v_proposal.proposed_provision_title, v_proposal.affected_provision_number);
    INSERT INTO public.constitution_provisions (
      provision_number, title, current_text, effective_at, last_promulgated_by, updated_at
    ) VALUES (
      v_proposal.affected_provision_number,
      v_title,
      v_proposal.proposed_resulting_text,
      now(),
      p_operator_id,
      now()
    );
  END IF;

  -- Steps 4, 5, 6: mark promulgated, link amendment, immediately live
  UPDATE public.constitution_amendment_proposals SET
    status               = 'promulgated',
    promulgated_at       = now(),
    reviewed_by          = p_operator_id,
    resulting_amendment_id = v_amendment_id,
    updated_at           = now()
  WHERE id = p_proposal_id;

  RETURN jsonb_build_object(
    'amendment_id',     v_amendment_id,
    'proposal_id',      p_proposal_id,
    'provision_number', v_proposal.affected_provision_number
  );
END;
$$;

-- These SECURITY DEFINER functions are Worker-internal. Supabase grants
-- EXECUTE to PUBLIC by default unless explicitly revoked; keep callers on the
-- authenticated Worker path where authority and lifecycle checks are applied.
ALTER FUNCTION public.promulgate_constitutional_amendment(BIGINT, UUID) SET search_path = '';
REVOKE ALL ON FUNCTION public.promulgate_constitutional_amendment(BIGINT, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.promulgate_constitutional_amendment(BIGINT, UUID) TO service_role;

-- ============================================================
-- RPC: record_authorization_incident
-- Atomically inserts or increments, per fingerprint aggregation rule.
-- ============================================================
CREATE OR REPLACE FUNCTION public.record_authorization_incident(
  p_acting_reviewer_id   UUID,
  p_acting_identity_text TEXT,
  p_attempted_action     TEXT,
  p_target_object        TEXT,
  p_denial_reason        TEXT,
  p_fingerprint          TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_existing  public.authorization_incidents%ROWTYPE;
  v_id        BIGINT;
  v_count     INTEGER;
BEGIN
  SELECT * INTO v_existing
  FROM public.authorization_incidents
  WHERE incident_fingerprint = p_fingerprint
    AND status IN ('open', 'reviewed')
  ORDER BY first_occurred_at DESC
  LIMIT 1
  FOR UPDATE;

  IF FOUND THEN
    UPDATE public.authorization_incidents SET
      last_occurred_at = now(),
      occurrence_count = occurrence_count + 1
    WHERE id = v_existing.id
    RETURNING id, occurrence_count INTO v_id, v_count;
  ELSE
    INSERT INTO public.authorization_incidents (
      acting_reviewer_id, acting_identity_text,
      attempted_action, target_object, denial_reason,
      incident_fingerprint, first_occurred_at, last_occurred_at,
      occurrence_count, status
    ) VALUES (
      p_acting_reviewer_id, p_acting_identity_text,
      p_attempted_action, p_target_object, p_denial_reason,
      p_fingerprint, now(), now(), 1, 'open'
    )
    RETURNING id, occurrence_count INTO v_id, v_count;
  END IF;

  RETURN jsonb_build_object('id', v_id, 'occurrence_count', v_count);
END;
$$;

ALTER FUNCTION public.record_authorization_incident(UUID, TEXT, TEXT, TEXT, TEXT, TEXT) SET search_path = '';
REVOKE ALL ON FUNCTION public.record_authorization_incident(UUID, TEXT, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_authorization_incident(UUID, TEXT, TEXT, TEXT, TEXT, TEXT) TO service_role;
