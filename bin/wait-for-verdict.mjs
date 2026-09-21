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

// The reaction that counts as a clean verdict, and the one that counts
// as an acknowledgement-only, are bot-specific (rule 21/5's "bot
// profile"). Codex's are known; any other bot defaults to "none" for
// both, meaning reactions are never treated as a verdict for it unless
// the caller passes --verdict-reaction/--ack-reaction explicitly.
export function resolveReactions(bot, verdictReaction, ackReaction) {
  const isCodex = bot === DEFAULT_BOT;
  const vr = verdictReaction ?? (isCodex ? "+1" : "none");
  const ar = ackReaction ?? (isCodex ? "eyes" : "none");
  return {
    verdictReaction: vr,
    ackReaction: ar,
    reactionsIgnored: vr === "none" && ar === "none",
  };
}

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
      case "--verdict-reaction":
        args.verdictReaction = argv[++i];
        break;
      case "--ack-reaction":
        args.ackReaction = argv[++i];
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
  const resolved = resolveReactions(args.bot, args.verdictReaction, args.ackReaction);
  args.verdictReaction = resolved.verdictReaction;
  args.ackReaction = resolved.ackReaction;
  args.reactionsIgnored = resolved.reactionsIgnored;
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

function stripMarkup(text) {
  return text
    .replace(/<\/?sub>/gi, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "");
}

export function parseTitle(body) {
  const text = stripMarkup(String(body || ""));
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

export async function pollOnce(
  { repo, pr, head, bot, since, verdictReaction, ackReaction, deadlineMin },
  ghApi,
  sleep
) {
  const resolved = resolveReactions(bot, verdictReaction, ackReaction);
  const vr = resolved.verdictReaction;
  const ar = resolved.ackReaction;
  const reactionsIgnored = resolved.reactionsIgnored;
  const effectiveDeadlineMin = deadlineMin ?? DEFAULT_DEADLINE_MIN;

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
      reaction_target: null,
      verdict_at: botReview.submitted_at,
      reactions_ignored: reactionsIgnored,
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
      reaction_target: null,
      verdict_at: comment.created_at,
      reactions_ignored: reactionsIgnored,
    };
  }

  // 4. Reactions by the bot, after `since`, using the bot's configured
  // verdict/ack reaction content (rule 21/5's "bot profile" — codex's
  // are known; any other bot ignores reactions by default unless told
  // otherwise via --verdict-reaction/--ack-reaction). Checked at the PR
  // level, and also on every issue comment created after `since`
  // (reusing the list already fetched in step 3): when codex is
  // triggered by an "@codex review" comment, its verdict reaction can
  // land on that trigger comment instead of on the PR itself.
  //
  // The trigger comment itself is very often posted BEFORE `since`
  // (the caller posts "@codex review", then starts the waiter with
  // --since defaulting to that start time) -- so the comment is
  // scanned by a window reaching back `deadlineMin` minutes before
  // `since`, wide enough to catch any trigger comment posted within
  // this run's own deadline. The REACTION itself is still required to
  // be after `since`, which is what stops an old verdict from
  // counting.
  const prUrl = `https://github.com/${repo}/pull/${pr}`;
  let thumbsUp = null;
  let eyes = null;
  let thumbsUpTarget = null; // "pr" | "comment"
  let thumbsUpUrl = null;
  let eyesUrl = null;

  if (!reactionsIgnored) {
    const reactions = await ghApi(`repos/${repo}/issues/${pr}/reactions`);
    const botReactions = (Array.isArray(reactions) ? reactions : []).filter(
      (r) => r.user?.login === bot && new Date(r.created_at).getTime() > sinceMs
    );
    if (vr !== "none") thumbsUp = botReactions.find((r) => r.content === vr);
    if (ar !== "none") eyes = botReactions.find((r) => r.content === ar);
    if (thumbsUp) {
      thumbsUpTarget = "pr";
      thumbsUpUrl = prUrl;
    }
    if (eyes) eyesUrl = prUrl;

    // Scanned whenever either reaction is enabled -- an ack-only caller
    // (--verdict-reaction none --ack-reaction eyes) still needs the
    // trigger comment scanned for its own eyes reaction, not just a
    // caller waiting on the verdict reaction.
    if ((!thumbsUp || !eyes) && (vr !== "none" || ar !== "none")) {
      const windowStartMs = sinceMs - effectiveDeadlineMin * 60000;
      const recentComments = (Array.isArray(issueComments) ? issueComments : []).filter(
        (c) => new Date(c.created_at).getTime() >= windowStartMs
      );
      for (const c of recentComments) {
        if (thumbsUp && eyes) break;
        const commentReactions = await ghApi(
          `repos/${repo}/issues/comments/${c.id}/reactions`
        );
        const botCommentReactions = (
          Array.isArray(commentReactions) ? commentReactions : []
        ).filter((r) => r.user?.login === bot && new Date(r.created_at).getTime() > sinceMs);
        if (!thumbsUp && vr !== "none") {
          const tu = botCommentReactions.find((r) => r.content === vr);
          if (tu) {
            thumbsUp = tu;
            thumbsUpTarget = "comment";
            thumbsUpUrl = c.html_url ?? null;
          }
        }
        if (!eyes && ar !== "none") {
          const e = botCommentReactions.find((r) => r.content === ar);
          if (e) {
            eyes = e;
            eyesUrl = c.html_url ?? null;
          }
        }
      }
    }
  }

  if (thumbsUp) {
    return {
      outcome: "verdict",
      form: "reaction",
      clean: true, // founder ruling: a bare 👍 (or the configured verdict reaction) with no review is a clean pass
      findings: [],
      counts: EMPTY_COUNTS,
      review_id: null,
      url: thumbsUpUrl,
      reaction_target: thumbsUpTarget,
      verdict_at: thumbsUp.created_at,
      reactions_ignored: reactionsIgnored,
    };
  }
  if (eyes) {
    // Acknowledgement only, not a verdict: keep waiting.
    return { outcome: "ack", ack_at: eyes.created_at, reactions_ignored: reactionsIgnored };
  }

  return { outcome: "none", reactions_ignored: reactionsIgnored };
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
  const reactionsIgnored =
    extra?.reactions_ignored ??
    resolveReactions(args.bot, args.verdictReaction, args.ackReaction).reactionsIgnored;
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
    reaction_target: extra?.reaction_target ?? null,
    since: args.since,
    ack_at: ackAt,
    verdict_at: verdictAt,
    latency_s: latencyS,
    reactions_ignored: reactionsIgnored,
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
