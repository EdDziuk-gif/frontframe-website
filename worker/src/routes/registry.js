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
};
