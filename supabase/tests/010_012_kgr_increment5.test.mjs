// Isolated-database test for KGR Increment 5 (migrations 010, 011, 012).
// Real Postgres in-process via PGlite. Reconstructs the pre-Increment-5
// prerequisites and constraints, applies the actual migration files
// 005 -> 006 -> 007 -> 009 -> 010 -> 011 -> 012, and exercises contribution,
// withdrawal, guarded readiness, server-derived snapshot, and N:1-safe
// sign-off pruning - including the migration-009 sign-off invariants under the
// migration-012 function.
//
// Run (one-off; PGlite is not a project dependency):
//   cd supabase/tests
//   npm init -y && npm i @electric-sql/pglite
//   node 010_012_kgr_increment5.test.mjs
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
const rows = async (s, p) => (await db.query(s, p)).rows;
const one = async (s, p) => (await db.query(s, p)).rows[0];
const val = async (s, p) => Object.values((await one(s, p)) ?? {})[0];
const num = async (s, p) => Number(await val(s, p));

// ── prerequisites + real migrations 005-009 ────────────────────────────────
await exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;`);
await exec(`
  CREATE TABLE reviewers (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), role text);
  CREATE TABLE gap_resolution_requests (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY);
  CREATE TABLE qa_pairs (
    id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    question text, answer text,
    created_at timestamptz DEFAULT now() NOT NULL,
    source text DEFAULT 'seed'::text NOT NULL,
    page text DEFAULT 'all'::text NOT NULL,
    status text DEFAULT 'under_review'::text NOT NULL,
    CONSTRAINT qa_pairs_source_check CHECK ((source = ANY (ARRAY['seed'::text,'testing'::text,'live'::text]))),
    CONSTRAINT qa_pairs_status_check CHECK ((status = ANY (ARRAY['under_review'::text,'redundant'::text,'implemented'::text])))
  );`);
await exec(mig("005_kgr_cases.sql"));
await exec(mig("006_kgr_resolution_statements.sql"));
await exec(mig("007_kgr_sign_off.sql"));
await exec(mig("009_kgr_signoff_publishes_implemented.sql"));

const admin = await val(`INSERT INTO reviewers (role) VALUES ('frontframe_admin') RETURNING id`);
const staffA = await val(`INSERT INTO reviewers (role) VALUES ('frontframe_staff') RETURNING id`);
const staffB = await val(`INSERT INTO reviewers (role) VALUES ('frontframe_staff') RETURNING id`);

// ── legacy snapshot row (simulates statement #1 / Case #1, pre-Increment-5) ──
// Built with save_kgr_resolution_statement BEFORE 010-012, so it carries no
// provenance columns - the migration-012 sign-off must tolerate that.
const legacyCase = await val(`INSERT INTO gap_resolution_requests DEFAULT VALUES RETURNING id`);
const legacyCaseId = await val(`INSERT INTO kgr_cases (gap_resolution_request_id, status, created_by) VALUES ($1,'ready_for_decision',$2) RETURNING id`, [legacyCase, admin]);
const legacyHyp = await val(`INSERT INTO kgr_hypotheses (kgr_case_id, description, status, created_by) VALUES ($1,'legacy','accepted',$2) RETURNING id`, [legacyCaseId, admin]);
const legacyStmtId = await val(`SELECT save_kgr_resolution_statement($1,$2,$3,$4::jsonb)`, [
  legacyCaseId, "Legacy problem?", admin,
  JSON.stringify([{ hypothesis_id: legacyHyp, presented_content: "Legacy answer", score: 0.72, rationale: "r" }]),
]);

console.log("\n── APPLY 010 / 011 / 012 / 013 ─────────────────────────────");
await expectOk("010 applies (schema)", () => exec(mig("010_kgr_candidate_solutions.sql")));
await expectOk("011 applies (functions)", () => exec(mig("011_kgr_contribution_and_snapshot_functions.sql")));
await expectOk("012 applies (sign-off replacement)", () => exec(mig("012_kgr_solution_pruning_on_signoff.sql")));
await expectOk("013 applies (development write guards)", () => exec(mig("013_kgr_development_write_guards.sql")));

eq("010: kgr_candidate_solutions has RLS enabled",
  await val(`SELECT relrowsecurity FROM pg_class WHERE relname='kgr_candidate_solutions'`), true);
eq("010: one-per-hypothesis UNIQUE dropped from kgr_resolution_candidates",
  await num(`SELECT count(*) FROM pg_constraint WHERE conname='kgr_resolution_candidates_kgr_hypothesis_id_key'`), 0);
await expectErr("011: save_kgr_resolution_statement is dropped",
  () => q(`SELECT save_kgr_resolution_statement(1,'x',$1,'[]'::jsonb)`, [admin]), /does not exist|function/i);

// ── helpers over the new functions ─────────────────────────────────────────
async function mkCase() {
  const grr = await val(`INSERT INTO gap_resolution_requests DEFAULT VALUES RETURNING id`);
  return val(`INSERT INTO kgr_cases (gap_resolution_request_id, status, created_by) VALUES ($1,'in_development',$2) RETURNING id`, [grr, admin]);
}
const mkHyp = (caseId, status = "accepted", desc = "h") =>
  val(`INSERT INTO kgr_hypotheses (kgr_case_id, description, status, created_by) VALUES ($1,$2,$3,$4) RETURNING id`, [caseId, desc, status, admin]);
const submit = (caseId, hypId, content, o = {}) =>
  one(`SELECT * FROM submit_kgr_solution($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [
    caseId, hypId, content, o.origin ?? "human", o.by ?? staffA,
    o.score ?? 0.8, o.rationale ?? "ok", o.hash ?? "prov-v1",
    o.problem ?? "P?", o.key ?? `k-${Math.random().toString(36).slice(2)}`,
  ]);

