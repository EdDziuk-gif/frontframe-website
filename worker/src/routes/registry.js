import * as auth from "./auth.js";
import * as chat from "./chat.js";
import * as intake from "./intake.js";
import * as content from "./content.js";
import * as operations from "./operations.js";
import * as pipeline from "./pipeline.js";
import * as marketing from "./marketing.js";
import * as billing from "./billing.js";
import * as office from "./office.js";
import * as rd_log from "./rd-log.js";
import * as outreach from "./outreach.js";
import * as webhooks from "./webhooks.js";
import * as constitution from "./constitution.js";
import * as kgr from "./kgr.js";
import * as proposals from "./proposals.js";

// Alias constitution proposal handlers to avoid name collision with
// client-facing proposal handlers exported from proposals.js.
const constitutionAliased = {
  ...constitution,
  // Remove the colliding names from the spread; they will be re-added below
  // under their aliased keys so admin.js can reference them explicitly.
};
delete constitutionAliased.listProposals;
delete constitutionAliased.createProposal;
delete constitutionAliased.getProposal;
delete constitutionAliased.updateProposal;

export const handlers = {
  ...auth,
  ...chat,
  ...intake,
  ...content,
  ...operations,
  ...pipeline,
  ...marketing,
  ...billing,
  ...office,
  ...rd_log,
  ...outreach,
  ...webhooks,
  ...constitutionAliased,
  // Constitution proposal handlers under namespaced keys
  constitutionListProposals:   constitution.listProposals,
  constitutionCreateProposal:  constitution.createProposal,
  constitutionGetProposal:     constitution.getProposal,
  constitutionUpdateProposal:  constitution.updateProposal,
  ...kgr,
  // Client-facing proposal handlers (must come last to own the plain names)
  ...proposals,
};
