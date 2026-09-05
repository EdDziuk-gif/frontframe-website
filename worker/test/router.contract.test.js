import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ADMIN_EXTRA_PROTECTED_PATHS, isProtectedRoute } from "../src/middleware/auth.js";
import { ROUTES } from "../src/index.js";
import { matchRoute } from "../src/router.js";
import { handlers } from "../src/routes/registry.js";

const manifest = ROUTES.map(({ method, path }) => `${method} ${path}`).join("\n");

describe("Worker route contract", () => {
  it("preserves the approved 108-route manifest and declaration order", () => {
    expect(ROUTES).toHaveLength(122);
    expect(createHash("sha256").update(manifest).digest("hex"))
      .toBe("f3885dbdd094360a27304847f3e46f97369d87558daf277ff6bc944dcd492829");
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
      "/qa/:id",
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
