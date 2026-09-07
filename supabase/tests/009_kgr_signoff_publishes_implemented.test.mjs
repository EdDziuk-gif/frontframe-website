// Isolated-database test for migration 009 (KGR sign-off publishes an
// implemented Q&A row). Runs a real Postgres in-process via PGlite — it applies
// the ACTUAL migration files (005, 006, 007, then 009) on top of the pre-009
// qa_pairs constraints/defaults, so it exercises real SQL defaults, transaction
// rollback, and constraint behaviour that mocked Worker tests cannot.
//
// Run (one-off; PGlite is not a project dependency):
//   cd supabase/tests
//   npm init -y && npm i @electric-sql/pglite
//   node 009_kgr_signoff_publishes_implemented.test.mjs
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

// ── prereqs + real migrations 005-007 (pre-009 baseline) ────────────────────
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

const reviewer = await val(`INSERT INTO reviewers (role) VALUES ('frontframe_admin') RETURNING id`);

async function seedStatement(question, selText, pruneText) {
  const grr = await val(`INSERT INTO gap_resolution_requests DEFAULT VALUES RETURNING id`);
  const caseId = await val(`INSERT INTO kgr_cases (gap_resolution_request_id, status, created_by) VALUES ($1,'ready_for_decision',$2) RETURNING id`, [grr, reviewer]);
  const hSel = await val(`INSERT INTO kgr_hypotheses (kgr_case_id, description, status, created_by) VALUES ($1,'sel','accepted',$2) RETURNING id`, [caseId, reviewer]);
  const hPru = await val(`INSERT INTO kgr_hypotheses (kgr_case_id, description, status, created_by) VALUES ($1,'pru','accepted',$2) RETURNING id`, [caseId, reviewer]);
  const stmtId = await val(`SELECT save_kgr_resolution_statement($1,$2,$3,$4::jsonb)`, [
    caseId, question, reviewer,
    JSON.stringify([
      { hypothesis_id: hSel, presented_content: selText, score: 0.9, rationale: "r" },
      { hypothesis_id: hPru, presented_content: pruneText, score: 0.4, rationale: "r" },
    ]),
  ]);
  const cands = (await q(`SELECT id, presented_content FROM kgr_resolution_candidates WHERE kgr_resolution_statement_id=$1 ORDER BY id`, [stmtId])).rows;
  return { stmtId, sel: cands.find((c) => c.presented_content === selText), pru: cands.find((c) => c.presented_content === pruneText), hSel, hPru };
}

console.log("\n── PRE-009 baseline ─────────────────────────────────────────");
await expectErr("pre-009: direct INSERT source='kgr' is rejected",
  () => q(`INSERT INTO qa_pairs (question,answer,page,source,status) VALUES ('q','a','all','kgr','implemented')`), /qa_pairs_source_check/);
const S1 = await seedStatement("Pre-009 question?", "PRE selected answer", "PRE pruned answer");
await expectErr("pre-009: sign_off_kgr_resolution fails on the qa_pairs INSERT",
  () => q(`SELECT * FROM sign_off_kgr_resolution($1,$2,$3)`, [S1.stmtId, S1.sel.id, reviewer]), /qa_pairs_source_check/);
{
  const s = await one(`SELECT signed_off_at, qa_pair_id, selected_candidate_id FROM kgr_resolution_statements WHERE id=$1`, [S1.stmtId]);
  eq("pre-009 rollback: statement still unsigned", s.signed_off_at, null);
  eq("pre-009 rollback: no qa_pair_id", s.qa_pair_id, null);
  eq("pre-009 rollback: no selected_candidate_id", s.selected_candidate_id, null);
  eq("pre-009 rollback: both candidates remain", await num(`SELECT count(*) FROM kgr_resolution_candidates WHERE kgr_resolution_statement_id=$1`, [S1.stmtId]), 2);
  eq("pre-009 rollback: both hypotheses remain", await num(`SELECT count(*) FROM kgr_hypotheses WHERE id = ANY($1)`, [[S1.hSel, S1.hPru]]), 2);
  eq("pre-009 rollback: zero source='kgr' qa_pairs", await num(`SELECT count(*) FROM qa_pairs WHERE source='kgr'`), 0);
}

