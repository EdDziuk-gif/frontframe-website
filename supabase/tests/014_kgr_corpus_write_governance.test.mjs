// Isolated-database test for migration 014 — KGR corpus-write governance.
// Real Postgres in-process via PGlite. Reconstructs the pre-014 prerequisites,
// applies the real migration files 005 → 006 → 007 → 009 → 010 → 011 → 012 →
// 013 → 014, and exercises the lifecycle logic 014 adds:
//
//   * sign_off_kgr_resolution per target (new qa_pair, replacement qa_pair,
//     system_prompt existing page, system_prompt absent page), each with a
//     forced failure proving full rollback, plus the request-closure and
//     double-sign-off invariants;
//   * start_kgr_case            — atomic Start Case + its guards;
//   * set_kgr_case_target       — combination validation, target_revision bump,
//     contributed-solution deletion rules, the in_development gate;
//   * submit_kgr_solution       — the 11-arg signature, the target_revision
//     race, NULL rejection, and the old 10-arg signature being gone;
//   * open_companion_case       — linked question / route / request / case.
//
// The PRIVILEGE layer (migration 015: kgr_corpus_writer BYPASSRLS role, the
// service_role corpus-DML revoke, SECURITY DEFINER + OWNER) is NOT exercised
// here — PGlite implements neither role attributes nor ALTER FUNCTION … OWNER.
// Those checks run on real PostgreSQL in staging (plan Part 5).
//
// Run (one-off; PGlite is not a project dependency):
//   cd supabase/tests
//   npm init -y && npm i @electric-sql/pglite
//   node 014_kgr_corpus_write_governance.test.mjs
//
// Exit code 0 = all assertions pass.

import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const M = resolve(HERE, "..", "migrations");
const mig = (n) => readFileSync(`${M}/${n}`, "utf8");

let passed = 0, failed = 0;
const ok = (n) => { passed++; console.log(`  PASS  ${n}`); };
const bad = (n, d) => { failed++; console.log(`  FAIL  ${n}\n        ${d}`); };
async function expectErr(n, fn, rx) {
  try { await fn(); bad(n, "expected an error, none thrown"); }
  catch (e) { (rx && !rx.test(e.message)) ? bad(n, `error !~ ${rx}: ${e.message}`) : ok(n); }
}
async function expectOk(n, fn) { try { await fn(); ok(n); } catch (e) { bad(n, e.message); } }
const eq = (n, a, b) => (a === b ? ok(n) : bad(n, `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`));

const db = await PGlite.create();
const exec = (s) => db.exec(s);
const q = (s, p) => db.query(s, p);
const one = async (s, p) => (await db.query(s, p)).rows[0];
const val = async (s, p) => Object.values((await one(s, p)) ?? {})[0];
const num = async (s, p) => Number(await val(s, p));

// ── prerequisites ─────────────────────────────────────────────────────────────
await exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;`);
await exec(`
  CREATE TABLE reviewers (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), role text);

  CREATE TABLE questions (
    id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    source        text NOT NULL DEFAULT 'visitor',
    question_text text NOT NULL,
    asked_by      uuid,
    CONSTRAINT questions_source_check CHECK (source = ANY (ARRAY['visitor'::text,'assistant'::text,'staff'::text]))
  );

  CREATE TABLE routes (
    id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    score_id       bigint,
    route_decision text NOT NULL,
    route_reason   text NOT NULL,
    CONSTRAINT routes_route_reason_check CHECK (route_reason = ANY (ARRAY[
      'scr'::text,'knowledge_gap'::text,'constitutional_candidate'::text,
      'kb_grounded'::text,'source_conflict'::text,'scr_fallthrough'::text]))
  );

  CREATE TABLE candidate_answers (
    id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    answer_text text NOT NULL
  );

  CREATE TABLE gap_resolution_requests (
    id                     bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    route_id               bigint REFERENCES routes(id),
    question_id            bigint REFERENCES questions(id),
    candidate_answer_id    bigint REFERENCES candidate_answers(id),
    authorized_at          timestamptz,
    authorized_by          uuid REFERENCES reviewers(id),
    requested_at           timestamptz NOT NULL DEFAULT now()
  );

  CREATE TABLE qa_pairs (
    id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    question text, answer text,
    created_at timestamptz DEFAULT now() NOT NULL,
    source text DEFAULT 'seed'::text NOT NULL,
    page text DEFAULT 'all'::text NOT NULL,
    status text DEFAULT 'under_review'::text NOT NULL,
    CONSTRAINT qa_pairs_source_check CHECK ((source = ANY (ARRAY['seed'::text,'testing'::text,'live'::text]))),
    CONSTRAINT qa_pairs_status_check CHECK ((status = ANY (ARRAY['under_review'::text,'redundant'::text,'implemented'::text])))
  );

  CREATE TABLE system_prompt (
    page       text PRIMARY KEY,
    content    text NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
  );
