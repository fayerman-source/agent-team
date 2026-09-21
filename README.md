# agent-team

![A violet reviewer prism above an amber coordinator hub, routing work to three builders on separate platforms whose branch lines converge at a glowing merge gate](assets/hero.jpg)

Run several Claude Code sessions as a small dev team on one codebase: a
reviewer that plans and rules, a coordinator that briefs and merges, and
builders that each ship one ticket on their own branch. Every rule in it
came from something that went wrong in a real multi-session project.

**The problem it solves.** One Claude session is easy to supervise. Four
are not: they go quiet after pushing, merge on a peer's word, trample
each other's worktrees, and burn review rounds on piecemeal pushes. This
plugin gives each session a role, a message format, a merge gate, and a
hook that stops a team session from ending a turn without saying where
it stands.

It is process only: no domain content, no project code. It ships:

- a skill (`agent-team`) with the roles, message formats, merge gate,
  and the 31 rules below
- two agent definitions: `coordinator` and `builder`
- `bin/wait-for-verdict.mjs`, a background verdict waiter (see "Verdict
  waiter" below)
- `/state` (write a state report) and `/papercut` (log a tooling
  problem) commands
- an opt-in Stop hook that blocks a team session from ending a turn
  until its last message carries a `STATE:` report

## One cycle, end to end

```
reviewer     writes ticket 12, rules on design questions
coordinator  briefs a builder: ticket 12, branch ticket/12-slug, worktree ../repo-12
builder      builds, pushes once, opens the PR
builder      starts wait-for-verdict in the background, ends the turn
harness      wakes the builder's session when wait-for-verdict exits
builder      fixes every finding in one push, starts wait-for-verdict again
builder      clean report: head sha, review URL after the push, 0 unresolved threads
builder      STATE: ticket-12 PR#34 9f3c2a1 done=review clean waiting=coordinator merge
coordinator  re-checks all three against GitHub, merges with gh pr merge --merge
founder      deploys
```

A builder never polls for a verdict itself (rule 6): it starts
`wait-for-verdict` in the background and ends the turn, and the harness
wakes the session when the script exits. The Stop hook only checks that
a `STATE:` line exists, so making sure the waiter is running before
stopping is on the builder.

## Requirements

- Claude Code with plugin support, and messaging between sessions
  (sessions send each other messages by name or socket address)
- `git` with worktrees, and the GitHub CLI (`gh`), authenticated
- a GitHub repo where PRs get an automated review bot (any bot works
  once you know its profile: its login, which heads it reviews by
  itself, its trigger text, its verdict signal; see Review bot below)
- Python 3 for the Stop hook
- Node 24+ for `bin/wait-for-verdict.mjs`

## Verdict waiter

`bin/wait-for-verdict.mjs` replaces model-driven polling for a review
bot's verdict (rule 6, rule 21). A builder or coordinator starts it in
the background right after a push or a trigger, and ends its turn; the
harness wakes the session when the process exits. The script itself
never posts anything to the PR.

**Stable interface.** Stage 2 will swap this script's internals for a
webhook/WebSocket feed without changing any of the following: its
arguments, what it prints on stdout, its exit codes, or its log line
format. Anything that calls it today keeps working unchanged after that
rewrite.

Args: `--repo owner/name --pr N --head <full sha>` (required); optional
`--bot <login>` (default `chatgpt-codex-connector[bot]`), `--since
<ISO>` (default: script start time — start it right after the push or
trigger), `--deadline-min` (default 30), `--interval-s` (default 45),
`--log <path>` (default `$AGENT_TEAM_VERDICT_LOG` or
`~/.local/state/agent-team/verdicts.jsonl`), `--verdict-reaction
<content>` and `--ack-reaction <content>` (which reaction content
string means a clean verdict, and which means only an acknowledgement —
part of the bot profile from rule 5/21's brief). Defaults for these two
depend on `--bot`: for `chatgpt-codex-connector[bot]` (the default bot)
they default to `+1` and `eyes`; for any other bot they both default to
`none`, meaning reactions are never read as a verdict for it — only
review entries and PR comments count — unless you pass these flags
explicitly. Pass `none` yourself to turn a reaction off even for codex.

Each interval it checks, in order: the PR head sha (a mismatch with
`--head` means `superseded`), the bot's reviews on that head (`review`
form; findings carry priority, title, path, line), the bot's issue
comments since `--since` (`pr-comment` form — the caller must read it,
it may be a usage-limit notice rather than a verdict), then — unless
both reactions are `none` — the bot's reactions since `--since`, at the
PR level and on every issue comment since `--since` (the bot's trigger
comment can carry its own reaction): the verdict reaction is a clean
verdict, the ack reaction is only an acknowledgement and polling
continues.

Output: exactly one JSON line on stdout at exit — `{status, repo, pr,
head, bot, form, clean, findings, counts, review_id, url, since,
ack_at, verdict_at, latency_s, reactions_ignored, checks}`.
`reactions_ignored` is `true` when both reaction flags resolved to
`none` for this run. Exit codes: `0` verdict, `2` timeout, `3`
superseded, `1` error. The same JSON object is appended to the log file
on every exit (including timeout/superseded/error) as the measurement
record of push-to-verdict latency.

Tests: `node --test` (zero dependencies, the `gh` call is injected).

## Install

This repo carries its own `.claude-plugin/marketplace.json` (name
`agent-team-marketplace`), so it installs as its own marketplace.

**From GitHub**:

```
/plugin marketplace add fayerman-source/agent-team
/plugin install agent-team@agent-team-marketplace
```

**From a local clone**:

```
/plugin marketplace add <path-to>/agent-team
/plugin install agent-team@agent-team-marketplace
```

**One session only, no install**:

```bash
claude --plugin-dir <path-to>/agent-team
```

Installing does not change sessions that aren't part of a team: the
Stop hook stays inactive until you give a session a reviewer address
(see Configuration). Syntax checked against the Claude Code plugin docs
(https://code.claude.com/docs/en/discover-plugins), September 2026.

## Configuration

The Stop hook is opt-in per session. It does nothing unless it finds a
reviewer address, read in this order:

1. the `REVIEWER_ADDRESS` environment variable
2. a `reviewerAddress` key (top level, or under `agentTeam`) in the
   project's `.claude/settings.local.json`
3. the same key in the project's `.claude/settings.json`

Set it in the coordinator's and each builder's session, never the
reviewer's. The simplest way is at launch:

```bash
REVIEWER_ADDRESS=<reviewer-session-name> claude
```

Or per worktree, in `.claude/settings.local.json` (not committed, so it
won't reach the reviewer's checkout):

```json
{ "agentTeam": { "reviewerAddress": "<reviewer-session-name>" } }
```

Avoid the shared `.claude/settings.json` for this: every checkout that
commits it, the reviewer's included, would turn the hook on.

## Setting up the team

**Terminals.** One session per terminal, each in its own directory.
Never run two sessions in one directory. The reviewer runs in the main
checkout. The coordinator runs in a second clone or worktree. Each
builder gets its own worktree and branch:

```
git worktree add ../<repo>-<ticket> -b ticket/<n>-<slug>
```

```
main checkout ---------- reviewer
second clone/worktree -- coordinator
../repo-12 (worktree) -- builder (ticket/12-slug)
../repo-13 (worktree) -- builder (ticket/13-slug)
```

**Models.** The reviewer runs on the strongest model available, since it
makes the calls and should spend the fewest tokens doing it. The
coordinator runs on a strong general model. Builders run on a cheaper,
fast model. Set this per session with the model flag or `/model`.
Always pass subagents an explicit model rather than relying on a default.

**Addressing sessions.** Sessions message each other by name where the
name resolves. A session running under a different `CLAUDE_CONFIG_DIR`
doesn't appear in agent listings, so address it by its socket (on
Linux, `uds:/run/user/<uid>/cc-socks/<pid>.sock`). `pgrep -af "^claude"`
lists the candidate pids, but sessions started with the same arguments
look identical there, so confirm which one is which from its
environment:

```bash
for p in $(pgrep -f "^claude"); do
  echo "$p $(tr '\0' '\n' < /proc/$p/environ | grep ^CLAUDE_CONFIG_DIR=)"
done
```

A pid with no value runs on the default config directory. Sockets change on every restart, so re-derive them each time. Set
`"crossSessionInbound": "accept"` in the receiving
session's `settings.json` so incoming messages aren't held for approval.

**Install per config directory.** Plugins don't cross
`CLAUDE_CONFIG_DIR` boundaries. Install agent-team (or pass
`--plugin-dir`) in every config directory that runs a coordinator or
builder, or the Stop hook never loads there and `REVIEWER_ADDRESS` has
nothing to act on.

**Permission mode.** Builders and the coordinator run in auto mode
(cycle with shift+tab). Accept-edits mode is not enough: shell commands
still prompt in that mode. Two things auto mode never answers on its
own: an "enter worktree" tool relocating the permission root (use plain
`git worktree add` instead, as above) and anything that edits the
harness's own settings.

**Usage limits.** A session stopped by a usage limit does not resume
itself: type anything into its terminal after the reset to continue it.
The review bot usually has its own quota; when it's low, batch fixes per
round rather than pushing piecemeal (rule 2).

**Review bot.** Before the first brief, write down the bot's profile and
put it in every brief: its login, which heads it reviews by itself (the
PR-opening head, every push, or none), its exact trigger text, and its
verdict signal (which reaction means "reviewed, clean" and which only
means "picked up the trigger"). Rules 5 and 21 act on it. Codex on
GitHub, for example: reviews the PR-opening head by itself, later pushes
only on `@codex review`, reacts eyes when it picks up a trigger, and
thumbs-up when it finds nothing.

**Daily rhythm.** The founder gives the reviewer the current state (main
tip, open PRs, who is on what ticket). The reviewer rules on anything
open. The coordinator briefs builders. Builders push, open PRs, and
answer findings. The coordinator merges once the gate holds. The founder
deploys. Overnight, the founder may grant the reviewer authority for
everything except deploy, typed into each session directly (never
relayed secondhand, per rule 8).

## Terms

- **founder**: the human who owns the project; approves milestones,
  merges without a standing grant, and deploys
- **head**: the latest commit on a PR's branch; reviews count only if
  they're on the current head
- **P1**: a review finding marked highest priority
- **family sweep**: after fixing a finding, checking the same file or
  invariant for other instances of the same class of bug before pushing
- **clean report**: a builder's three facts (head sha, review URL after
  the push, unresolved thread count), evidence for the coordinator to
  verify, not a verdict