console.log("\n── submit_kgr_solution ─────────────────────────────────────");
const c1 = await mkCase();
const c1h1 = await mkHyp(c1);
const s1 = await submit(c1, c1h1, "Answer one", { by: staffA, score: 0.9, key: "c1-a", problem: "How does X work?" });
eq("submit: status active", s1.status, "active");
eq("submit: proposed_content stored verbatim", s1.proposed_content, "Answer one");
eq("submit: score stored", Number(s1.score), 0.9);
eq("submit: origin stored", s1.origin, "human");
eq("submit: first contribution sets case contribution_problem_snapshot",
  await val(`SELECT contribution_problem_snapshot FROM kgr_cases WHERE id=$1`, [c1]), "How does X work?");

await expectOk("submit: N:1 - a second reviewer, same hypothesis, different answer",
  () => submit(c1, c1h1, "Answer two", { by: staffB, key: "c1-b", problem: "How does X work?" }));
eq("submit: both solutions persisted for the one hypothesis",
  await num(`SELECT count(*) FROM kgr_candidate_solutions WHERE kgr_hypothesis_id=$1 AND status='active'`, [c1h1]), 2);

await expectOk("submit: score 0 is accepted",
  () => submit(c1, c1h1, "Zero-scored", { by: staffA, score: 0, key: "c1-zero", problem: "How does X work?" }));
eq("submit: the zero-scored row is still active",
  await num(`SELECT count(*) FROM kgr_candidate_solutions WHERE proposed_content='Zero-scored' AND status='active'`), 1);

await expectErr("submit: forbidden origin rejected",
  () => submit(c1, c1h1, "x", { origin: "management_decision", key: "c1-bado", problem: "How does X work?" }), /origin must be/);
await expectErr("submit: blank content rejected",
  () => submit(c1, c1h1, "   ", { key: "c1-blank", problem: "How does X work?" }), /proposed_content is required/);
await expectErr("submit: blank submission_key rejected",
  () => submit(c1, c1h1, "x", { key: "  ", problem: "How does X work?" }), /submission_key is required/);
await expectErr("submit: score above 1 rejected",
  () => submit(c1, c1h1, "x", { score: 1.5, key: "c1-hi", problem: "How does X work?" }), /score must be between/);

