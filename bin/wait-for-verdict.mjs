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
import { pathToFileURL } from "node:url";

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
  if (!Number.isFinite(args.deadlineMin) || args.deadlineMin <= 0) {
    throw new Error("--deadline-min must be a finite positive number");
  }
  if (!Number.isFinite(args.intervalS) || args.intervalS <= 0) {
    throw new Error("--interval-s must be a finite positive number");
  }
  if (args.since !== undefined && !Number.isFinite(Date.parse(args.since))) {
    throw new Error("--since must be a valid timestamp");
  }
  // No default here: an explicit --since is "arg"; a missing one is
  // resolved async, against the head commit's own committer date
  // (resolveSince), since that needs a network call parseArgs can't
  // make.
  args.sinceSource = args.since !== undefined ? "arg" : null;
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

// An explicit --since is used as given. Otherwise, defaulting to the
// waiter's own start time missed a verdict reaction the bot left
// between the push and the waiter actually starting (a real gap: the
// caller pushes, then starts this in the background, seconds to
// minutes later). A commit's committer date is always at or before it
// was pushed, so using it as `since` covers that whole gap instead --
// BUT a committer date is not itself a push time: a commit made
// locally well before it was ever pushed (or reused across an amended
// push) can sit far in the past, which would wrongly credit a bot
// reaction left on an entirely earlier head/review cycle (codex
// review, PR #5: a stale `+1` between an old commit date and a much
// later push could pass the filter as if it reviewed the new head).
// So the commit date is clamped to no more than MAX_SINCE_LOOKBACK_MS
// before "now" -- generous enough to cover a normal push-to-waiter-
// start gap, bounded enough that an old commit can't reach back into
// a previous review cycle. Also clamped to never be AFTER "now": a
// future committer timestamp (contributor clock skew, an overridden
// GIT_COMMITTER_DATE) would otherwise make every real reaction fail
// the `created_at > since` filter for the entire run, turning a clean
// reaction verdict into a timeout (codex review, PR #5). Falls back to
// (now - 120s) if the commit lookup fails for any reason (network, a
// head that isn't a real commit, malformed response).
const MAX_SINCE_LOOKBACK_MS = 10 * 60 * 1000;

export async function resolveSince(args, ghApi, now) {
  if (args.since !== undefined) {
    return { since: args.since, sinceSource: "arg" };
  }
  const nowMs = now();
  try {
    const commit = await ghApi(`repos/${args.repo}/commits/${args.head}`);
    const committerDate = commit?.commit?.committer?.date;
    if (!committerDate || !Number.isFinite(Date.parse(committerDate))) {
      throw new Error("no usable committer date");
    }
    const committerMs = Date.parse(committerDate);
    const boundedMs = Math.min(nowMs, Math.max(committerMs, nowMs - MAX_SINCE_LOOKBACK_MS));
    return { since: new Date(boundedMs).toISOString(), sinceSource: "head-commit" };
  } catch {
    return {
      since: new Date(nowMs - 120000).toISOString(),
      sinceSource: "fallback",
    };
  }
}

// ---------------------------------------------------------------------
// gh API (injectable for tests)
// ---------------------------------------------------------------------

