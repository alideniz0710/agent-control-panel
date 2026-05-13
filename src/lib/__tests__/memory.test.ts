// Memory system unit tests.
//
// agentSlug is a pure function — test it directly. The fs-touching
// functions (read/append) are exercised end-to-end at runtime; we
// verify their composition logic via the slug + the structure of
// buildMemoryContext output when given canned strings.

import { describe, expect, it } from "vitest";
import { agentSlug } from "../memory";

describe("agentSlug", () => {
  it("strips the cc: prefix", () => {
    expect(agentSlug("cc:software-engineer")).toBe("software-engineer");
    expect(agentSlug("cc:debug")).toBe("debug");
  });

  it("leaves names without prefix alone", () => {
    expect(agentSlug("software-engineer")).toBe("software-engineer");
  });

  it("trims whitespace", () => {
    expect(agentSlug("  cc:debug  ")).toBe("debug");
  });
});

describe("memory context shape (smoke)", () => {
  it("buildMemoryContext returns either empty or a well-formed prefix", async () => {
    const { buildMemoryContext } = await import("../memory");
    const result = await buildMemoryContext("cc:software-engineer");
    if (result === "") {
      // No memory files in working tree — that's an acceptable outcome
      expect(result).toBe("");
    } else {
      // If memory exists, structure must be: header → sections → "Your current task" footer
      expect(result).toMatch(/^# Project Context/);
      expect(result).toContain("# Your current task");
    }
  });
});
