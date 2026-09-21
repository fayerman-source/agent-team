import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  parseArgs,
  parsePriority,
  parseTitle,
  parseFinding,
  countPriorities,
  pollOnce,
  waitForVerdict,
  appendLog,
  exitCodeFor,
  resolveReactions,
  DEFAULT_BOT,
} from "../bin/wait-for-verdict.mjs";

const REPO = "acme/widgets";
const PR = 42;
const HEAD = "a".repeat(40);
const SINCE = "2026-09-21T12:00:00.000Z";

function baseArgs(overrides = {}) {
  return {
    repo: REPO,
    pr: PR,
    head: HEAD,
    bot: DEFAULT_BOT,
    since: SINCE,
    deadlineMin: 30,
    intervalS: 45,
    log: overrides.log,
    ...overrides,
  };
}

// A fake clock: sleep() advances it, now() reads it. Lets waitForVerdict's
// timing logic run deterministically with no real waiting.
function fakeClock(startIso) {
  let t = new Date(startIso).getTime();
  return {
    now: () => new Date(t),
    sleep: async (ms) => {
      t += ms;
    },
  };
}

function prHead(sha) {
  return { head: { sha } };
}

// ---------------------------------------------------------------------
// parsing helpers
// ---------------------------------------------------------------------

test("parsePriority reads P1/P2/P3 badges", () => {
  assert.equal(parsePriority("**P1** something bad"), "P1");
  assert.equal(parsePriority("this is a P2 finding"), "P2");
  assert.equal(parsePriority("no badge here"), null);
});

test("parseTitle prefers first bold text, else first line, capped at 120", () => {
  assert.equal(parseTitle("**Null deref** on line 4\nmore text"), "Null deref");
  assert.equal(parseTitle("first line only\nsecond line"), "first line only");
  const long = "x".repeat(200);
  assert.equal(parseTitle(long).length, 120);
});

test("parseTitle strips <sub> tags and markdown badge images from a real codex body", () => {
  const body =
    "<sub><sub>![P2 Badge](https://img.shields.io/badge/P2-yellow?style=flat)</sub></sub>  Load changes outside the current two-week window\nmore detail below";
  assert.equal(parseTitle(body), "Load changes outside the current two-week window");
});

test("parseFinding extracts id/priority/title/path/line/original_commit_id", () => {
  const f = parseFinding({
    id: 7,
    body: "**P1: Off-by-one** in loop bound",
    path: "src/foo.ts",
    line: 12,
    original_commit_id: HEAD,
  });
  assert.deepEqual(f, {
    id: 7,
    priority: "P1",
    title: "P1: Off-by-one",
    path: "src/foo.ts",
    line: 12,
    original_commit_id: HEAD,
  });
});

test("countPriorities tallies P1/P2/P3/unrated", () => {
  const counts = countPriorities([
    { priority: "P1" },
    { priority: "P2" },
    { priority: "P2" },
    { priority: null },
  ]);
  assert.deepEqual(counts, { P1: 1, P2: 2, P3: 0, unrated: 1 });
});

// ---------------------------------------------------------------------
// pollOnce forms
// ---------------------------------------------------------------------

test("pollOnce: review with 2 findings including priority parse", async () => {
  const calls = [];
  const ghApi = async (endpoint) => {
    calls.push(endpoint);
    if (endpoint.endsWith(`/pulls/${PR}`)) return prHead(HEAD);
    if (endpoint.endsWith("/reviews")) {
      return [
        { id: 99, user: { login: DEFAULT_BOT }, commit_id: HEAD, submitted_at: "2026-09-21T12:01:00Z", html_url: "https://example/review/99" },
      ];
    }
    if (endpoint.endsWith("/reviews/99/comments")) {
      return [
        { id: 1, body: "**P1: Bug A**", path: "a.ts", line: 3, original_commit_id: HEAD },
        { id: 2, body: "**P2: Bug B**", path: "b.ts", line: 9, original_commit_id: HEAD },
      ];
    }
    throw new Error(`unexpected endpoint ${endpoint}`);
  };
  const result = await pollOnce({ repo: REPO, pr: PR, head: HEAD, bot: DEFAULT_BOT, since: SINCE }, ghApi, async () => {});
  assert.equal(result.outcome, "verdict");
  assert.equal(result.form, "review");
  assert.equal(result.clean, false);
  assert.equal(result.findings.length, 2);
  assert.equal(result.findings[0].priority, "P1");
  assert.equal(result.findings[1].priority, "P2");
  assert.deepEqual(result.counts, { P1: 1, P2: 1, P3: 0, unrated: 0 });
});