export function defaultGhApi(endpoint) {
  const res = spawnSync("gh", ["api", "--paginate", endpoint], {
    encoding: "utf8",
    timeout: 60000,
  });
  if (res.error || res.signal) {
    // A stalled DNS/TLS/HTTP call is killed after 60s rather than
    // hanging the process forever with control never returning to the
    // loop that enforces --deadline-min; treated as an ordinary
    // transient failure, same as a non-zero exit, so it counts toward
    // the 5-consecutive-failures error exit.
    throw new Error(
      `gh api ${endpoint} did not complete (${res.signal ?? res.error?.code ?? "timeout"})`
    );
  }
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

// GitHub's own timestamps carry no milliseconds; `since` sometimes does
// (a plain `new Date().toISOString()`), so comparing at millisecond
// precision can read an event landing in the same whole second as
// `since` as either side of it depending on where the milliseconds
// happened to fall. Flooring both sides to the second removes that.
function flooredMs(isoString) {
  return Math.floor(new Date(isoString).getTime() / 1000) * 1000;
}

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
      // A review can carry its finding in the body/state alone, with no
      // inline comments (e.g. a bot that requests changes in prose) --
      // an empty comment list is clean only when the review itself
      // isn't a blocking one.
      clean: findings.length === 0 && botReview.state !== "CHANGES_REQUESTED",
      findings,
      counts: countPriorities(findings),
      review_id: botReview.id,
      url: botReview.html_url ?? null,
      reaction_target: null,
      review_state: botReview.state ?? null,
      review_body: botReview.body ? String(botReview.body).slice(0, 300) : null,
      verdict_at: botReview.submitted_at,
      reactions_ignored: reactionsIgnored,
    };
  }

  // 3. Issue comments by the bot, after `since`.
  const issueComments = await ghApi(`repos/${repo}/issues/${pr}/comments`);
  const sinceMs = flooredMs(since);
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
      review_state: null,
      review_body: null,
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

    // Scanned whenever either reaction is enabled and no verdict
    // reaction has been found yet -- an ack-only caller
    // (--verdict-reaction none --ack-reaction eyes) still needs the
    // trigger comment scanned for its own eyes reaction, not just a
    // caller waiting on the verdict reaction. Short-circuited entirely
    // once thumbsUp is already known (from the PR-level check above, or
    // set inside this loop): a found verdict reaction is returned
    // regardless of eyes, so a failing comment-reactions call on a
    // LATER comment must not turn an already-found verdict into an
    // `error` outcome.
    if (!thumbsUp && (vr !== "none" || ar !== "none")) {
      const windowStartMs = sinceMs - effectiveDeadlineMin * 60000;
      const recentComments = (Array.isArray(issueComments) ? issueComments : []).filter(
        (c) => new Date(c.created_at).getTime() >= windowStartMs
      );
      for (const c of recentComments) {
        if (thumbsUp) break;
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
      review_state: null,
      review_body: null,
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
    review_state: extra?.review_state ?? null,
    review_body: extra?.review_body ?? null,
    since: args.since,
    since_source: args.sinceSource ?? null,
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

  // The deadline is anchored to when THIS run actually started, never
  // to `since` -- `since` can be a commit's committer date (resolveSince),
  // arbitrarily far in the past for a commit that sat around locally
  // before being pushed, and anchoring the deadline to it made
  // waitForVerdict time out on its very first poll (codex review, PR
  // #5).
  const deadline = new Date(now().getTime() + args.deadlineMin * 60000);
  let ackAt = null;
  let failures = 0;
  const checks = [];

  // A poll always runs before the deadline is checked: a verdict that
  // landed between `since` and this process's own start must still be
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
  const resolved = await resolveSince(args, defaultGhApi, Date.now);
  args.since = resolved.since;
  args.sinceSource = resolved.sinceSource;
  const record = await waitForVerdict(args, defaultGhApi);
  appendLog(args.log, record);
  // process.exit() right after write() can cut a large line short when
  // stdout is a pipe (the write is async under the hood); setting
  // exitCode and awaiting the write's own callback lets Node flush
  // before it exits on its own.
  process.exitCode = exitCodeFor(record.status);
  await new Promise((resolve, reject) => {
    process.stdout.write(JSON.stringify(record) + "\n", (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

// A manually built `file://${process.argv[1]}` string doesn't match
// import.meta.url whenever the path needs URL escaping (spaces, etc.)
// or is reached through a symlink (Node resolves module URLs to the
// real path) -- both silently made this guard false and skipped
// main() entirely with no error, no log line, no output. Resolving
// through pathToFileURL and realpathSync makes both sides comparable.
let isMain = false;
if (process.argv[1]) {
  try {
    isMain = import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href;
  } catch {
    isMain = false;
  }
}
if (isMain) {
  main();
}
