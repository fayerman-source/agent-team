#!/usr/bin/env node
// wait-for-verdict: background waiter for a review bot's verdict on one PR
// head. Replaces model-driven polling (agent-team SKILL.md rule 6): a
// caller starts this once, in the background, right after a push or
// trigger, and ends its turn; the harness wakes the session when this
// process exits. See README.md "Verdict waiter" for the stable interface
// this script promises to keep across its stage-2 rewrite.
//
// Node 24, zero dependencies. Auth comes from the `gh` CLI, invoked via
// child_process for every GitHub API call.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const DEFAULT_BOT = "chatgpt-codex-connector[bot]";
export const DEFAULT_DEADLINE_MIN = 30;
export const DEFAULT_INTERVAL_S = 45;

// ---------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------

export function parseArgs(argv) {
  const args = {
    bot: DEFAULT_BOT,
    deadlineMin: DEFAULT_DEADLINE_MIN,
    intervalS: DEFAULT_INTERVAL_S,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--repo":
        args.repo = argv[++i];
        break;
      case "--pr":
        args.pr = Number(argv[++i]);
        break;
      case "--head":
        args.head = argv[++i];
        break;
      case "--bot":
        args.bot = argv[++i];
        break;
      case "--since":
        args.since = argv[++i];
        break;
      case "--deadline-min":
        args.deadlineMin = Number(argv[++i]);
        break;
      case "--interval-s":
        args.intervalS = Number(argv[++i]);
        break;
      case "--log":
        args.log = argv[++i];
        break;
      default:
        throw new Error(`unknown argument: ${a}`);
    }
  }
  if (!args.repo || !args.pr || !args.head) {
    throw new Error("--repo, --pr, and --head are required");
  }
  if (!args.since) args.since = new Date().toISOString();
  if (!args.log) {
    args.log =
      process.env.AGENT_TEAM_VERDICT_LOG ||
      path.join(os.homedir(), ".local", "state", "agent-team", "verdicts.jsonl");
  }
  return args;
}

// ---------------------------------------------------------------------
// gh API (injectable for tests)
// ---------------------------------------------------------------------

export function defaultGhApi(endpoint) {
  const res = spawnSync("gh", ["api", "--paginate", endpoint], {
    encoding: "utf8",
  });
  if (res.status !== 0) {
    throw new Error(
      `gh api ${endpoint} failed (${res.status}): ${(res.stderr || "").trim()}`
    );
  }
  const text = (res.stdout || "").trim();
  if (!text) return [];
  try {
    return JSON.parse(text);
  } catch {
    // --paginate can emit one JSON document per page for endpoints whose
    // root isn't an array; gh normally merges arrays for us, but fall
    // back to newline-delimited parsing just in case.
    return text
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  }
}

// ---------------------------------------------------------------------
// Finding parsing
// ---------------------------------------------------------------------

export function parsePriority(body) {
  const m = String(body || "").match(/\bP([123])\b/);
  return m ? `P${m[1]}` : null;
}

export function parseTitle(body) {
  const text = String(body || "");
  const bold = text.match(/\*\*(.+?)\*\*/);
  let title = bold ? bold[1] : text.split("\n")[0];
  title = title.trim();
  if (title.length > 120) title = title.slice(0, 120);
  return title;
}

export function parseFinding(comment) {
  return {
    id: comment.id,
    priority: parsePriority(comment.body),
    title: parseTitle(comment.body),
    path: comment.path ?? null,
    line: comment.line ?? comment.original_line ?? null,
    original_commit_id: comment.original_commit_id ?? null,
  };
}

export function countPriorities(findings) {
  const counts = { P1: 0, P2: 0, P3: 0, unrated: 0 };
  for (const f of findings) {
    if (f.priority === "P1") counts.P1++;
    else if (f.priority === "P2") counts.P2++;
    else if (f.priority === "P3") counts.P3++;
    else counts.unrated++;
  }
  return counts;
}

const EMPTY_COUNTS = { P1: 0, P2: 0, P3: 0, unrated: 0 };

// ---------------------------------------------------------------------
// One poll: checks PR head, reviews, issue comments, reactions in order.
// ---------------------------------------------------------------------

