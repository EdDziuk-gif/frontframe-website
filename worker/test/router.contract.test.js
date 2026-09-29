import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ADMIN_EXTRA_PROTECTED_PATHS, isProtectedRoute } from "../src/middleware/auth.js";
import { TIER_DEFAULT_PANELS, panelForRoutePath } from "../src/middleware/panels.js";
import { ROUTES } from "../src/index.js";
import { matchRoute } from "../src/router.js";
import { handlers } from "../src/routes/registry.js";

const manifest = ROUTES.map(({ method, path }) => `${method} ${path}`).join("\n");

describe("Worker route contract", () => {
  it("preserves the approved route manifest and declaration order", () => {
    // 128 routes. Previous: 127. +1 for GET /admin/me (2026-09-28), which
    // returns the caller's own reviewer row and granted panel keys so a panel
    // can boot without reading the full reviewer list. 127 was itself 136 minus
    // the 9 routes of the retired Solutions tab; the KGR solutions routes
    // (/admin/kgr-cases/:id/solutions) are a different feature and remain.
    expect(ROUTES).toHaveLength(128);
    expect(createHash("sha256").update(manifest).digest("hex"))
      .toBe("91fb96f5f0fd3ccd291c43668d8be13f232fc121210ebe8b21bef2d61d275c76");
  });

  it("keeps literal sub-routes ahead of their parameterized fallbacks", () => {
    const position = (method, path) =>
      ROUTES.findIndex((route) => route.method === method && route.path === path);

    expect(position("GET", "/admin/lead-alerts/:id/session"))
      .toBeLessThan(position("PATCH", "/admin/lead-alerts/:id"));
    expect(position("POST", "/admin/subscriptions/:id/send"))
      .toBeLessThan(position("PATCH", "/admin/subscriptions/:id"));
    expect(position("DELETE", "/admin/review-queue/bulk"))
      .toBeLessThan(position("DELETE", "/admin/review-queue/:id"));

    expect(position("GET", "/admin/constitution/proposals"))
      .toBeLessThan(position("GET", "/admin/constitution/proposals/:id"));

    expect(matchRoute(ROUTES, "DELETE", "/admin/review-queue/bulk")?.route.path)
      .toBe("/admin/review-queue/bulk");
  });

  it("binds Phase E source at the protected route boundary", async () => {
    const originalHandleChat = handlers.handleChat;
    const calls = [];
    handlers.handleChat = (...args) => {
      calls.push(args);
      return Promise.resolve({ ok: true });
    };

    try {
      const publicHit = matchRoute(ROUTES, "POST", "/chat");
      const phaseEHit = matchRoute(ROUTES, "POST", "/admin/phase-e/chat");

      expect(publicHit?.route.path).toBe("/chat");
      expect(phaseEHit?.route.path).toBe("/admin/phase-e/chat");
      expect(isProtectedRoute(phaseEHit.route.path)).toBe(true);

      await publicHit.route.handler("request", "env", "ctx", "cors", publicHit.params);
      await phaseEHit.route.handler("request", "env", "ctx", "cors", phaseEHit.params);

      expect(calls).toHaveLength(2);
      expect(calls[0][4]).toBeUndefined();
      expect(calls[1][4]).toBe("phase_e_test");
    } finally {
      handlers.handleChat = originalHandleChat;
    }
  });
});

describe("central reviewer protection contract", () => {
  it("protects all admin routes and only the declared non-admin exceptions", () => {
    expect(ADMIN_EXTRA_PROTECTED_PATHS).toEqual(new Set([
      "/api/office-hours/schedule",
      "/api/office-hours/schedule/:day",
      "/api/office-hours/overrides",
      "/api/office-hours/overrides/:date",
      "/api/rd-log",
      "/api/rd-log/:id",
      "/qa",
    ]));

    for (const route of ROUTES) {
      if (route.path.startsWith("/admin/"))
        expect(isProtectedRoute(route.path)).toBe(true);
    }
    for (const path of ADMIN_EXTRA_PROTECTED_PATHS) {
      expect(ROUTES.some((route) => route.path === path)).toBe(true);
      expect(isProtectedRoute(path)).toBe(true);
    }
    expect(isProtectedRoute("/admin")).toBe(true);
    expect(isProtectedRoute("/adminish")).toBe(false);
    expect(isProtectedRoute("/api/office-hours")).toBe(false);
    expect(isProtectedRoute("/chat")).toBe(false);
  });
});

describe("panel-scoped route authorization contract", () => {
  // Enforcement is deny-by-default: an unmapped protected route is refused for
  // every non-Operator. That is the safe direction, but it also means a new
  // route silently becomes Operator-only unless someone assigns it a panel.
  // This test makes that visible instead of letting it pass unnoticed.
  const KNOWN_UNMAPPED = ["/admin/phase-e/chat"];

  it("assigns every protected route to a panel, except the declared exceptions", () => {
    const unmapped = ROUTES
      .filter((route) => isProtectedRoute(route.path) && !panelForRoutePath(route.path))
      .map((route) => route.path);

    expect([...new Set(unmapped)].sort()).toEqual([...KNOWN_UNMAPPED].sort());
  });

  it("keeps the boot route reachable regardless of grants", () => {
    // Gating this would lock out every non-Operator before the panel could
    // render: it is how a caller discovers its own tier and grants.
    expect(panelForRoutePath("/admin/me")).toBe("ALWAYS");
    expect(ROUTES.some((route) => route.method === "GET" && route.path === "/admin/me")).toBe(true);
  });

  it("gates the reviewer list and the credential vault behind their panels", () => {
    expect(panelForRoutePath("/admin/reviewers")).toBe("admin.html:reviewers");
    expect(panelForRoutePath("/admin/admin-panels")).toBe("admin.html:reviewers");
    // The vault lives inside the Subscriptions tab, so Subscriptions is what
    // protects the vendor credential notes and card entries.
    expect(panelForRoutePath("/admin/vault")).toBe("admin.html:subscriptions");
    expect(panelForRoutePath("/admin/subscriptions")).toBe("admin.html:subscriptions");
  });

  it("routes the Review Queue to the Feedback panel that hosts it", () => {
    expect(panelForRoutePath("/admin/review-queue")).toBe("admin.html:feedback");
    expect(panelForRoutePath("/admin/feedback")).toBe("admin.html:feedback");
  });

  it("withholds Reviewers and the Operator-only panels from the tier defaults", () => {
    expect(TIER_DEFAULT_PANELS.delegate).toContain("admin.html:reviewers");
    expect(TIER_DEFAULT_PANELS.staff).not.toContain("admin.html:reviewers");

    for (const tier of ["delegate", "staff", "client_tester"]) {
      for (const operatorOnly of ["admin.html:subscriptions", "admin.html:config",
                                  "admin.html:constitution", "admin.html:auth-incidents",
                                  "admin.html:system-prompt"]) {
        expect(TIER_DEFAULT_PANELS[tier]).not.toContain(operatorOnly);
      }
    }
    // A Client Tester has no surface to be granted yet.
    expect(TIER_DEFAULT_PANELS.client_tester).toEqual([]);
  });
});