`);

await exec(mig("005_kgr_cases.sql"));
await exec(mig("006_kgr_resolution_statements.sql"));
await exec(mig("007_kgr_sign_off.sql"));
await exec(mig("009_kgr_signoff_publishes_implemented.sql"));
await exec(mig("010_kgr_candidate_solutions.sql"));
await exec(mig("011_kgr_contribution_and_snapshot_functions.sql"));
await exec(mig("012_kgr_solution_pruning_on_signoff.sql"));
await exec(mig("013_kgr_development_write_guards.sql"));

console.log("\n── migration 014 applies (schema + functions, PGlite-safe) ──");
await expectOk("014 applies in one transaction", () => exec(mig("014_kgr_corpus_write_governance.sql")));

// Columns / constraints from 014
eq("014: gap_resolution_requests.resolved_at added",
  await num(`SELECT count(*) FROM information_schema.columns WHERE table_name='gap_resolution_requests' AND column_name='resolved_at'`), 1);
eq("014: kgr_cases.resolution_target added with default qa_pair",
  await val(`SELECT column_default FROM information_schema.columns WHERE table_name='kgr_cases' AND column_name='resolution_target'`), "'qa_pair'::text");
eq("014: kgr_cases.target_revision default 0",
  await val(`SELECT column_default FROM information_schema.columns WHERE table_name='kgr_cases' AND column_name='target_revision'`), "0");
eq("014: qa_pairs.superseded_by_qa_pair_id added",
  await num(`SELECT count(*) FROM information_schema.columns WHERE table_name='qa_pairs' AND column_name='superseded_by_qa_pair_id'`), 1);
eq("014: system_prompt_history table created",
  await num(`SELECT count(*) FROM information_schema.tables WHERE table_name='system_prompt_history'`), 1);
eq("014: routes.route_reason CHECK now allows kgr_companion",
  await num(`SELECT count(*) FROM pg_constraint WHERE conname='routes_route_reason_check' AND pg_get_constraintdef(oid) ILIKE '%kgr_companion%'`), 1);
eq("014: questions.source CHECK widened to allow kgr_companion",
  await num(`SELECT count(*) FROM pg_constraint WHERE conname='questions_source_check' AND pg_get_constraintdef(oid) ILIKE '%kgr_companion%'`), 1);

// exactly one submit_kgr_solution, and it is the 11-arg shape
eq("014: exactly one submit_kgr_solution signature remains",
  await num(`SELECT count(*) FROM pg_proc WHERE proname='submit_kgr_solution'`), 1);
eq("014: submit_kgr_solution now takes 11 arguments",
  await num(`SELECT pronargs FROM pg_proc WHERE proname='submit_kgr_solution'`), 11);

// ── fixtures / helpers ───────────────────────────────────────────────────────
const admin  = await val(`INSERT INTO reviewers (role) VALUES ('frontframe_admin') RETURNING id`);
const staffA = await val(`INSERT INTO reviewers (role) VALUES ('frontframe_staff') RETURNING id`);

async function mkRequest(text = "Visitor question?") {
  const qid = await val(`INSERT INTO questions (source, question_text) VALUES ('visitor',$1) RETURNING id`, [text]);
  const rid = await val(`INSERT INTO routes (route_decision, route_reason) VALUES ('resolve_gap','knowledge_gap') RETURNING id`);
  return val(`INSERT INTO gap_resolution_requests (route_id, question_id) VALUES ($1,$2) RETURNING id`, [rid, qid]);
}
const startCase = (reqId, by = staffA) => one(`SELECT * FROM start_kgr_case($1,$2)`, [reqId, by]);
const setTarget = (caseId, target, o = {}) =>
  one(`SELECT * FROM set_kgr_case_target($1,$2,$3,$4,$5)`,
    [caseId, target, o.supersedes ?? null, o.spPage ?? null, o.by ?? staffA]);
const mkHyp = (caseId, status = "accepted", desc = "h") =>
  val(`INSERT INTO kgr_hypotheses (kgr_case_id, description, status, created_by) VALUES ($1,$2,$3,$4) RETURNING id`,
    [caseId, desc, status, admin]);
const submit = (caseId, hypId, content, rev, o = {}) =>
  one(`SELECT * FROM submit_kgr_solution($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [
    caseId, hypId, content, o.origin ?? "human", o.by ?? staffA,
    o.score ?? 0.8, o.rationale ?? "ok", o.hash ?? "prov-v1",
    o.problem ?? "P?", o.key ?? `k-${Math.random().toString(36).slice(2)}`, rev,
  ]);