console.log("\n── retry identity ─────────────────────────────────────────");
const beforeRetry = await num(`SELECT count(*) FROM kgr_candidate_solutions WHERE kgr_case_id=$1`, [c1]);
const retry = await submit(c1, c1h1, "Answer one", { by: staffA, score: 0.9, key: "c1-a", problem: "How does X work?" });
eq("retry: same key + same content returns the existing row", retry.id, s1.id);
eq("retry: no new row inserted", await num(`SELECT count(*) FROM kgr_candidate_solutions WHERE kgr_case_id=$1`, [c1]), beforeRetry);
await expectErr("retry: same key + different content is a conflict",
  () => submit(c1, c1h1, "DIFFERENT", { by: staffA, key: "c1-a", problem: "How does X work?" }), /already used for different content/);

console.log("\n── problem snapshot ───────────────────────────────────────");
await expectErr("submit: later contribution with a different problem snapshot is rejected",
  () => submit(c1, c1h1, "x", { key: "c1-mismatch", problem: "A DIFFERENT QUESTION" }), /problem snapshot mismatch/);
await expectOk("submit: later contribution with the matching snapshot succeeds",
  () => submit(c1, c1h1, "matches", { key: "c1-match", problem: "How does X work?" }));

console.log("\n── hypothesis / case gating ───────────────────────────────");
const c2 = await mkCase();
const c2untested = await mkHyp(c2, "untested");
const c2falsified = await mkHyp(c2, "falsified");
const c2accepted = await mkHyp(c2, "accepted");
await expectErr("submit: against an untested hypothesis is rejected",
  () => submit(c2, c2untested, "x", { key: "c2-u", problem: "Q2?" }), /only be contributed against an accepted/);
await expectErr("submit: against a falsified hypothesis is rejected",
  () => submit(c2, c2falsified, "x", { key: "c2-f", problem: "Q2?" }), /only be contributed against an accepted/);
await expectErr("submit: hypothesis from another case is rejected",
  () => submit(c2, c1h1, "x", { key: "c2-x", problem: "Q2?" }), /is not on case/);

console.log("\n── withdraw_kgr_solution ──────────────────────────────────");
const w1 = await submit(c1, c1h1, "To be withdrawn by author", { by: staffA, key: "c1-w1", problem: "How does X work?" });
const w2 = await submit(c1, c1h1, "To be withdrawn by admin", { by: staffB, key: "c1-w2", problem: "How does X work?" });
await expectErr("withdraw: blank reason rejected",
  () => q(`SELECT withdraw_kgr_solution($1,$2,$3,'frontframe_staff','  ')`, [c1, w1.id, staffA]), /reason is required/);
await expectErr("withdraw: a non-author, non-admin reviewer is rejected",
  () => q(`SELECT withdraw_kgr_solution($1,$2,$3,'frontframe_staff','nope')`, [c1, w1.id, staffB]), /only the contributor or Management/);
await expectOk("withdraw: the author withdraws their own",
  () => q(`SELECT withdraw_kgr_solution($1,$2,$3,'frontframe_staff','superseded')`, [c1, w1.id, staffA]));
{
  const r = await one(`SELECT status, withdrawn_by, withdrawn_reason, withdrawn_at FROM kgr_candidate_solutions WHERE id=$1`, [w1.id]);
  eq("withdraw: status withdrawn", r.status, "withdrawn");
  eq("withdraw: withdrawn_by set", r.withdrawn_by, staffA);
  eq("withdraw: withdrawn_reason set", r.withdrawn_reason, "superseded");
  eq("withdraw: withdrawn_at set", r.withdrawn_at != null, true);
}
await expectOk("withdraw: Management withdraws another reviewer's solution",
  () => q(`SELECT withdraw_kgr_solution($1,$2,$3,'frontframe_admin','not viable')`, [c1, w2.id, admin]));
await expectOk("withdraw: repeat on an already-withdrawn row is idempotent",
  () => q(`SELECT withdraw_kgr_solution($1,$2,$3,'frontframe_admin','again')`, [c1, w2.id, admin]));
eq("withdraw: idempotent repeat did not overwrite the reason",
  await val(`SELECT withdrawn_reason FROM kgr_candidate_solutions WHERE id=$1`, [w2.id]), "not viable");

console.log("\n── ready_kgr_case (coverage rule) ─────────────────────────");
const rc = await mkCase();
const rcH1 = await mkHyp(rc, "accepted", "covered");
const rcH2 = await mkHyp(rc, "accepted", "uncovered");
await submit(rc, rcH1, "sol for h1", { key: "rc-1", problem: "RC?" });
await expectErr("ready: blocked while an accepted hypothesis has no active solution",
  () => q(`SELECT ready_kgr_case($1)`, [rc]), /no active contributed solution/);
