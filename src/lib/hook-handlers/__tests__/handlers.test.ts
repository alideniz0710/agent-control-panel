// Unit tests for hook-handler summarizers.
//
// We don't test the route's HMAC verification here — that lives in
// the route file and uses node:crypto directly (which has its own
// extensive tests). These tests focus on the semantic mapping:
// "given event payload X, do we produce the correct summary string
// or null?"

import { describe, expect, it } from "vitest";
import { summarizeGithub } from "../github";
import { summarizeVercel } from "../vercel";
import { summarizeSentry } from "../sentry";

describe("summarizeGithub", () => {
  it("summarizes pull_request opened", () => {
    const out = summarizeGithub({
      event: "pull_request",
      payload: {
        action: "opened",
        pull_request: {
          number: 42,
          title: "fix: cache opt-out",
          state: "open",
          user: { login: "alidenizs" },
          html_url: "https://github.com/owner/repo/pull/42",
        },
        repository: { full_name: "owner/repo" },
      },
    });
    expect(out).toContain("PR #42");
    expect(out).toContain("opened");
    expect(out).toContain("owner/repo");
  });

  it("summarizes pull_request merged", () => {
    const out = summarizeGithub({
      event: "pull_request",
      payload: {
        action: "closed",
        pull_request: {
          number: 99,
          title: "feat: webhooks",
          state: "closed",
          merged: true,
          user: { login: "alidenizs" },
        },
        repository: { full_name: "owner/repo" },
      },
    });
    expect(out).toContain("PR #99 merged");
  });

  it("ignores pull_request synchronize", () => {
    const out = summarizeGithub({
      event: "pull_request",
      payload: {
        action: "synchronize",
        pull_request: { number: 1, title: "x", state: "open" },
        repository: { full_name: "owner/repo" },
      },
    });
    expect(out).toBeNull();
  });

  it("ignores push to non-main branches", () => {
    const out = summarizeGithub({
      event: "push",
      payload: {
        ref: "refs/heads/feature/x",
        pusher: { name: "alidenizs" },
        repository: { full_name: "owner/repo" },
      },
    });
    expect(out).toBeNull();
  });

  it("summarizes push to main", () => {
    const out = summarizeGithub({
      event: "push",
      payload: {
        ref: "refs/heads/main",
        pusher: { name: "alidenizs" },
        head_commit: { message: "Merge PR #42\n\nbody" },
        repository: { full_name: "owner/repo" },
      },
    });
    expect(out).toContain("push to main");
    expect(out).toContain("Merge PR #42");
  });

  it("only surfaces workflow_run failures (not successes)", () => {
    const failure = summarizeGithub({
      event: "workflow_run",
      payload: {
        action: "completed",
        workflow_run: {
          name: "CI",
          conclusion: "failure",
          status: "completed",
          head_branch: "main",
        },
        repository: { full_name: "owner/repo" },
      },
    });
    const success = summarizeGithub({
      event: "workflow_run",
      payload: {
        action: "completed",
        workflow_run: {
          name: "CI",
          conclusion: "success",
          status: "completed",
          head_branch: "main",
        },
        repository: { full_name: "owner/repo" },
      },
    });
    expect(failure).toContain("failure");
    expect(success).toBeNull();
  });

  it("ignores unknown event types", () => {
    const out = summarizeGithub({ event: "star", payload: { action: "created" } });
    expect(out).toBeNull();
  });
});

describe("summarizeVercel", () => {
  it("summarizes deployment.succeeded", () => {
    const out = summarizeVercel({
      type: "deployment.succeeded",
      payload: {
        type: "deployment.succeeded",
        deployment: {
          url: "splitbill-abc123.vercel.app",
          meta: { githubCommitRef: "main", githubCommitMessage: "fix: cache" },
        },
        project: { name: "splitbill" },
        target: "production",
      },
    });
    expect(out).toContain("splitbill");
    expect(out).toContain("succeeded");
    expect(out).toContain("production");
    expect(out).toContain("https://splitbill-abc123.vercel.app");
  });

  it("summarizes deployment.error", () => {
    const out = summarizeVercel({
      type: "deployment.error",
      payload: {
        type: "deployment.error",
        deployment: { meta: { githubCommitRef: "feat/x" } },
        project: { name: "splitbill" },
      },
    });
    expect(out).toContain("error");
  });

  it("ignores deployment.created (too noisy)", () => {
    const out = summarizeVercel({
      type: "deployment.created",
      payload: { type: "deployment.created" },
    });
    expect(out).toBeNull();
  });

  it("ignores unknown types", () => {
    const out = summarizeVercel({ type: "project.updated", payload: {} });
    expect(out).toBeNull();
  });
});

describe("summarizeSentry", () => {
  it("summarizes issue.created", () => {
    const out = summarizeSentry({
      resource: "issue",
      action: "created",
      payload: {
        data: {
          issue: {
            title: "TypeError: Cannot read property foo",
            level: "error",
            shortId: "PROJECT-1",
            project: { name: "splitbill-web" },
            culprit: "app/bill/[token]/page.tsx",
            permalink: "https://sentry.io/org/proj/issues/1/",
          },
        },
      },
    });
    expect(out).toContain("PROJECT-1");
    expect(out).toContain("ERROR");
    expect(out).toContain("splitbill-web");
    expect(out).toContain("created");
  });

  it("summarizes issue.resolved", () => {
    const out = summarizeSentry({
      resource: "issue",
      action: "resolved",
      payload: {
        data: { issue: { title: "fixed thing", shortId: "PROJECT-2", project: { name: "splitbill-web" } } },
      },
    });
    expect(out).toContain("resolved");
  });

  it("ignores non-issue resources", () => {
    const out = summarizeSentry({
      resource: "event_alert",
      action: "triggered",
      payload: {},
    });
    expect(out).toBeNull();
  });

  it("ignores irrelevant issue actions (e.g. assigned)", () => {
    const out = summarizeSentry({
      resource: "issue",
      action: "assigned",
      payload: { data: { issue: { title: "x", shortId: "P-1" } } },
    });
    expect(out).toBeNull();
  });
});