// Drive a case with one accepted hypothesis + one contributed solution to a
// prepared, unsigned resolution statement. Returns { stmtId, candId }.
async function toStatement(caseId, content = "the answer", problem = "P?") {
  const h = await mkHyp(caseId, "accepted");
  const rev = await num(`SELECT target_revision FROM kgr_cases WHERE id=$1`, [caseId]);
  await submit(caseId, h, content, rev, { problem, key: `k-${caseId}` });
  await q(`SELECT ready_kgr_case($1)`, [caseId]);
  const stmtId = await val(`SELECT prepare_kgr_resolution_statement($1,$2)`, [caseId, admin]);
  const candId = await val(`SELECT id FROM kgr_resolution_candidates WHERE kgr_resolution_statement_id=$1`, [stmtId]);
  return { stmtId, candId };
}

// ── start_kgr_case ──────────────────────────────────────────────────────────
console.log("\n── start_kgr_case ─────────────────────────────────────────");
{
  const r = await mkRequest("How does X work?");
  const c = await startCase(r);
  eq("start: case created in_development", c.status, "in_development");
  eq("start: default resolution_target = qa_pair", c.resolution_target, "qa_pair");
  eq("start: default target_revision = 0", Number(c.target_revision), 0);
  eq("start: stamped authorized_by on the request", await val(`SELECT authorized_by FROM gap_resolution_requests WHERE id=$1`, [r]), staffA);
  eq("start: stamped authorized_at on the request", (await val(`SELECT authorized_at IS NOT NULL FROM gap_resolution_requests WHERE id=$1`, [r])), true);

  await expectErr("start: a second case on the same request is rejected",
    () => startCase(r), /already exists/i);

  const preAuth = await mkRequest();
  const ts = "2020-01-01T00:00:00Z";
  await q(`UPDATE gap_resolution_requests SET authorized_at=$2, authorized_by=$3 WHERE id=$1`, [preAuth, ts, admin]);
  await startCase(preAuth);
  eq("start: an existing authorized_by is preserved, not overwritten",
    await val(`SELECT authorized_by FROM gap_resolution_requests WHERE id=$1`, [preAuth]), admin);

  const resolved = await mkRequest();
  await q(`UPDATE gap_resolution_requests SET resolved_at=now() WHERE id=$1`, [resolved]);
  await expectErr("start: a resolved request is rejected", () => startCase(resolved), /already resolved/i);

  const escalated = await mkRequest();
  await q(`UPDATE gap_resolution_requests SET escalated_at=now() WHERE id=$1`, [escalated]);
  await expectErr("start: an escalated request is rejected", () => startCase(escalated), /escalated/i);

  await expectErr("start: a missing request is rejected", () => startCase(999999), /not found/i);
}