const rcS2 = await submit(rc, rcH2, "sol for h2", { key: "rc-2", problem: "RC?" });
await q(`SELECT withdraw_kgr_solution($1,$2,$3,'frontframe_staff','pull it')`, [rc, rcS2.id, staffA]);
await expectErr("ready: still blocked when the only solution for a hypothesis is withdrawn",
  () => q(`SELECT ready_kgr_case($1)`, [rc]), /no active contributed solution/);
const rcS3 = await submit(rc, rcH2, "replacement for h2", { key: "rc-3", problem: "RC?" });
await expectOk("ready: succeeds once every accepted hypothesis has an active solution",
  () => q(`SELECT ready_kgr_case($1)`, [rc]));
eq("ready: case moved to ready_for_decision",
  await val(`SELECT status FROM kgr_cases WHERE id=$1`, [rc]), "ready_for_decision");
await expectErr("ready: contributions are closed afterward",
  () => submit(rc, rcH1, "late", { key: "rc-late", problem: "RC?" }), /contributions are closed/);
await expectErr("ready: withdrawal of an ACTIVE solution is closed afterward",
  () => q(`SELECT withdraw_kgr_solution($1,$2,$3,'frontframe_admin','too late')`, [rc, rcS3.id, admin]), /can no longer be withdrawn/);
await expectOk("ready: repeat withdrawal of an already-withdrawn row stays idempotent even after ready",
  () => q(`SELECT withdraw_kgr_solution($1,$2,$3,'frontframe_admin','again')`, [rc, rcS2.id, admin]));

const rcUntested = await mkCase();
await mkHyp(rcUntested, "untested");
await expectErr("ready: blocked by an untested hypothesis",
  () => q(`SELECT ready_kgr_case($1)`, [rcUntested]), /untested hypothesis/);
const rcNoAcc = await mkCase();
await mkHyp(rcNoAcc, "falsified");
await expectErr("ready: blocked when no hypothesis is accepted",
  () => q(`SELECT ready_kgr_case($1)`, [rcNoAcc]), /no accepted hypothesis/);

console.log("\n── prepare_kgr_resolution_statement (freeze-and-snapshot) ──");
// Fresh case: h1 has two active solutions + one withdrawn; h2 has one.
const pc = await mkCase();
const pcH1 = await mkHyp(pc, "accepted", "p-h1");
const pcH2 = await mkHyp(pc, "accepted", "p-h2");
const pA = await submit(pc, pcH1, "P h1 sol A", { by: staffA, score: 0.7, key: "p-a", problem: "PREP?" });
await submit(pc, pcH1, "P h1 sol B", { by: staffB, score: 0.4, key: "p-b", problem: "PREP?" });
const pWd = await submit(pc, pcH1, "P h1 withdrawn", { by: staffA, key: "p-wd", problem: "PREP?" });
await q(`SELECT withdraw_kgr_solution($1,$2,$3,'frontframe_staff','drop')`, [pc, pWd.id, staffA]);
await submit(pc, pcH2, "P h2 sol", { by: staffA, score: 0.6, key: "p-c", problem: "PREP?" });
await q(`SELECT ready_kgr_case($1)`, [pc]);

const pStmtId = await val(`SELECT prepare_kgr_resolution_statement($1,$2)`, [pc, admin]);
eq("prepare: statement problem_statement = contribution snapshot",
  await val(`SELECT problem_statement FROM kgr_resolution_statements WHERE id=$1`, [pStmtId]), "PREP?");
eq("prepare: snapshots exactly the 3 ACTIVE solutions (withdrawn excluded)",
  await num(`SELECT count(*) FROM kgr_resolution_candidates WHERE kgr_resolution_statement_id=$1`, [pStmtId]), 3);