test("pollOnce: review with zero comments is clean (waits once for the 0-1s lag)", async () => {
  let commentCalls = 0;
  const sleeps = [];
  const ghApi = async (endpoint) => {
    if (endpoint.endsWith(`/pulls/${PR}`)) return prHead(HEAD);
    if (endpoint.endsWith("/reviews")) {
      return [{ id: 5, user: { login: DEFAULT_BOT }, commit_id: HEAD, submitted_at: "2026-09-21T12:01:00Z", html_url: "u" }];
    }
    if (endpoint.endsWith("/reviews/5/comments")) {
      commentCalls++;
      return [];
    }
    throw new Error("unexpected");
  };
  const sleep = async (ms) => sleeps.push(ms);
  const result = await pollOnce({ repo: REPO, pr: PR, head: HEAD, bot: DEFAULT_BOT, since: SINCE }, ghApi, sleep);
  assert.equal(result.outcome, "verdict");
  assert.equal(result.clean, true);
  assert.equal(result.findings.length, 0);
  assert.equal(commentCalls, 2, "should re-fetch comments once after waiting");
  assert.deepEqual(sleeps, [5000]);
});

test("pollOnce: thumbs-up reaction is a clean verdict", async () => {
  const ghApi = async (endpoint) => {
    if (endpoint.endsWith(`/pulls/${PR}`)) return prHead(HEAD);
    if (endpoint.endsWith("/reviews")) return [];
    if (endpoint.endsWith("/comments")) return [];
    if (endpoint.endsWith("/reactions")) {
      return [{ content: "+1", user: { login: DEFAULT_BOT }, created_at: "2026-09-21T12:05:00Z" }];
    }
    throw new Error("unexpected " + endpoint);
  };
  const result = await pollOnce({ repo: REPO, pr: PR, head: HEAD, bot: DEFAULT_BOT, since: SINCE }, ghApi, async () => {});
  assert.equal(result.outcome, "verdict");
  assert.equal(result.form, "reaction");
  assert.equal(result.clean, true);
});

test("pollOnce: eyes reaction is an acknowledgement, not a verdict", async () => {
  const ghApi = async (endpoint) => {
    if (endpoint.endsWith(`/pulls/${PR}`)) return prHead(HEAD);
    if (endpoint.endsWith("/reviews")) return [];
    if (endpoint.endsWith("/comments")) return [];
    if (endpoint.endsWith("/reactions")) {
      return [{ content: "eyes", user: { login: DEFAULT_BOT }, created_at: "2026-09-21T12:00:30Z" }];
    }
    throw new Error("unexpected " + endpoint);
  };
  const result = await pollOnce({ repo: REPO, pr: PR, head: HEAD, bot: DEFAULT_BOT, since: SINCE }, ghApi, async () => {});
  assert.equal(result.outcome, "ack");
  assert.equal(result.ack_at, "2026-09-21T12:00:30Z");
});

test("pollOnce: +1 on a trigger comment (not the PR) is a clean verdict", async () => {
  const ghApi = async (endpoint) => {
    if (endpoint === `repos/${REPO}/pulls/${PR}`) return prHead(HEAD);
    if (endpoint === `repos/${REPO}/pulls/${PR}/reviews`) return [];
    if (endpoint === `repos/${REPO}/issues/${PR}/comments`) {
      return [{ id: 555, user: { login: "someone" }, created_at: "2026-09-21T12:02:00Z", body: "@codex review" }];
    }
    if (endpoint === `repos/${REPO}/issues/${PR}/reactions`) return [];
    if (endpoint === `repos/${REPO}/issues/comments/555/reactions`) {
      return [{ content: "+1", user: { login: DEFAULT_BOT }, created_at: "2026-09-21T12:03:00Z" }];
    }
    throw new Error("unexpected " + endpoint);
  };
  const result = await pollOnce({ repo: REPO, pr: PR, head: HEAD, bot: DEFAULT_BOT, since: SINCE }, ghApi, async () => {});
  assert.equal(result.outcome, "verdict");
  assert.equal(result.form, "reaction");
  assert.equal(result.clean, true);
  assert.equal(result.verdict_at, "2026-09-21T12:03:00Z");
});