// ── set_kgr_case_target ─────────────────────────────────────────────────────
console.log("\n── set_kgr_case_target ────────────────────────────────────");
{
  const c = (await startCase(await mkRequest())).id;

  // combination validation
  await expectErr("target: system_prompt without a page is rejected",
    () => setTarget(c, "system_prompt"), /valid system_prompt page is required/i);
  await expectErr("target: qa_pair with a page is rejected",
    () => setTarget(c, "qa_pair", { spPage: "home" }), /page is not valid for a qa_pair/i);
  await expectErr("target: system_prompt with a supersedes id is rejected",
    () => setTarget(c, "system_prompt", { spPage: "home", supersedes: "00000000-0000-0000-0000-000000000000" }),
    /supersedes_qa_pair_id is not valid/i);
  await expectErr("target: an unknown resolution_target is rejected",
    () => one(`SELECT * FROM set_kgr_case_target($1,'process',null,null,$2)`, [c, staffA]), /must be qa_pair or system_prompt/i);

  // revision bumps on every call
  eq("target: revision starts at 0", await num(`SELECT target_revision FROM kgr_cases WHERE id=$1`, [c]), 0);
  await setTarget(c, "qa_pair");
  eq("target: an identical-values refresh still bumps the revision",
    await num(`SELECT target_revision FROM kgr_cases WHERE id=$1`, [c]), 1);

  // seed a solution, then prove the deletion rules
  const h = await mkHyp(c, "accepted");
  await submit(c, h, "sol-a", 1, { problem: "P?", key: "d-1" });
  eq("target: one contributed solution before a kind change",
    await num(`SELECT count(*) FROM kgr_candidate_solutions WHERE kgr_case_id=$1`, [c]), 1);

  await setTarget(c, "system_prompt", { spPage: "home" });
  eq("target: switching qa_pair → system_prompt discards contributed solutions",
    await num(`SELECT count(*) FROM kgr_candidate_solutions WHERE kgr_case_id=$1`, [c]), 0);
  eq("target: revision bumped again", await num(`SELECT target_revision FROM kgr_cases WHERE id=$1`, [c]), 2);
  eq("target: system_prompt page recorded", await val(`SELECT target_system_prompt_page FROM kgr_cases WHERE id=$1`, [c]), "home");
  eq("target: absent page frozen as not-present",
    await val(`SELECT target_sp_expected_present FROM kgr_cases WHERE id=$1`, [c]), false);

  // a prompt-page change also clears solutions
  const h2 = await mkHyp(c, "accepted");
  await submit(c, h2, "sol-b", 2, { problem: "P?", key: "d-2" });
  await setTarget(c, "system_prompt", { spPage: "yours" });
  eq("target: a system_prompt page change also discards contributed solutions",
    await num(`SELECT count(*) FROM kgr_candidate_solutions WHERE kgr_case_id=$1`, [c]), 0);

  // new ⇄ replacement is NOT a kind change → solutions kept
  const c2 = (await startCase(await mkRequest())).id;
  const seed = await val(`INSERT INTO qa_pairs (question, answer, page, source, status) VALUES ('q','a','home','seed','implemented') RETURNING id`);
  const h3 = await mkHyp(c2, "accepted");
  await submit(c2, h3, "sol-c", 0, { problem: "P?", key: "d-3" });
  await setTarget(c2, "qa_pair", { supersedes: seed });
  eq("target: new → replacement keeps contributed solutions",
    await num(`SELECT count(*) FROM kgr_candidate_solutions WHERE kgr_case_id=$1`, [c2]), 1);
  eq("target: supersedes id recorded", await val(`SELECT supersedes_qa_pair_id FROM kgr_cases WHERE id=$1`, [c2]), seed);

  await expectErr("target: supersedes must be a current implemented row",
    () => setTarget(c2, "qa_pair", { supersedes: "00000000-0000-0000-0000-000000000000" }), /not a current implemented row/i);

  // in_development gate
  await q(`UPDATE kgr_cases SET status='ready_for_decision' WHERE id=$1`, [c2]);
  await expectErr("target: a case not in_development rejects a target change",
    () => setTarget(c2, "qa_pair"), /in_development/i);
}