eq("prepare: two candidates share the one hypothesis (N:1 in the snapshot)",
  await num(`SELECT count(*) FROM kgr_resolution_candidates WHERE kgr_resolution_statement_id=$1 AND kgr_hypothesis_id=$2`, [pStmtId, pcH1]), 2);
{
  const cand = await one(`SELECT presented_content, score, rationale, submitted_by, origin, constitutional_provisions_hash, problem_snapshot, origin_solution_id FROM kgr_resolution_candidates WHERE kgr_resolution_statement_id=$1 AND origin_solution_id=$2`, [pStmtId, pA.id]);
  eq("prepare: content copied verbatim", cand.presented_content, "P h1 sol A");
  eq("prepare: score copied", Number(cand.score), 0.7);
  eq("prepare: submitted_by provenance copied", cand.submitted_by, staffA);
  eq("prepare: origin provenance copied", cand.origin, "human");
  eq("prepare: provisions hash copied", cand.constitutional_provisions_hash, "prov-v1");
  eq("prepare: problem snapshot copied", cand.problem_snapshot, "PREP?");
}
const pStmtId2 = await val(`SELECT prepare_kgr_resolution_statement($1,$2)`, [pc, admin]);
eq("prepare: idempotent repeat returns the same statement id", Number(pStmtId2), Number(pStmtId));
eq("prepare: idempotent repeat did not duplicate candidates",
  await num(`SELECT count(*) FROM kgr_resolution_candidates WHERE kgr_resolution_statement_id=$1`, [pStmtId]), 3);

console.log("\n── sign_off (migration 012): N:1-safe pruning ─────────────");
// pcH1 has 2 snapshot candidates (A @0.7, B @0.4); pcH2 has 1 (C @0.6).
// Sign off candidate A (on pcH1). Losing: B (shares pcH1 -> hypothesis kept)
// and C (on pcH2 -> hypothesis pruned).
const candA = await one(`SELECT id FROM kgr_resolution_candidates WHERE kgr_resolution_statement_id=$1 AND presented_content='P h1 sol A'`, [pStmtId]);
const beforeQa = await num(`SELECT count(*) FROM qa_pairs`);
const so = await one(`SELECT * FROM sign_off_kgr_resolution($1,$2,$3)`, [pStmtId, candA.id, admin]);
eq("sign-off: returns the statement id", Number(so.statement_id), Number(pStmtId));
eq("sign-off: exactly one new qa_pairs row", (await num(`SELECT count(*) FROM qa_pairs`)) - beforeQa, 1);
{
  const p = await one(`SELECT question,answer,page,source,status FROM qa_pairs WHERE id=$1`, [so.qa_pair_id]);
  eq("sign-off: published status", p.status, "implemented");
  eq("sign-off: published source", p.source, "kgr");
  eq("sign-off: published page", p.page, "all");
  eq("sign-off: published question = problem_statement", p.question, "PREP?");
  eq("sign-off: published answer = winning content", p.answer, "P h1 sol A");
}
eq("sign-off: only the winning snapshot candidate survives",
  await num(`SELECT count(*) FROM kgr_resolution_candidates WHERE kgr_resolution_statement_id=$1`, [pStmtId]), 1);
eq("sign-off: the surviving candidate is the winner",
  await val(`SELECT presented_content FROM kgr_resolution_candidates WHERE kgr_resolution_statement_id=$1`, [pStmtId]), "P h1 sol A");
eq("sign-off: winner's shared hypothesis is preserved",
  await num(`SELECT count(*) FROM kgr_hypotheses WHERE id=$1`, [pcH1]), 1);
eq("sign-off: the losing non-shared hypothesis is pruned",
  await num(`SELECT count(*) FROM kgr_hypotheses WHERE id=$1`, [pcH2]), 0);
eq("sign-off: every contributed solution row for the case is deleted",
  await num(`SELECT count(*) FROM kgr_candidate_solutions WHERE kgr_case_id=$1`, [pc]), 0);
eq("sign-off: winner snapshot origin_solution_id nulled by ON DELETE SET NULL",
  await val(`SELECT origin_solution_id FROM kgr_resolution_candidates WHERE kgr_resolution_statement_id=$1`, [pStmtId]), null);
eq("sign-off: statement back-links set",
  await num(`SELECT count(*) FROM kgr_resolution_statements WHERE id=$1 AND signed_off_by=$2 AND qa_pair_id IS NOT NULL AND selected_candidate_id=$3`, [pStmtId, admin, candA.id]), 1);