test("pollOnce: eyes on a trigger comment is an acknowledgement", async () => {
  const ghApi = async (endpoint) => {
    if (endpoint === `repos/${REPO}/pulls/${PR}`) return prHead(HEAD);
    if (endpoint === `repos/${REPO}/pulls/${PR}/reviews`) return [];
    if (endpoint === `repos/${REPO}/issues/${PR}/comments`) {
      return [{ id: 556, user: { login: "someone" }, created_at: "2026-09-21T12:02:00Z", body: "@codex review" }];
    }
    if (endpoint === `repos/${REPO}/issues/${PR}/reactions`) return [];
    if (endpoint === `repos/${REPO}/issues/comments/556/reactions`) {
      return [{ content: "eyes", user: { login: DEFAULT_BOT }, created_at: "2026-09-21T12:02:30Z" }];
    }
    throw new Error("unexpected " + endpoint);
  };
  const result = await pollOnce({ repo: REPO, pr: PR, head: HEAD, bot: DEFAULT_BOT, since: SINCE }, ghApi, async () => {});
  assert.equal(result.outcome, "ack");
  assert.equal(result.ack_at, "2026-09-21T12:02:30Z");
});

test("resolveReactions: codex defaults to +1/eyes, other bots default to none/none", () => {
  assert.deepEqual(resolveReactions(DEFAULT_BOT, undefined, undefined), {
    verdictReaction: "+1",
    ackReaction: "eyes",
    reactionsIgnored: false,
  });
  assert.deepEqual(resolveReactions("some-other-bot[bot]", undefined, undefined), {
    verdictReaction: "none",
    ackReaction: "none",
    reactionsIgnored: true,
  });
});

test("pollOnce: a non-codex bot ignores reactions by default (no verdict, reactions endpoint never called)", async () => {
  const OTHER_BOT = "some-other-bot[bot]";
  const ghApi = async (endpoint) => {
    if (endpoint === `repos/${REPO}/pulls/${PR}`) return prHead(HEAD);
    if (endpoint === `repos/${REPO}/pulls/${PR}/reviews`) return [];
    if (endpoint === `repos/${REPO}/issues/${PR}/comments`) return [];
    if (endpoint.includes("reactions")) {
      throw new Error("reactions should be ignored, not queried: " + endpoint);
    }
    throw new Error("unexpected " + endpoint);
  };
  const result = await pollOnce({ repo: REPO, pr: PR, head: HEAD, bot: OTHER_BOT, since: SINCE }, ghApi, async () => {});
  assert.equal(result.outcome, "none");
  assert.equal(result.reactions_ignored, true);
});

test("waitForVerdict: a non-codex bot with a +1 (ignored) and no flags times out", async () => {
  const OTHER_BOT = "some-other-bot[bot]";
  const ghApi = async (endpoint) => {
    if (endpoint === `repos/${REPO}/pulls/${PR}`) return prHead(HEAD);
    if (endpoint === `repos/${REPO}/pulls/${PR}/reviews`) return [];
    if (endpoint === `repos/${REPO}/issues/${PR}/comments`) return [];
    throw new Error("unexpected " + endpoint);
  };
  const clock = fakeClock(SINCE);
  const args = baseArgs({ bot: OTHER_BOT, deadlineMin: 1, intervalS: 45 });
  const record = await waitForVerdict(args, ghApi, { now: clock.now, sleep: clock.sleep, stderr: () => {} });
  assert.equal(record.status, "timeout");
  assert.equal(record.reactions_ignored, true);
});