// ── submit_kgr_solution — target_revision binding ──────────────────────────
console.log("\n── submit_kgr_solution — target_revision binding ──────────");
{
  const c = (await startCase(await mkRequest())).id;
  const h = await mkHyp(c, "accepted");
  const rev = await num(`SELECT target_revision FROM kgr_cases WHERE id=$1`, [c]);

  await expectOk("submit: a matching target_revision inserts normally",
    () => submit(c, h, "matching", rev, { problem: "P?", key: "r-ok" }));
  await expectErr("submit: NULL target_revision is rejected explicitly",
    () => submit(c, h, "null-rev", null, { problem: "P?", key: "r-null" }), /p_target_revision is required/i);

  // interleave: capture revision → set_kgr_case_target (bump) → submit → rejected
  const captured = await num(`SELECT target_revision FROM kgr_cases WHERE id=$1`, [c]);
  await setTarget(c, "qa_pair");   // bump
  await expectErr("submit: a stale captured revision is rejected, inserts nothing",
    () => submit(c, h, "stale", captured, { problem: "P?", key: "r-stale" }), /resolution target changed/i);
  eq("submit: the stale contribution left no row",
    await num(`SELECT count(*) FROM kgr_candidate_solutions WHERE kgr_case_id=$1 AND proposed_content='stale'`, [c]), 0);

  await expectErr("submit: the old 10-argument signature no longer exists",
    () => q(`SELECT * FROM submit_kgr_solution($1,$2,'x','human',$3,0.5,'r','h','P?','k-old')`, [c, h, staffA]),
    /does not exist|function/i);
}

// ── sign_off_kgr_resolution — new qa_pair ──────────────────────────────────
console.log("\n── sign_off — new qa_pair target ─────────────────────────");
{
  const r = await mkRequest("New answer please?");
  const c = (await startCase(r)).id;
  const { stmtId, candId } = await toStatement(c, "brand new answer", "New answer please?");
  const so = await one(`SELECT * FROM sign_off_kgr_resolution($1,$2,$3)`, [stmtId, candId, admin]);
  const p = await one(`SELECT question,answer,page,source,status FROM qa_pairs WHERE id=$1`, [so.qa_pair_id]);
  eq("new: published page 'all'", p.page, "all");
  eq("new: published source 'kgr'", p.source, "kgr");
  eq("new: published status 'implemented'", p.status, "implemented");
  eq("new: answer is the winning content", p.answer, "brand new answer");
  eq("new: statement qa_pair_id back-linked", await val(`SELECT qa_pair_id FROM kgr_resolution_statements WHERE id=$1`, [stmtId]), so.qa_pair_id);
  eq("new: originating request resolved", await val(`SELECT resolved_at IS NOT NULL FROM gap_resolution_requests WHERE id=$1`, [r]), true);
  eq("new: request resolved_qa_pair_id set", await val(`SELECT resolved_qa_pair_id FROM gap_resolution_requests WHERE id=$1`, [r]), so.qa_pair_id);
  eq("new: request resolved_kgr_case_id set", await num(`SELECT resolved_kgr_case_id FROM gap_resolution_requests WHERE id=$1`, [r]), Number(c));

  await expectErr("new: a second sign-off of the statement raises 'already signed off'",
    () => q(`SELECT * FROM sign_off_kgr_resolution($1,$2,$3)`, [stmtId, candId, admin]), /already signed off/i);
}