console.log("\n── sign_off invariants carried from migration 009 ─────────");
await expectErr("sign-off: second sign-off raises 'already signed off'",
  () => q(`SELECT * FROM sign_off_kgr_resolution($1,$2,$3)`, [pStmtId, candA.id, admin]), /already signed off/);
eq("sign-off: late loser created no second qa_pairs row",
  await num(`SELECT count(*) FROM qa_pairs`), beforeQa + 1);

// candidate-ownership check
const other = await mkCase();
const otherH = await mkHyp(other, "accepted");
await submit(other, otherH, "x", { key: "o-1", problem: "O?" });
await q(`SELECT ready_kgr_case($1)`, [other]);
const otherStmt = await val(`SELECT prepare_kgr_resolution_statement($1,$2)`, [other, admin]);
await expectErr("sign-off: candidate not belonging to the statement is rejected",
  () => q(`SELECT * FROM sign_off_kgr_resolution($1,$2,$3)`, [otherStmt, candA.id, admin]), /does not belong to statement/);

// falsified hypotheses + research notes preserved
const fc = await mkCase();
await q(`UPDATE kgr_cases SET research_notes='keep me' WHERE id=$1`, [fc]);
const fcKept = await mkHyp(fc, "accepted", "fc-win");
const fcFals = await mkHyp(fc, "falsified", "fc-falsified");
await submit(fc, fcKept, "fc answer", { key: "fc-1", problem: "FC?" });
await q(`SELECT ready_kgr_case($1)`, [fc]);
const fcStmt = await val(`SELECT prepare_kgr_resolution_statement($1,$2)`, [fc, admin]);
const fcCand = await one(`SELECT id FROM kgr_resolution_candidates WHERE kgr_resolution_statement_id=$1`, [fcStmt]);
await q(`SELECT * FROM sign_off_kgr_resolution($1,$2,$3)`, [fcStmt, fcCand.id, admin]);
eq("sign-off: falsified hypothesis preserved", await num(`SELECT count(*) FROM kgr_hypotheses WHERE id=$1`, [fcFals]), 1);
eq("sign-off: research_notes untouched", await val(`SELECT research_notes FROM kgr_cases WHERE id=$1`, [fc]), "keep me");

console.log("\n── sign_off: forced-failure rollback ──────────────────────");
const gc = await mkCase();
const gcH = await mkHyp(gc, "accepted");
await submit(gc, gcH, "rollback probe", { key: "g-1", problem: "G?" });
await q(`SELECT ready_kgr_case($1)`, [gc]);
const gcStmt = await val(`SELECT prepare_kgr_resolution_statement($1,$2)`, [gc, admin]);
const gcCand = await one(`SELECT id FROM kgr_resolution_candidates WHERE kgr_resolution_statement_id=$1`, [gcStmt]);
await exec(`CREATE FUNCTION _boom() RETURNS trigger LANGUAGE plpgsql AS $b$
  BEGIN IF NEW.source='kgr' THEN RAISE EXCEPTION 'forced publication failure'; END IF; RETURN NEW; END $b$;
  CREATE TRIGGER _boom_t BEFORE INSERT ON qa_pairs FOR EACH ROW EXECUTE FUNCTION _boom();`);
await expectErr("sign-off: forced publication failure aborts the function",
  () => q(`SELECT * FROM sign_off_kgr_resolution($1,$2,$3)`, [gcStmt, gcCand.id, admin]), /forced publication failure/);
eq("rollback: statement still unsigned", await val(`SELECT signed_off_at FROM kgr_resolution_statements WHERE id=$1`, [gcStmt]), null);
eq("rollback: snapshot candidate intact", await num(`SELECT count(*) FROM kgr_resolution_candidates WHERE kgr_resolution_statement_id=$1`, [gcStmt]), 1);
eq("rollback: contributed solution intact", await num(`SELECT count(*) FROM kgr_candidate_solutions WHERE kgr_case_id=$1`, [gc]), 1);
eq("rollback: hypothesis intact", await num(`SELECT count(*) FROM kgr_hypotheses WHERE id=$1`, [gcH]), 1);
await exec(`DROP TRIGGER _boom_t ON qa_pairs; DROP FUNCTION _boom();`);