test("pollOnce: a non-codex bot with --verdict-reaction hooray reads hooray as a clean verdict", async () => {
  const OTHER_BOT = "some-other-bot[bot]";
  const ghApi = async (endpoint) => {
    if (endpoint === `repos/${REPO}/pulls/${PR}`) return prHead(HEAD);
    if (endpoint === `repos/${REPO}/pulls/${PR}/reviews`) return [];
    if (endpoint === `repos/${REPO}/issues/${PR}/comments`) return [];
    if (endpoint === `repos/${REPO}/issues/${PR}/reactions`) {
      return [{ content: "hooray", user: { login: OTHER_BOT }, created_at: "2026-09-21T12:05:00Z" }];
    }
    throw new Error("unexpected " + endpoint);
  };
  const result = await pollOnce(
    { repo: REPO, pr: PR, head: HEAD, bot: OTHER_BOT, since: SINCE, verdictReaction: "hooray" },
    ghApi,
    async () => {}
  );
  assert.equal(result.outcome, "verdict");
  assert.equal(result.form, "reaction");
  assert.equal(result.clean, true);
  assert.equal(result.reactions_ignored, false);
});

test("pollOnce: head changed is superseded", async () => {
  const ghApi = async (endpoint) => {
    if (endpoint.endsWith(`/pulls/${PR}`)) return prHead("b".repeat(40));
    throw new Error("should not call further endpoints once superseded: " + endpoint);
  };
  const result = await pollOnce({ repo: REPO, pr: PR, head: HEAD, bot: DEFAULT_BOT, since: SINCE }, ghApi, async () => {});
  assert.equal(result.outcome, "superseded");
});

test("pollOnce: pr-comment form, clean is null and body excerpt to 300 chars", async () => {
  const longBody = "x".repeat(400);
  const ghApi = async (endpoint) => {
    if (endpoint.endsWith(`/pulls/${PR}`)) return prHead(HEAD);
    if (endpoint.endsWith("/reviews")) return [];
    if (endpoint.endsWith(`/issues/${PR}/comments`)) {
      return [{ user: { login: DEFAULT_BOT }, created_at: "2026-09-21T12:03:00Z", body: longBody, html_url: "u" }];
    }
    throw new Error("unexpected " + endpoint);
  };
  const result = await pollOnce({ repo: REPO, pr: PR, head: HEAD, bot: DEFAULT_BOT, since: SINCE }, ghApi, async () => {});
  assert.equal(result.outcome, "verdict");
  assert.equal(result.form, "pr-comment");
  assert.equal(result.clean, null);
  assert.equal(result.findings[0].body.length, 300);
});

// ---------------------------------------------------------------------
// waitForVerdict loop: timeout with ack_at, and log-on-every-exit
// ---------------------------------------------------------------------

test("waitForVerdict: eyes then nothing times out, but records ack_at", async () => {
  let reactionCall = 0;
  const ghApi = async (endpoint) => {
    if (endpoint.endsWith(`/pulls/${PR}`)) return prHead(HEAD);
    if (endpoint.endsWith("/reviews")) return [];
    if (endpoint.endsWith("/comments")) return [];
    if (endpoint.endsWith("/reactions")) {
      reactionCall++;
      if (reactionCall === 1) {
        return [{ content: "eyes", user: { login: DEFAULT_BOT }, created_at: "2026-09-21T12:00:30Z" }];
      }
      return [];
    }
    throw new Error("unexpected " + endpoint);
  };
  const clock = fakeClock(SINCE);
  const args = baseArgs({ deadlineMin: 1, intervalS: 45 });
  const record = await waitForVerdict(args, ghApi, { now: clock.now, sleep: clock.sleep, stderr: () => {} });
  assert.equal(record.status, "timeout");
  assert.equal(record.ack_at, "2026-09-21T12:00:30Z");
  assert.equal(record.verdict_at, null);
});