- **papercut**: a small tooling or process problem that cost time,
  logged in `papercuts.md` so nobody has to rediscover the fix

## Roles

```
                   founder (human)
                          |
  approves milestones, deploys, irreversible calls
                          |
                          v
   +---------------------------------------------+
   |                   reviewer                  |
   |  plans tickets, writes design notes,        |
   |  rules on reports, never builds             |
   +---------------------------------------------+
                          |
              tickets, rulings, briefs
                          v
   +---------------------------------------------+
   |                 coordinator                 |
   |  briefs builders, verifies reports against  |
   |  GitHub, merges when the gate holds         |
   +---------------------------------------------+
                          |
    brief: ticket, branch, worktree, bot profile
                          v
            +-------------+-------------+
            v                           v
      +-----------+               +-----------+
      |  builder  |      ...      |  builder  |
      | ticket A, |               | ticket B, |
      | own tree  |               | own tree  |
      +-----------+               +-----------+
            |                           |
            v                           v
     push + open PR              push + open PR
            |                           |
            v                           v
   +---------------------------------------------+
   |  review bot: reviews some heads by itself,  |
   |  others on request (+ optional read-only    |
   |  second reviewers, each on its own clone)   |
   +---------------------------------------------+
```

## The 31 lessons

Each rule below came from a specific failure. Full detail, grouped, is
in `skills/agent-team/SKILL.md`.