console.log("\n── legacy pre-Increment-5 statement still signs off ───────");
const legacyCand = await one(`SELECT id FROM kgr_resolution_candidates WHERE kgr_resolution_statement_id=$1`, [legacyStmtId]);
eq("legacy: its candidate has NULL provenance", await val(`SELECT submitted_by FROM kgr_resolution_candidates WHERE id=$1`, [legacyCand.id]), null);
await expectOk("legacy: migration-012 sign-off tolerates NULL provenance",
  () => q(`SELECT * FROM sign_off_kgr_resolution($1,$2,$3)`, [legacyStmtId, legacyCand.id, admin]));
eq("legacy: published a kgr/implemented row",
  await num(`SELECT count(*) FROM qa_pairs WHERE question='Legacy problem?' AND source='kgr' AND status='implemented'`), 1);

console.log("\n── migration 013: guarded development writes ───────────────");
{
  const gc = await mkCase();
  const gh = await mkHyp(gc, "untested", "g-hyp");
  await expectErr("013 add_kgr_hypothesis: blank description rejected",
    () => q(`SELECT add_kgr_hypothesis($1,'  ',$2)`, [gc, admin]), /description is required/);
  await expectOk("013 add_kgr_hypothesis: adds an untested hypothesis",
    () => q(`SELECT add_kgr_hypothesis($1,'new hyp',$2)`, [gc, admin]));
  await expectErr("013 dispose_kgr_hypothesis: bad status rejected",
    () => q(`SELECT dispose_kgr_hypothesis($1,$2,'maybe','n')`, [gc, gh]), /accepted or falsified/);
  await expectErr("013 dispose_kgr_hypothesis: blank test_notes rejected",
    () => q(`SELECT dispose_kgr_hypothesis($1,$2,'accepted','  ')`, [gc, gh]), /test_notes is required/);
  await expectErr("013 dispose_kgr_hypothesis: hypothesis from another case rejected",
    () => q(`SELECT dispose_kgr_hypothesis($1,$2,'accepted','n')`, [gc, c1h1]), /not on case/);
  await expectOk("013 dispose_kgr_hypothesis: untested -> accepted with notes",
    () => q(`SELECT dispose_kgr_hypothesis($1,$2,'accepted','confirmed')`, [gc, gh]));
  await expectErr("013 dispose_kgr_hypothesis: re-disposition rejected",
    () => q(`SELECT dispose_kgr_hypothesis($1,$2,'falsified','n')`, [gc, gh]), /already accepted and cannot be changed/);
  await expectOk("013 update_kgr_research_notes: writes on an in_development case",
    () => q(`SELECT update_kgr_research_notes($1,'notes here')`, [gc]));
  await expectOk("013 escalate_kgr_case: escalates an in_development case",
    () => q(`SELECT escalate_kgr_case($1,'needs operator review')`, [gc]));
  eq("013 escalate_kgr_case: status is escalated",
    await val(`SELECT status FROM kgr_cases WHERE id=$1`, [gc]), "escalated");
  await expectErr("013 update_kgr_research_notes: frozen case (escalated) rejected",
    () => q(`SELECT update_kgr_research_notes($1,'too late')`, [gc]), /is escalated and is frozen/);
  await expectErr("013 add_kgr_hypothesis: frozen case rejected",
    () => q(`SELECT add_kgr_hypothesis($1,'late hyp',$2)`, [gc, admin]), /cannot take new hypotheses/);
  await expectErr("013 dispose_kgr_hypothesis: frozen case rejected",
    () => q(`SELECT dispose_kgr_hypothesis($1,$2,'falsified','n')`, [gc, gh]), /cannot be disposed/);
  await expectErr("013 escalate_kgr_case: non-in_development case rejected",
    () => q(`SELECT escalate_kgr_case($1,'again')`, [gc]), /already escalated/);
}