test("waitForVerdict: 5 consecutive gh failures produce status error", async () => {
  const ghApi = async () => {
    throw new Error("network down");
  };
  const clock = fakeClock(SINCE);
  const args = baseArgs({ deadlineMin: 30, intervalS: 1 });
  const stderrLines = [];
  const record = await waitForVerdict(args, ghApi, {
    now: clock.now,
    sleep: clock.sleep,
    stderr: (s) => stderrLines.push(s),
  });
  assert.equal(record.status, "error");
  assert.equal(stderrLines.length, 5);
});

test("waitForVerdict + appendLog: a log line is appended on every exit (verdict, timeout, superseded, error)", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "verdict-log-"));
  const logPath = path.join(tmp, "verdicts.jsonl");

  // verdict
  const cleanGhApi = async (endpoint) => {
    if (endpoint.endsWith(`/pulls/${PR}`)) return prHead(HEAD);
    if (endpoint.endsWith("/reviews")) return [];
    if (endpoint.endsWith("/comments")) return [];
    if (endpoint.endsWith("/reactions")) {
      return [{ content: "+1", user: { login: DEFAULT_BOT }, created_at: "2026-09-21T12:05:00Z" }];
    }
    throw new Error("unexpected " + endpoint);
  };
  let clock = fakeClock(SINCE);
  let record = await waitForVerdict(baseArgs({ deadlineMin: 30, intervalS: 1 }), cleanGhApi, { now: clock.now, sleep: clock.sleep, stderr: () => {} });
  appendLog(logPath, record);

  // superseded
  const supersededGhApi = async (endpoint) => {
    if (endpoint.endsWith(`/pulls/${PR}`)) return prHead("c".repeat(40));
    throw new Error("should not be called");
  };
  clock = fakeClock(SINCE);
  record = await waitForVerdict(baseArgs({ deadlineMin: 30, intervalS: 1 }), supersededGhApi, { now: clock.now, sleep: clock.sleep, stderr: () => {} });
  appendLog(logPath, record);

  // timeout
  const timeoutGhApi = async (endpoint) => {
    if (endpoint.endsWith(`/pulls/${PR}`)) return prHead(HEAD);
    if (endpoint.endsWith("/reviews")) return [];
    if (endpoint.endsWith("/comments")) return [];
    if (endpoint.endsWith("/reactions")) return [];
    throw new Error("unexpected " + endpoint);
  };
  clock = fakeClock(SINCE);
  record = await waitForVerdict(baseArgs({ deadlineMin: 1, intervalS: 45 }), timeoutGhApi, { now: clock.now, sleep: clock.sleep, stderr: () => {} });
  appendLog(logPath, record);

  // error
  const errorGhApi = async () => {
    throw new Error("boom");
  };
  clock = fakeClock(SINCE);
  record = await waitForVerdict(baseArgs({ deadlineMin: 30, intervalS: 1 }), errorGhApi, { now: clock.now, sleep: clock.sleep, stderr: () => {} });
  appendLog(logPath, record);

  const lines = fs.readFileSync(logPath, "utf8").trim().split("\n");
  assert.equal(lines.length, 4);
  const statuses = lines.map((l) => JSON.parse(l).status);
  assert.deepEqual(statuses, ["verdict", "superseded", "timeout", "error"]);

  fs.rmSync(tmp, { recursive: true, force: true });
});

// ---------------------------------------------------------------------
// args / exit codes
// ---------------------------------------------------------------------

test("parseArgs requires --repo --pr --head and applies defaults", () => {
  const args = parseArgs(["--repo", REPO, "--pr", String(PR), "--head", HEAD]);
  assert.equal(args.repo, REPO);
  assert.equal(args.pr, PR);
  assert.equal(args.head, HEAD);
  assert.equal(args.bot, DEFAULT_BOT);
  assert.equal(args.deadlineMin, 30);
  assert.equal(args.intervalS, 45);
  assert.ok(args.since);
  assert.ok(args.log);
  assert.throws(() => parseArgs(["--repo", REPO]));
});

test("exitCodeFor maps status to exit code", () => {
  assert.equal(exitCodeFor("verdict"), 0);
  assert.equal(exitCodeFor("timeout"), 2);
  assert.equal(exitCodeFor("superseded"), 3);
  assert.equal(exitCodeFor("error"), 1);
});