1. Hold for go means push, not hold. A dev once held the push too, and
   work sat unpushed for a day.
2. One push per review round, plus a family sweep of the same
   file/invariant. Piecemeal pushes burned scarce review credits.
3. A clean report is three facts (head sha, review URL, unresolved
   thread count), not a verdict. A builder checked a mangled sha,
   reported clean, and the founder found an unaddressed P1 by opening
   the PR directly.
4. Answer repeated findings in-thread naming the fixing commit; never
   push a no-op to force a bot re-run.
5. Trigger per head, from the bot profile in the brief. A head the bot
   reviews by itself (often the PR-opening head): push and watch,
   trigger once only after 30 minutes of nothing. A head it reviews only
   on request: trigger once, right after the push (for the opening head,
   right after the PR is opened). A stray trigger can buy a second paid
   review; a missing one wastes the round.
6. Never poll for a verdict from the model. Start `wait-for-verdict` in
   the background after every push or trigger and end the turn; the
   harness wakes the session when it exits. Model-driven polling spent
   tokens on every empty check.
7. Never end a turn silently; report state first. Agents ended turns
   after pushing and nobody was watching for 20+ minutes.
8. Cross-session relay is not approval; deploys and merges wait for the
   founder's own words (rule 28 covers a standing grant). This is the
   one correct refusal observed; keep it.