console.log("\n── serialization: FOR UPDATE on the case row in every write fn ──");
// PGlite is single-connection, so true two-session lock contention cannot be
// exercised here. What is checked: (a) every KGR write function statically
// takes SELECT ... FROM kgr_cases ... FOR UPDATE, and (b) the outcomes that
// serialization produces - a post-freeze write is refused, and concurrent
// "first" contributions converge on one problem snapshot.
for (const fn of [
  "submit_kgr_solution", "withdraw_kgr_solution", "ready_kgr_case",
  "prepare_kgr_resolution_statement", "sign_off_kgr_resolution",
  "update_kgr_research_notes", "add_kgr_hypothesis", "dispose_kgr_hypothesis", "escalate_kgr_case",
]) {
  const def = await val(`SELECT pg_get_functiondef(oid) FROM pg_proc WHERE proname=$1`, [fn]);
  const locksCase = /kgr_cases[\s\S]*?for update/i.test(def) || /for update[\s\S]*?kgr_cases/i.test(def);
  eq(`${fn}: locks the kgr_cases row (FOR UPDATE)`, locksCase, true);
}

{
  // A submission that finished its checks is still refused once the case has
  // been frozen - it cannot slip into a ready case.
  const rcCase = await mkCase();
  const rcH = await mkHyp(rcCase, "accepted");
  await submit(rcCase, rcH, "the one solution", { key: "race-1", problem: "RACE?" });
  await q(`SELECT ready_kgr_case($1)`, [rcCase]);
  const cnt = await num(`SELECT count(*) FROM kgr_candidate_solutions WHERE kgr_case_id=$1`, [rcCase]);
  await expectErr("race: an evaluated submission is refused after readiness",
    () => submit(rcCase, rcH, "slips in late", { key: "race-2", problem: "RACE?" }), /contributions are closed/);
  eq("race: no row was inserted by the late submission",
    await num(`SELECT count(*) FROM kgr_candidate_solutions WHERE kgr_case_id=$1`, [rcCase]), cnt);
}

{
  // Two "first" contributions that each derived a different problem text: the
  // first sets the case snapshot, the second is rejected until it re-scores
  // against the stored snapshot. Both rows then carry the one snapshot.
  const snapCase = await mkCase();
  const snapH = await mkHyp(snapCase, "accepted");
  await submit(snapCase, snapH, "contribution one", { by: staffA, key: "s-1", problem: "P-first" });
  await expectErr("snapshot convergence: a second first-contribution with a different problem is rejected",
    () => submit(snapCase, snapH, "contribution two", { by: staffB, key: "s-2", problem: "P-second" }), /problem snapshot mismatch/);
  await expectOk("snapshot convergence: it succeeds once re-scored against the stored snapshot",
    () => submit(snapCase, snapH, "contribution two", { by: staffB, key: "s-2b", problem: "P-first" }));
  eq("snapshot convergence: every solution on the case carries the one snapshot",
    await num(`SELECT count(*) FROM kgr_candidate_solutions WHERE kgr_case_id=$1 AND problem_snapshot <> 'P-first'`, [snapCase]), 0);
  eq("snapshot convergence: the case snapshot is the first-writer's text",
    await val(`SELECT contribution_problem_snapshot FROM kgr_cases WHERE id=$1`, [snapCase]), "P-first");
}

console.log("\n── privileges / security ──────────────────────────────────");
for (const fn of ["submit_kgr_solution", "withdraw_kgr_solution", "ready_kgr_case", "prepare_kgr_resolution_statement", "sign_off_kgr_resolution",
  "update_kgr_research_notes", "add_kgr_hypothesis", "dispose_kgr_hypothesis", "escalate_kgr_case"]) {
  eq(`${fn}: SECURITY INVOKER (prosecdef=false)`,
    await val(`SELECT prosecdef FROM pg_proc WHERE proname=$1`, [fn]), false);
  eq(`${fn}: EXECUTE granted to service_role`,
    await val(`SELECT bool_or(has_function_privilege('service_role', oid, 'EXECUTE')) FROM pg_proc WHERE proname=$1`, [fn]), true);
  eq(`${fn}: EXECUTE NOT granted to anon`,
    await val(`SELECT bool_or(has_function_privilege('anon', oid, 'EXECUTE')) FROM pg_proc WHERE proname=$1`, [fn]), false);
  eq(`${fn}: EXECUTE NOT granted to authenticated`,
    await val(`SELECT bool_or(has_function_privilege('authenticated', oid, 'EXECUTE')) FROM pg_proc WHERE proname=$1`, [fn]), false);
}

console.log(`\n${"=".repeat(60)}\n  ${passed} passed, ${failed} failed\n${"=".repeat(60)}`);
process.exit(failed ? 1 : 0);