// ── sign_off_kgr_resolution — replacement qa_pair ─────────────────────────
console.log("\n── sign_off — replacement qa_pair target ─────────────────");
{
  const pred = await val(`INSERT INTO qa_pairs (question, answer, page, source, status) VALUES ('old q','old a','yours','seed','implemented') RETURNING id`);

  // Two cases bind to the same implemented predecessor while it is still current.
  const r = await mkRequest("Replace it?");
  const c = (await startCase(r)).id;
  await setTarget(c, "qa_pair", { supersedes: pred });
  const { stmtId, candId } = await toStatement(c, "replacement answer", "Replace it?");

  const r2 = await mkRequest("Replace the retired one?");
  const c2 = (await startCase(r2)).id;
  await setTarget(c2, "qa_pair", { supersedes: pred });
  const s2 = await toStatement(c2, "second replacement", "Replace the retired one?");

  // First sign-off retires the predecessor.
  const so = await one(`SELECT * FROM sign_off_kgr_resolution($1,$2,$3)`, [stmtId, candId, admin]);
  const np = await one(`SELECT page,status FROM qa_pairs WHERE id=$1`, [so.qa_pair_id]);
  eq("replace: new answer inherits the predecessor's page", np.page, "yours");
  eq("replace: new answer is implemented", np.status, "implemented");
  const op = await one(`SELECT status, superseded_by_qa_pair_id, superseded_at FROM qa_pairs WHERE id=$1`, [pred]);
  eq("replace: predecessor status → redundant", op.status, "redundant");
  eq("replace: predecessor superseded_by points at the new row", op.superseded_by_qa_pair_id, so.qa_pair_id);
  eq("replace: predecessor superseded_at stamped", op.superseded_at !== null, true);

  // Second sign-off, now against an already-retired predecessor, must raise and roll back.
  await expectErr("replace: signing off against an already-retired predecessor raises",
    () => q(`SELECT * FROM sign_off_kgr_resolution($1,$2,$3)`, [s2.stmtId, s2.candId, admin]),
    /no longer a current implemented row|new KGR case is required/i);
  eq("replace: the failed second sign-off left the statement unsigned",
    await val(`SELECT signed_off_at FROM kgr_resolution_statements WHERE id=$1`, [s2.stmtId]), null);
  eq("replace: the failed second sign-off published nothing",
    await num(`SELECT count(*) FROM qa_pairs WHERE answer='second replacement'`), 0);
}