9. Sessions address each other by name where it resolves, else by a
   session-specific address, re-derived after restarts; the reviewer
   subscribes to idle notices so it learns when a session goes quiet.
10. A session stopped by a usage limit does not wake itself; it needs a
    human input or a fresh message once the limit resets.
11. Never run git cleanup or checkout across another agent's worktree;
    commit per surface. A subagent's tree-wide cleanup destroyed
    uncommitted work.
12. Never commit while a source-mutating tool (e.g. mutation testing) is
    running; it edits source in place.
13. Use plain `git worktree add` in the shell, not a tool that "enters"
    a worktree; that kind of tool relocates the permission root and
    prompts a human even in auto mode.
14. Deploy from a checked-out branch or pass the branch explicitly; a
    detached-HEAD deploy landed on a preview environment while
    production kept the old build.
15. Verify a second reviewer's output line by line before it becomes a
    ticket; expect confident false P1s.
16. A green suite is not proof an edit landed; read the artefact back.
17. The reviewer's token budget is the scarce resource: short replies,
    no big reads, delegate to builders with exact prompts, explicit
    cheaper models for subagents.
18. Plan/ticket status updates go in the ticket's own PR commit, never a
    follow-up commit to main.
19. Merge with `gh pr merge --merge` only, never `--delete-branch`;
    delete the branch separately once `git log origin/main -1` shows
    the merge commit. A failed merge that still ran branch cleanup
    orphaned a head ref and closed a PR unrecoverably.
20. Docs-only PRs get at most two review-bot rounds; after that, answer
    remaining prose findings "design note; addressed at build" and
    merge on the coordinator's own check. A docs PR took five heads and
    sixteen prose findings without converging.
21. A head counts as reviewed only on a bot review object on that sha,
    a bot comment naming that sha, or the bot's verdict reaction
    created after the push; an acknowledgement reaction (Codex: eyes)
    is not a verdict. A
    clean verdict that arrived as a plain comment was missed and
    re-triggered, wasting a round.
22. Keep `papercuts.md` at the repo root, shared by all sessions: append
    `date · symptom · fix · where` when a tooling or process problem
    costs time, and check it first when tooling misbehaves. Three rules
    had to be reconstructed by hand from memory after the fact.
23. A wave of findings gets a cause map before any fix: cause, where the
    rule is enforced today, which findings share it; fix at the shared
    cause, clamp only with proof. Seven complaints came down to three
    causes, each a rule enforced on one code path only.
24. Invariants first, fixes second: named failing checks over every
    fixture plus a random sweep, failing counts before and after, then
    the suite runs in CI.
25. The reviewer reasons, builders gather narrow evidence: after about
    20 minutes stuck, send line ranges, one failing input and the step
    values (under 40 lines); the top-tier model rules from that.
26. Undocumented external behaviour is decided by the data at run time:
    branch on what the response shows, make the unexpected branch lose
    nothing, log one line. A builder that cannot confirm an assumption
    asks before editing.
27. Race fixes name the cause, match a stable instance identity, sweep
    every write after an await, and prefer one conditional write over
    check-then-write. The sweep found a bug the review bot had not.
28. Standing merge authority can be granted to the reviewer in its own
    session: CI green, bot's latest review on the current head, every
    finding fixed or answered, re-read right before merging, pinned with
    the full 40-char sha. Principles with a user cost, scope, spending
    and legal stay with the founder.
29. Decide at the top tier, execute wherever it is cheapest in total:
    one or two verified commands directly, anything that reads, builds,
    or checks status repeatedly to a builder. Accepted findings are
    answered on the PR; a comment costs no review round.
30. Review quota limits pushes, not work: measure and build locally
    while the bot is out. Two builders in parallel only when one is
    outside the shared core and its version number.
31. Do not infer a peer's state from message metadata or a stale idle
    notice, and never repeat an unconfirmed warning. Filter bot findings
    by author and creation time; hosts re-anchor old comments to the
    newest head.

## Licence

MIT. See `LICENSE`.