console.log("\n── APPLY 009 ────────────────────────────────────────────────");
await expectOk("009 applies cleanly (one transaction: constraint + function + grants)",
  () => exec(mig("009_kgr_signoff_publishes_implemented.sql")));

console.log("\n── POST-009 ─────────────────────────────────────────────────");
await expectOk("post-009: direct INSERT source='kgr' now succeeds",
  () => q(`INSERT INTO qa_pairs (question,answer,page,source,status) VALUES ('probe','a','all','kgr','implemented')`));
await q(`DELETE FROM qa_pairs WHERE question='probe'`);
await expectErr("post-009: other invalid source ('bogus') still rejected",
  () => q(`INSERT INTO qa_pairs (question,answer,page,source,status) VALUES ('q','a','all','bogus','implemented')`), /qa_pairs_source_check/);
{
  await q(`INSERT INTO qa_pairs (question,answer,page,source) VALUES ('plain-default','y','all','live')`);
  eq("post-009: general default unchanged (omit status -> under_review)", await val(`SELECT status FROM qa_pairs WHERE question='plain-default'`), "under_review");
  eq("post-009: that under_review row is excluded by the buildQaPairsQuery predicate",
    await num(`SELECT count(*) FROM qa_pairs WHERE status='implemented' AND (page='all' OR page='home') AND question='plain-default'`), 0);
}

const beforeCount = await num(`SELECT count(*) FROM qa_pairs`);
const S2 = await seedStatement("Does FrontFrame guarantee uptime?", "IMPL selected answer", "IMPL pruned answer");
const r = await one(`SELECT * FROM sign_off_kgr_resolution($1,$2,$3)`, [S2.stmtId, S2.sel.id, reviewer]);
eq("post-009 sign-off: returns the statement id", Number(r.statement_id), Number(S2.stmtId));
eq("post-009 sign-off: exactly one new qa_pairs row", (await num(`SELECT count(*) FROM qa_pairs`)) - beforeCount, 1);
{
  const p = await one(`SELECT question,answer,page,source,status FROM qa_pairs WHERE id=$1`, [r.qa_pair_id]);
  eq("post-009 published row: status", p.status, "implemented");
  eq("post-009 published row: source", p.source, "kgr");
  eq("post-009 published row: page", p.page, "all");
  eq("post-009 published row: question = problem_statement", p.question, "Does FrontFrame guarantee uptime?");
  eq("post-009 published row: answer = selected presented_content", p.answer, "IMPL selected answer");
  const s = await one(`SELECT qa_pair_id, signed_off_by, (signed_off_at IS NOT NULL) AS signed, selected_candidate_id FROM kgr_resolution_statements WHERE id=$1`, [S2.stmtId]);
  eq("post-009: statement.qa_pair_id back-link set", s.qa_pair_id, r.qa_pair_id);
  eq("post-009: statement.signed_off_by set", s.signed_off_by, reviewer);
  eq("post-009: statement.signed", s.signed, true);
  eq("post-009: statement.selected_candidate_id = selected", Number(s.selected_candidate_id), Number(S2.sel.id));
  eq("post-009 DEC0033: unselected candidate pruned", await num(`SELECT count(*) FROM kgr_resolution_candidates WHERE id=$1`, [S2.pru.id]), 0);
  eq("post-009 DEC0033: unselected hypothesis pruned", await num(`SELECT count(*) FROM kgr_hypotheses WHERE id=$1`, [S2.hPru]), 0);
  eq("post-009 DEC0033: selected candidate preserved", await num(`SELECT count(*) FROM kgr_resolution_candidates WHERE id=$1`, [S2.sel.id]), 1);
  eq("post-009 DEC0033: selected hypothesis preserved", await num(`SELECT count(*) FROM kgr_hypotheses WHERE id=$1`, [S2.hSel]), 1);
  eq("post-009: buildQaPairsQuery predicate returns the published answer",
    await num(`SELECT count(*) FROM qa_pairs WHERE status='implemented' AND (page='all' OR page='home') AND id=$1`, [r.qa_pair_id]), 1);
}