// ── sign_off_kgr_resolution — system_prompt (existing page) ───────────────
console.log("\n── sign_off — system_prompt target, existing page ───────");
{
  await q(`INSERT INTO system_prompt (page, content) VALUES ('discovery','ORIGINAL discovery prompt')`);
  const r = await mkRequest("Revise the discovery prompt?");
  const c = (await startCase(r)).id;
  await setTarget(c, "system_prompt", { spPage: "discovery" });
  eq("sysprompt: predecessor present captured", await val(`SELECT target_sp_expected_present FROM kgr_cases WHERE id=$1`, [c]), true);
  eq("sysprompt: predecessor md5 captured",
    await val(`SELECT target_sp_expected_md5 = md5('ORIGINAL discovery prompt') FROM kgr_cases WHERE id=$1`, [c]), true);

  const { stmtId, candId } = await toStatement(c, "REVISED discovery prompt", "Revise the discovery prompt?");
  const so = await one(`SELECT * FROM sign_off_kgr_resolution($1,$2,$3)`, [stmtId, candId, admin]);
  eq("sysprompt: qa_pair_id is NULL for a prompt outcome", so.qa_pair_id, null);
  eq("sysprompt: page upserted to the adopted content",
    await val(`SELECT content FROM system_prompt WHERE page='discovery'`), "REVISED discovery prompt");
  const h = await one(`SELECT prior_content, prior_content_present, adopted_content, kgr_resolution_statement_id FROM system_prompt_history WHERE page='discovery'`);
  eq("sysprompt: history prior_content recorded", h.prior_content, "ORIGINAL discovery prompt");
  eq("sysprompt: history prior_content_present = true", h.prior_content_present, true);
  eq("sysprompt: history adopted_content recorded", h.adopted_content, "REVISED discovery prompt");
  eq("sysprompt: history links the statement", Number(h.kgr_resolution_statement_id), Number(stmtId));
  eq("sysprompt: statement carries system_prompt_history_id",
    await val(`SELECT system_prompt_history_id IS NOT NULL FROM kgr_resolution_statements WHERE id=$1`, [stmtId]), true);
  eq("sysprompt: request stamped with resolved_system_prompt_page",
    await val(`SELECT resolved_system_prompt_page FROM gap_resolution_requests WHERE id=$1`, [r]), "discovery");
  eq("sysprompt: request resolved_qa_pair_id stays NULL",
    await val(`SELECT resolved_qa_pair_id FROM gap_resolution_requests WHERE id=$1`, [r]), null);

  // a second case targeting the same page, screened against the OLD content, must raise on hash mismatch
  const r2 = await mkRequest("Revise discovery again?");
  const c2 = (await startCase(r2)).id;
  await q(`UPDATE kgr_cases SET resolution_target='system_prompt', target_system_prompt_page='discovery',
             target_sp_expected_present=true, target_sp_expected_md5=md5('ORIGINAL discovery prompt') WHERE id=$1`, [c2]);
  const s2 = await toStatement(c2, "third discovery prompt", "Revise discovery again?");
  await expectErr("sysprompt: a stale predecessor hash raises, no silent overwrite",
    () => q(`SELECT * FROM sign_off_kgr_resolution($1,$2,$3)`, [s2.stmtId, s2.candId, admin]),
    /modified after this case reached Ready|new KGR case is required/i);
  eq("sysprompt: the page content was not overwritten by the failed sign-off",
    await val(`SELECT content FROM system_prompt WHERE page='discovery'`), "REVISED discovery prompt");
}

// ── sign_off_kgr_resolution — system_prompt (absent page) ─────────────────
console.log("\n── sign_off — system_prompt target, absent page ────────");
{
  const r = await mkRequest("Create the proposal prompt?");
  const c = (await startCase(r)).id;
  await setTarget(c, "system_prompt", { spPage: "proposal" });
  eq("sysprompt(absent): predecessor captured as not-present",
    await val(`SELECT target_sp_expected_present FROM kgr_cases WHERE id=$1`, [c]), false);
  const { stmtId, candId } = await toStatement(c, "NEW proposal prompt", "Create the proposal prompt?");
  await one(`SELECT * FROM sign_off_kgr_resolution($1,$2,$3)`, [stmtId, candId, admin]);
  eq("sysprompt(absent): page created with the adopted content",
    await val(`SELECT content FROM system_prompt WHERE page='proposal'`), "NEW proposal prompt");
  const h = await one(`SELECT prior_content, prior_content_present FROM system_prompt_history WHERE page='proposal'`);
  eq("sysprompt(absent): history prior_content is NULL", h.prior_content, null);
  eq("sysprompt(absent): history prior_content_present = false", h.prior_content_present, false);
}

// ── sign_off_kgr_resolution — forced-failure rollback ────────────────────
console.log("\n── sign_off — forced-failure rollback ──────────────────");
{
  const r = await mkRequest("Rollback probe?");
  const c = (await startCase(r)).id;
  const { stmtId, candId } = await toStatement(c, "rollback answer", "Rollback probe?");
  await exec(`CREATE FUNCTION _boom() RETURNS trigger LANGUAGE plpgsql AS $b$
    BEGIN IF NEW.source='kgr' THEN RAISE EXCEPTION 'forced publication failure'; END IF; RETURN NEW; END $b$;
    CREATE TRIGGER _boom_t BEFORE INSERT ON qa_pairs FOR EACH ROW EXECUTE FUNCTION _boom();`);
  await expectErr("rollback: a forced publication failure aborts sign-off",
    () => q(`SELECT * FROM sign_off_kgr_resolution($1,$2,$3)`, [stmtId, candId, admin]), /forced publication failure/i);
  eq("rollback: statement still unsigned", await val(`SELECT signed_off_at FROM kgr_resolution_statements WHERE id=$1`, [stmtId]), null);
  eq("rollback: originating request NOT resolved", await val(`SELECT resolved_at FROM gap_resolution_requests WHERE id=$1`, [r]), null);
  eq("rollback: no qa_pair published", await num(`SELECT count(*) FROM qa_pairs WHERE answer='rollback answer'`), 0);
  await exec(`DROP TRIGGER _boom_t ON qa_pairs; DROP FUNCTION _boom();`);
}

