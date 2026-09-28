import * as NodeAssert from "node:assert/strict";

import { describe, it } from "vite-plus/test";
import type * as CodexSchema from "effect-codex-app-server/schema";

import { buildOmoModels, omoProfileSlug, resolveOmoModelId } from "./OmoDriver.ts";

const catalogModel = (
  id: string,
  overrides: Partial<CodexSchema.V2ModelListResponse__Model> = {},
): CodexSchema.V2ModelListResponse__Model => ({
  id,
  model: id.slice(id.indexOf("/") + 1),
  displayName: id,
  description: "",
  hidden: false,
  isDefault: false,
  defaultReasoningEffort: "medium",
  supportedReasoningEfforts: [
    { reasoningEffort: "low", description: "" },
    { reasoningEffort: "medium", description: "" },
  ],
  ...overrides,
});

const profiles = [
  { name: "daily-normal", models: ["opencodex/gpt-5.6-sol"] },
  { name: "daily-heavy", models: ["missing/model", "opencodex/gpt-6-astra"] },
];

describe("buildOmoModels", () => {
  it("lists profiles first, marks the first profile default, and hides hidden models", () => {
    const models = buildOmoModels({
      catalog: [
        catalogModel("opencodex/gpt-5.6-sol", { isDefault: true }),
        catalogModel("opencodex/gpt-6-astra"),
        catalogModel("openai/secret", { hidden: true }),
      ],
      profiles,
    });

    NodeAssert.deepEqual(
      models.map((model) => [model.slug, model.subProvider, model.isDefault === true]),
      [
        [omoProfileSlug("daily-normal"), "Profile", true],
        [omoProfileSlug("daily-heavy"), "Profile", false],
        ["opencodex/gpt-5.6-sol", "opencodex", false],
        ["opencodex/gpt-6-astra", "opencodex", false],
      ],
    );
  });

  it("falls back to omo's own default model when there are no profiles", () => {
    const models = buildOmoModels({
      catalog: [catalogModel("a/one"), catalogModel("a/two", { isDefault: true })],
      profiles: [],
    });

    NodeAssert.deepEqual(
      models.filter((model) => model.isDefault).map((model) => model.slug),
      ["a/two"],
    );
  });
});

describe("resolveOmoModelId", () => {
  const modelIds = new Set(["opencodex/gpt-5.6-sol", "opencodex/gpt-6-astra"]);

  it("resolves a profile to its first model that omo actually offers", () => {
    NodeAssert.equal(
      resolveOmoModelId(omoProfileSlug("daily-heavy"), { profiles, modelIds }),
      "opencodex/gpt-6-astra",
    );
  });

  it("passes catalog ids through and drops unknown slugs so omo keeps its default", () => {
    NodeAssert.equal(
      resolveOmoModelId("opencodex/gpt-5.6-sol", { profiles, modelIds }),
      "opencodex/gpt-5.6-sol",
    );
    NodeAssert.equal(resolveOmoModelId("omo-default", { profiles, modelIds }), undefined);
    NodeAssert.equal(resolveOmoModelId(omoProfileSlug("gone"), { profiles, modelIds }), undefined);
  });
});