const cntBeforeDouble = await num(`SELECT count(*) FROM qa_pairs`);
await expectErr("post-009: second sign-off on the same statement raises 'already signed off'",
  () => q(`SELECT * FROM sign_off_kgr_resolution($1,$2,$3)`, [S2.stmtId, S2.sel.id, reviewer]), /already signed off/);
eq("post-009: late loser created no second qa_pairs row", await num(`SELECT count(*) FROM qa_pairs`), cntBeforeDouble);

const S3 = await seedStatement("Rollback probe?", "R3 selected", "R3 pruned");
await exec(`CREATE FUNCTION _boom() RETURNS trigger LANGUAGE plpgsql AS $b$
  BEGIN IF NEW.source='kgr' THEN RAISE EXCEPTION 'forced publication failure'; END IF; RETURN NEW; END $b$;
  CREATE TRIGGER _boom_t BEFORE INSERT ON qa_pairs FOR EACH ROW EXECUTE FUNCTION _boom();`);
await expectErr("post-009: forced publication failure aborts sign_off_kgr_resolution",
  () => q(`SELECT * FROM sign_off_kgr_resolution($1,$2,$3)`, [S3.stmtId, S3.sel.id, reviewer]), /forced publication failure/);
{
  const s = await one(`SELECT signed_off_at, qa_pair_id FROM kgr_resolution_statements WHERE id=$1`, [S3.stmtId]);
  eq("forced-failure rollback: statement unsigned", s.signed_off_at, null);
  eq("forced-failure rollback: no qa_pair_id", s.qa_pair_id, null);
  eq("forced-failure rollback: both candidates remain", await num(`SELECT count(*) FROM kgr_resolution_candidates WHERE kgr_resolution_statement_id=$1`, [S3.stmtId]), 2);
  eq("forced-failure rollback: both hypotheses remain", await num(`SELECT count(*) FROM kgr_hypotheses WHERE id = ANY($1)`, [[S3.hSel, S3.hPru]]), 2);
  eq("forced-failure rollback: no qa_pairs row for S3's question", await num(`SELECT count(*) FROM qa_pairs WHERE question='Rollback probe?'`), 0);
}
await exec(`DROP TRIGGER _boom_t ON qa_pairs; DROP FUNCTION _boom();`);

console.log("\n── privileges / security ────────────────────────────────────");
eq("function is SECURITY INVOKER (prosecdef = false)", await val(`SELECT prosecdef FROM pg_proc WHERE proname='sign_off_kgr_resolution'`), false);
eq("EXECUTE granted to service_role", await val(`SELECT has_function_privilege('service_role','sign_off_kgr_resolution(bigint,bigint,uuid)','EXECUTE')`), true);
eq("EXECUTE NOT granted to anon", await val(`SELECT has_function_privilege('anon','sign_off_kgr_resolution(bigint,bigint,uuid)','EXECUTE')`), false);
eq("EXECUTE NOT granted to authenticated", await val(`SELECT has_function_privilege('authenticated','sign_off_kgr_resolution(bigint,bigint,uuid)','EXECUTE')`), false);
eq("EXECUTE NOT granted to PUBLIC", await val(`SELECT has_function_privilege('public','sign_off_kgr_resolution(bigint,bigint,uuid)','EXECUTE')`), false);

console.log(`\n${"=".repeat(60)}\n  ${passed} passed, ${failed} failed\n${"=".repeat(60)}`);
process.exit(failed ? 1 : 0);