// ── sign_off_kgr_resolution — request-closure invariant ─────────────────
console.log("\n── sign_off — request-closure invariant ────────────────");
{
  const r = await mkRequest("Close exactly one?");
  const c = (await startCase(r)).id;
  const { stmtId, candId } = await toStatement(c, "closure answer", "Close exactly one?");
  // Pre-resolve the request so the closure UPDATE matches zero rows.
  await q(`UPDATE gap_resolution_requests SET resolved_at=now() WHERE id=$1`, [r]);
  await expectErr("closure: a zero-row request closure aborts the whole sign-off",
    () => q(`SELECT * FROM sign_off_kgr_resolution($1,$2,$3)`, [stmtId, candId, admin]),
    /did not close exactly one originating request/i);
  eq("closure: statement left unsigned by the aborted sign-off",
    await val(`SELECT signed_off_at FROM kgr_resolution_statements WHERE id=$1`, [stmtId]), null);
}

// ── open_companion_case ────────────────────────────────────────────────────
console.log("\n── open_companion_case ────────────────────────────────────");
{
  const parentReq = await mkRequest("Parent problem?");
  const parentCase = (await startCase(parentReq)).id;
  const row = await one(`SELECT * FROM open_companion_case($1,$2,$3)`, [parentReq, "The companion sub-problem", staffA]);
  eq("companion: a new request is returned", typeof row.request_id !== "undefined", true);
  eq("companion: a new case is returned", typeof row.case_id !== "undefined", true);
  eq("companion: request links companion_of_request_id to the parent",
    await num(`SELECT companion_of_request_id FROM gap_resolution_requests WHERE id=$1`, [row.request_id]), Number(parentReq));
  eq("companion: request is authorized by the reviewer",
    await val(`SELECT authorized_by FROM gap_resolution_requests WHERE id=$1`, [row.request_id]), staffA);
  eq("companion: the companion question carries source=kgr_companion",
    await val(`SELECT q.source FROM questions q JOIN gap_resolution_requests g ON g.question_id=q.id WHERE g.id=$1`, [row.request_id]), "kgr_companion");
  eq("companion: the companion route carries route_reason=kgr_companion",
    await val(`SELECT r.route_reason FROM routes r JOIN gap_resolution_requests g ON g.route_id=r.id WHERE g.id=$1`, [row.request_id]), "kgr_companion");
  eq("companion: the companion case is in_development at the default target",
    await val(`SELECT resolution_target FROM kgr_cases WHERE id=$1`, [row.case_id]), "qa_pair");
  eq("companion: the companion case target_revision = 0",
    await num(`SELECT target_revision FROM kgr_cases WHERE id=$1`, [row.case_id]), 0);

  await expectErr("companion: a blank problem statement is rejected",
    () => q(`SELECT * FROM open_companion_case($1,'   ',$2)`, [parentReq, staffA]), /problem statement is required/i);

  const lonelyReq = await mkRequest("No case here");
  await expectErr("companion: a parent request with no case is rejected",
    () => q(`SELECT * FROM open_companion_case($1,'x',$2)`, [lonelyReq, staffA]), /has no case/i);
  void parentCase;
}

// ── summary ─────────────────────────────────────────────────────────────────
console.log(`\n${failed === 0 ? "OK" : "FAILED"} — ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
