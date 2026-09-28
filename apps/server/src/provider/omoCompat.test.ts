// @effect-diagnostics nodeBuiltinImport:off
import * as NodeAssert from "node:assert/strict";
import * as NodePath from "node:path";

import { describe, it } from "vite-plus/test";

import {
  normalizeOmoAppServerMessage,
  omoBinaryCandidates,
  omoUserConfigPaths,
  parseOmoModelProfiles,
} from "./omoCompat.ts";

describe("normalizeOmoAppServerMessage", () => {
  it("floors fractional timestamps and adds projectId to thread records", () => {
    const message = {
      id: 3,
      result: {
        thread: {
          id: "t1",
          preview: "",
          cwd: "C:\\repo",
          createdAt: 1790585742.083,
          updatedAt: 1790585742.9,
          turns: [{ id: "u1", startedAt: 1790585743.5, completedAt: null }],
        },
        model: "devin/swe-2",
      },
    };

    NodeAssert.deepEqual(normalizeOmoAppServerMessage(message), {
      id: 3,
      result: {
        thread: {
          id: "t1",
          preview: "",
          cwd: "C:\\repo",
          createdAt: 1790585742,
          updatedAt: 1790585742,
          turns: [{ id: "u1", startedAt: 1790585743, completedAt: null }],
          projectId: null,
        },
        model: "devin/swe-2",
      },
    });
  });

  it("keeps an existing projectId and non-timestamp fractions", () => {
    const message = {
      method: "thread/started",
      params: { thread: { preview: "x", cwd: "/r", projectId: "p1", usage: 0.5 } },
    };

    NodeAssert.deepEqual(normalizeOmoAppServerMessage(message), message);
  });
});

describe("parseOmoModelProfiles", () => {
  it("reads model_profiles in order and skips profiles without models", () => {
    NodeAssert.deepEqual(
      parseOmoModelProfiles({
        categories: { quick: { models: ["a/b"] } },
        model_profiles: {
          "daily-normal": { models: ["opencodex/gpt-5.6-sol"] },
          empty: { models: [] },
          broken: "nope",
          "daily-heavy": { models: ["opencodex/gpt-6-astra", "openai/gpt-6-astra"] },
        },
      }),
      [
        { name: "daily-normal", models: ["opencodex/gpt-5.6-sol"] },
        { name: "daily-heavy", models: ["opencodex/gpt-6-astra", "openai/gpt-6-astra"] },
      ],
    );
  });

  it("returns no profiles for configs without model_profiles", () => {
    NodeAssert.deepEqual(parseOmoModelProfiles({ agents: {} }), []);
    NodeAssert.deepEqual(parseOmoModelProfiles(null), []);
  });
});

describe("omo install locations", () => {
  it("prefers BUN_INSTALL, then ~/.bun/bin, with the platform executable name", () => {
    NodeAssert.deepEqual(
      omoBinaryCandidates({ platform: "win32", env: { BUN_INSTALL: "D:\\bun" }, homeDir: "C:\\u" }),
      [
        NodePath.join("D:\\bun", "bin", "omo.exe"),
        NodePath.join("C:\\u", ".bun", "bin", "omo.exe"),
      ],
    );
    NodeAssert.deepEqual(omoBinaryCandidates({ platform: "linux", env: {}, homeDir: "/home/u" }), [
      NodePath.join("/home/u", ".bun", "bin", "omo"),
    ]);
  });

  it("reads the user config from HOME/.omo like omo does", () => {
    NodeAssert.deepEqual(omoUserConfigPaths({ HOME: "/h" }, "/fallback"), [
      NodePath.join("/h", ".omo", "omo.jsonc"),
      NodePath.join("/h", ".omo", "omo.json"),
    ]);
  });
});
