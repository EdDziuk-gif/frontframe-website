import { beforeEach, describe, expect, it, vi } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// Defect 3 (not to copy): the Operator's address was a hard-coded constant used
// at 8 sites, with 6 more literal copies. Decision 14 (2026-10-01): alerts,
// handoff emails, the DocuSeal countersigner and the contact line shown to
// visitors all follow the one active Operator row in `reviewers`. Decision 23:
// if the lookup fails, alerts go to the OPERATOR_FALLBACK_EMAIL Worker variable
// and visitor text names no address.
//
// The values below are fictional on purpose: every assertion proves the code
// follows the row it reads, not an address written in the source.

const sendResendEmailMock = vi.fn().mockResolvedValue({ success: true, status: "sent" });
const supabaseFetchMock = vi.fn();
const supabasePostMock = vi.fn().mockResolvedValue([{ id: 1 }]);
const supabasePatchByFieldMock = vi.fn().mockResolvedValue([]);

vi.mock("../src/shared/runtime.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, sendResendEmail: (...a) => sendResendEmailMock(...a) };
});
vi.mock("../src/shared/supabase.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    supabaseFetch: (...a) => supabaseFetchMock(...a),
    supabasePost: (...a) => supabasePostMock(...a),
    supabasePatchByField: (...a) => supabasePatchByFieldMock(...a),
  };
});

const {
  getOperator, getCountersignerEmail, sendOperatorEmail,
  operatorFollowUp, operatorReachLine, operatorNameOr,
} = await import("../src/shared/operator.js");
const { resolveGapMessage, constitutionalHoldMessage } = await import("../src/routes/chat.js");
const { sendSms } = await import("../src/shared/runtime.js");
const { sendProposal } = await import("../src/routes/proposals.js");
const { sendOutreachContract } = await import("../src/routes/outreach.js");

const ROW = { display_name: "Pat", email: "pat@operator.example" };
const FALLBACK = "fallback@operator.example";
const ENV = { OPERATOR_FALLBACK_EMAIL: FALLBACK };