export async function pollOnce({ repo, pr, head, bot, since }, ghApi, sleep) {
  // 1. Superseded?
  const prData = await ghApi(`repos/${repo}/pulls/${pr}`);
  if (prData?.head?.sha !== head) {
    return { outcome: "superseded" };
  }

  // 2. Reviews on this head, by the bot.
  const reviews = await ghApi(`repos/${repo}/pulls/${pr}/reviews`);
  const botReview = (Array.isArray(reviews) ? reviews : []).find(
    (r) => r.user?.login === bot && r.commit_id === head
  );
  if (botReview) {
    let comments = await ghApi(
      `repos/${repo}/pulls/${pr}/reviews/${botReview.id}/comments`
    );
    if (!comments || comments.length === 0) {
      // Comments are created 0-1s after the review lands; give it one
      // more look before concluding the review is clean.
      await sleep(5000);
      comments = await ghApi(
        `repos/${repo}/pulls/${pr}/reviews/${botReview.id}/comments`
      );
    }
    const findings = (comments || []).map(parseFinding);
    return {
      outcome: "verdict",
      form: "review",
      clean: findings.length === 0,
      findings,
      counts: countPriorities(findings),
      review_id: botReview.id,
      url: botReview.html_url ?? null,
      verdict_at: botReview.submitted_at,
    };
  }

  // 3. Issue comments by the bot, after `since`.
  const issueComments = await ghApi(`repos/${repo}/issues/${pr}/comments`);
  const sinceMs = new Date(since).getTime();
  const botComments = (Array.isArray(issueComments) ? issueComments : [])
    .filter((c) => c.user?.login === bot && new Date(c.created_at).getTime() > sinceMs)
    .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  if (botComments.length > 0) {
    const comment = botComments[0];
    const body = String(comment.body || "");
    return {
      outcome: "verdict",
      form: "pr-comment",
      clean: null, // caller must read it; may be a usage-limit notice, not a verdict
      findings: [{ body: body.slice(0, 300) }],
      counts: EMPTY_COUNTS,
      review_id: null,
      url: comment.html_url ?? null,
      verdict_at: comment.created_at,
    };
  }

  // 4. Reactions by the bot, after `since`.
  const reactions = await ghApi(`repos/${repo}/issues/${pr}/reactions`);
  const botReactions = (Array.isArray(reactions) ? reactions : []).filter(
    (r) => r.user?.login === bot && new Date(r.created_at).getTime() > sinceMs
  );
  const thumbsUp = botReactions.find((r) => r.content === "+1");
  if (thumbsUp) {
    return {
      outcome: "verdict",
      form: "reaction",
      clean: true, // founder ruling: a bare 👍 with no review is a clean pass
      findings: [],
      counts: EMPTY_COUNTS,
      review_id: null,
      url: null,
      verdict_at: thumbsUp.created_at,
    };
  }
  const eyes = botReactions.find((r) => r.content === "eyes");
  if (eyes) {
    // Acknowledgement only, not a verdict: keep waiting.
    return { outcome: "ack", ack_at: eyes.created_at };
  }

  return { outcome: "none" };
}

// ---------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------

export function exitCodeFor(status) {
  switch (status) {
    case "verdict":
      return 0;
    case "timeout":
      return 2;
    case "superseded":
      return 3;
    case "error":
      return 1;
    default:
      return 1;
  }
}

function buildRecord(status, args, extra, ackAt, checks) {
  const verdictAt = extra?.verdict_at ?? null;
  const sinceMs = new Date(args.since).getTime();
  const latencyS = verdictAt
    ? (new Date(verdictAt).getTime() - sinceMs) / 1000
    : null;
  return {
    status,
    repo: args.repo,
    pr: args.pr,
    head: args.head,
    bot: args.bot,
    form: extra?.form ?? null,
    clean: extra?.clean ?? null,
    findings: extra?.findings ?? [],
    counts: extra?.counts ?? EMPTY_COUNTS,
    review_id: extra?.review_id ?? null,
    url: extra?.url ?? null,
    since: args.since,
    ack_at: ackAt,
    verdict_at: verdictAt,
    latency_s: latencyS,
    checks,
  };
}

export async function waitForVerdict(args, ghApi, opts = {}) {
  const sleep = opts.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const now = opts.now || (() => new Date());
  const stderr = opts.stderr || ((s) => process.stderr.write(s));

  const deadline = new Date(
    new Date(args.since).getTime() + args.deadlineMin * 60000
  );
  let ackAt = null;
  let failures = 0;
  const checks = [];

  // A poll always runs before the deadline is checked: --since is set to
  // when the caller started (e.g. right after the push), which is
  // typically already in the past by the time this loop gets going, and a
  // verdict that landed between `since` and process start must still be
  // seen on the first pass rather than timing out unpolled.
  for (;;) {
    const nowTs = now();
    let result;
    try {
      result = await pollOnce(args, ghApi, sleep);
      failures = 0;
    } catch (err) {
      failures++;
      stderr(`wait-for-verdict: gh api error: ${err.message}\n`);
      checks.push({ at: nowTs.toISOString(), error: err.message });
      if (failures >= 5) {
        return buildRecord("error", args, {}, ackAt, checks);
      }
      if (now().getTime() >= deadline.getTime()) {
        return buildRecord("timeout", args, {}, ackAt, checks);
      }
      await sleep(args.intervalS * 1000);
      continue;
    }

    checks.push({ at: nowTs.toISOString(), result: result.outcome });

    if (result.outcome === "superseded") {
      return buildRecord("superseded", args, {}, ackAt, checks);
    }
    if (result.outcome === "verdict") {
      return buildRecord("verdict", args, result, ackAt, checks);
    }
    if (result.outcome === "ack") {
      ackAt = result.ack_at;
    }

    if (now().getTime() >= deadline.getTime()) {
      return buildRecord("timeout", args, {}, ackAt, checks);
    }
    await sleep(args.intervalS * 1000);
  }
}

// ---------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------

export function appendLog(logPath, record) {
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.appendFileSync(logPath, JSON.stringify(record) + "\n");
}

// ---------------------------------------------------------------------
// CLI entry
// ---------------------------------------------------------------------

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`wait-for-verdict: ${err.message}\n`);
    process.exit(1);
  }
  const record = await waitForVerdict(args, defaultGhApi);
  appendLog(args.log, record);
  process.stdout.write(JSON.stringify(record) + "\n");
  process.exit(exitCodeFor(record.status));
}

const isMain =
  process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main();
}
