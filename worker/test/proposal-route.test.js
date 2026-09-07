import { describe, expect, it } from "vitest";
import { ROUTES } from "../src/index.js";
import { matchRoute } from "../src/router.js";
import { handlers } from "../src/routes/registry.js";

// Regression: content.js and constitution.js both exported `getProposal`.
// registry.js spreads `...constitution` after `...content`, so the public
// `GET /proposal` route silently invoked the constitutional-amendment handler
// with the wrong argument shape and 500'd on every load. The client handler is
// now `getClientProposal`.

describe("proposal route handler binding", () => {
  it("keeps the client and constitutional proposal handlers distinct", () => {
    expect(typeof handlers.getClientProposal).toBe("function");
    expect(typeof handlers.getProposal).toBe("function"); // constitution.js
    expect(handlers.getClientProposal).not.toBe(handlers.getProposal);
  });

  it("wires GET /proposal to the token-gated client handler", async () => {
    const hit = matchRoute(ROUTES, "GET", "/proposal");
    expect(hit).toBeTruthy();

    const req = { url: "https://api.frontframe.co/proposal", headers: { get: () => null } };
    const res = await hit.route.handler(req, {}, undefined, { "Access-Control-Allow-Origin": "*" }, hit.params);

    // Only the client handler short-circuits a token-less request with this 400;
    // the constitutional handler would take (env, id, jwt, cors) and misbehave.
    expect(res.status).toBe(400);
    expect(JSON.parse(await res.text()).error).toBe("token is required");
  });
});