beforeEach(() => {
  supabaseFetchMock.mockReset();
  supabasePostMock.mockReset().mockResolvedValue([{ id: 1 }]);
  supabasePatchByFieldMock.mockReset().mockResolvedValue([]);
  sendResendEmailMock.mockReset().mockResolvedValue({ success: true, status: "sent" });
  vi.unstubAllGlobals();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("getOperator", () => {
  it("reads the one active Operator row by baseline_role", async () => {
    supabaseFetchMock.mockResolvedValue([ROW]);
    const op = await getOperator(ENV);
    expect(op).toEqual({ resolved: true, email: ROW.email, displayName: "Pat", notifyEmail: ROW.email });
    const [, table, query] = supabaseFetchMock.mock.calls[0];
    expect(table).toBe("reviewers");
    expect(query).toContain("baseline_role=eq.frontframe_operator");
    expect(query).toContain("active=eq.true");
  });

  it("follows an Operator transfer: a different row gives a different address", async () => {
    supabaseFetchMock.mockResolvedValue([{ display_name: "Sam", email: "sam@operator.example" }]);
    const op = await getOperator(ENV);
    expect(op.email).toBe("sam@operator.example");
    expect(op.displayName).toBe("Sam");
  });

  it.each([
    ["the database call fails", () => Promise.reject(new Error("db down"))],
    ["there is no active Operator row", () => Promise.resolve([])],
    ["there is more than one active Operator row", () => Promise.resolve([ROW, { ...ROW, email: "other@operator.example" }])],
    ["the row has no usable email", () => Promise.resolve([{ display_name: "Pat", email: "" }])],
    ["the response is not a list", () => Promise.resolve(null)],
  ])("falls back to the Worker variable when %s, and names nothing to visitors", async (_label, impl) => {
    supabaseFetchMock.mockImplementation(impl);
    const op = await getOperator(ENV);
    expect(op).toEqual({ resolved: false, email: null, displayName: null, notifyEmail: FALLBACK });
  });

  it("has nowhere to send when the lookup fails and no fallback variable is set", async () => {
    supabaseFetchMock.mockRejectedValue(new Error("db down"));
    const op = await getOperator({});
    expect(op.notifyEmail).toBeNull();
  });

  it("treats a blank display name as no name", async () => {
    supabaseFetchMock.mockResolvedValue([{ display_name: "  ", email: ROW.email }]);
    const op = await getOperator(ENV);
    expect(op.resolved).toBe(true);
    expect(op.displayName).toBeNull();
    expect(operatorFollowUp(op)).toBe("We will follow up personally.");
  });
});

describe("sendOperatorEmail", () => {
  it("sends to the Operator row's address", async () => {
    supabaseFetchMock.mockResolvedValue([ROW]);
    await sendOperatorEmail(ENV, "Subject", "<p>x</p>");
    expect(sendResendEmailMock).toHaveBeenCalledWith(ENV, ROW.email, "Subject", "<p>x</p>");
  });

  it("sends to the fallback address when the lookup fails, so an outage cannot silence alerts", async () => {
    supabaseFetchMock.mockRejectedValue(new Error("db down"));
    await sendOperatorEmail(ENV, "Subject", "<p>x</p>");
    expect(sendResendEmailMock).toHaveBeenCalledWith(ENV, FALLBACK, "Subject", "<p>x</p>");
  });

  it("does not throw or send when there is no address at all", async () => {
    supabaseFetchMock.mockRejectedValue(new Error("db down"));
    const r = await sendOperatorEmail({}, "Subject", "<p>x</p>");
    expect(r).toEqual({ success: false, status: "no_operator_address" });
    expect(sendResendEmailMock).not.toHaveBeenCalled();
  });
});

describe("visitor-facing wording", () => {
  const RESOLVED = { resolved: true, email: ROW.email, displayName: "Pat", notifyEmail: ROW.email };
  const UNRESOLVED = { resolved: false, email: null, displayName: null, notifyEmail: FALLBACK };

  it("names the Operator and the row's address when the lookup worked", () => {
    expect(operatorFollowUp(RESOLVED, " once we have a solid answer"))
      .toBe("Pat will follow up personally once we have a solid answer.");
    expect(operatorReachLine(RESOLVED)).toBe(` You can also email ${ROW.email} directly.`);
    expect(resolveGapMessage(RESOLVED)).toContain("pass your question to Pat");
    expect(resolveGapMessage(RESOLVED)).toContain(ROW.email);
    expect(constitutionalHoldMessage(RESOLVED)).toContain("flagged it for Pat");
    expect(constitutionalHoldMessage(RESOLVED)).toContain(ROW.email);
  });

  it("names no person and no address when the lookup failed, never the fallback", () => {
    for (const text of [
      operatorFollowUp(UNRESOLVED), operatorReachLine(UNRESOLVED),
      resolveGapMessage(UNRESOLVED), constitutionalHoldMessage(UNRESOLVED),
    ]) {
      expect(text).not.toContain("@");
      expect(text).not.toContain(FALLBACK);
    }
    expect(resolveGapMessage(UNRESOLVED)).toContain("pass your question to our team");
    expect(constitutionalHoldMessage(UNRESOLVED)).toContain("the FrontFrame team");
    expect(operatorNameOr(UNRESOLVED, "us")).toBe("us");
  });

  it("asks a plain yes-or-no question, says how to answer, and promises nothing", () => {
    for (const op of [RESOLVED, UNRESOLVED]) {
      const gap = resolveGapMessage(op);
      expect(gap.startsWith("I don't have a reliable answer to that.\n\nWould you like me to pass your question to ")).toBe(true);
      expect(gap).toContain("Reply yes or no.");
      expect(gap).not.toMatch(/follow up|solid answer|will contact/i);
      const hold = constitutionalHoldMessage(op);
      expect(hold.startsWith("That touches how FrontFrame itself is governed")).toBe(true);
      expect(hold).toContain("Reply yes or no.");
      expect(hold).not.toMatch(/follow up|solid answer|will contact/i);
    }
    // The address goes on its own parenthesised line, only when it is known.
    expect(resolveGapMessage(RESOLVED).endsWith(`\n\n(You can also email ${ROW.email} directly.)`)).toBe(true);
    expect(resolveGapMessage(UNRESOLVED).endsWith("Reply yes or no.")).toBe(true);
  });
});

describe("DocuSeal countersigner", () => {
  it("is the Operator row's address", async () => {
    supabaseFetchMock.mockResolvedValue([ROW]);
    expect(await getCountersignerEmail(ENV)).toBe(ROW.email);
  });

  it("is never the fallback: a failed lookup stops the contract", async () => {
    supabaseFetchMock.mockRejectedValue(new Error("db down"));
    await expect(getCountersignerEmail(ENV)).rejects.toThrow("contract not sent");
  });

  it("outreach contract: submits with the row's address as FrontFrame's signer", async () => {
    supabaseFetchMock.mockImplementation((_e, table) =>
      Promise.resolve(table === "reviewers" ? [ROW]
        : [{ id: "i1", owner_name: "Jo", business_name: "Jo LLC", email: "jo@client.example", contract_status: null }]));
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, text: () => Promise.resolve("stop here") });
    vi.stubGlobal("fetch", fetchMock);
    await sendOutreachContract({}, { DOCUSEAL_API_KEY: "k" }, "i1", null, {}).catch(() => {});
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.submitters.find((s) => s.role === "FrontFrame").email).toBe(ROW.email);
  });

  it("outreach contract: a failed lookup sends nothing to DocuSeal", async () => {
    supabaseFetchMock.mockImplementation((_e, table) =>
      table === "reviewers" ? Promise.reject(new Error("db down"))
        : Promise.resolve([{ id: "i1", owner_name: "Jo", business_name: "Jo LLC", email: "jo@client.example", contract_status: null }]));
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(sendOutreachContract({}, { DOCUSEAL_API_KEY: "k", OPERATOR_FALLBACK_EMAIL: FALLBACK }, "i1", null, {}))
      .rejects.toThrow("contract not sent");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("proposal email contact line", () => {
  const proposal = { proposal_id: "p1", prospect_name: "Jo", prospect_email: "jo@client.example", status: "draft", version: 1 };
  const run = async (reviewersImpl) => {
    supabaseFetchMock.mockImplementation((_e, table) => (table === "reviewers" ? reviewersImpl() : Promise.resolve([proposal])));
    supabasePostMock.mockResolvedValue([{ token: "t", expires_at: "x" }]);
    const ctx = { waitUntil: (p) => p?.catch?.(() => {}) };
    await sendProposal({ json: () => Promise.resolve({}) }, ENV, ctx, "p1", null, {});
    return sendResendEmailMock.mock.calls[0][3];
  };

  it("shows the Operator row's name and address", async () => {
    const html = await run(() => Promise.resolve([ROW]));
    expect(html).toContain("send Pat your overall response");
    expect(html).toContain(`FrontFrame · ${ROW.email}`);
  });

  it("shows no name and no address when the lookup failed", async () => {
    const html = await run(() => Promise.reject(new Error("db down")));
    expect(html).toContain("send us your overall response");
    expect(html).not.toContain("@operator.example");
    expect(html).not.toContain("·");
  });
});

describe("SMS destination is configuration", () => {
  it("uses the Surge account and number from the environment", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ status: "sent" }) });
    vi.stubGlobal("fetch", fetchMock);
    await sendSms({ SURGE_API_KEY: "k", SURGE_ACCOUNT_ID: "acct_test", SURGE_TO_NUMBER: "+15555550100" }, "hi");
    expect(fetchMock.mock.calls[0][0]).toBe("https://api.surge.app/accounts/acct_test/messages");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).to).toBe("+15555550100");
  });

  it("does nothing, and says so, when the account or number is not configured", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await sendSms({ SURGE_API_KEY: "k" }, "hi")).toEqual({ success: false, status: "not_configured" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// A grep-style guard: the Operator's address and the SMS destination must not
// come back as literals anywhere in worker/src. The one allowed address is the
// email sender identity, RESEND_FROM, which is configuration tied to the
// verified sending domain.
describe("no hard-coded operator contact in worker/src", () => {
  const files = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith(".js")) files.push(p);
    }
  };
  walk(new URL("../src", import.meta.url).pathname);

  const offenders = (re) => files.flatMap((f) =>
    readFileSync(f, "utf8").split("\n")
      .map((line, i) => ({ f, i: i + 1, line }))
      .filter(({ line }) => re.test(line))
      .filter(({ line }) => !line.includes("RESEND_FROM"))
      .map(({ f: file, i, line }) => `${file.split("/src/")[1]}:${i}: ${line.trim().slice(0, 100)}`));

  it("has no literal operator email outside the sender identity", () => {
    expect(offenders(/ed@frontframe\.co/i)).toEqual([]);
  });
  it("has no ADMIN_EMAIL constant left", () => {
    expect(offenders(/\bADMIN_EMAIL\b/)).toEqual([]);
  });
  it("has no literal Surge account id or phone number", () => {
    expect(offenders(/acct_[0-9a-z]{10,}|\+1\d{10}/)).toEqual([]);
  });
});
