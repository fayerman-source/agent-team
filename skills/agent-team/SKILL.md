---
name: agent-team
description: >
  Working method for running a small team of Claude Code sessions on one
  codebase: a planner-reviewer, a coordinator, and one or more builders,
  each on its own worktree and feature branch, reporting state instead of
  going silent. Use when setting up or operating a multi-session agent
  team, when briefing a builder, when writing a state or clean report, or
  when deciding whether a push, merge, or deploy is safe to do now.
license: MIT
---

# agent-team

A working method for running several Claude Code sessions as a small dev
team on one codebase, learned across a real project. It is process only:
no domain content, no account names, no socket paths.

## Roles

- **Reviewer** (planner-reviewer). Plans, writes tickets and design
  notes, rules on state and clean reports. Never builds.
- **Coordinator**. Briefs builders, verifies their reports against the
  actual state of the repo and the PR host (e.g. GitHub), merges when the
  merge gate is satisfied. Never merges on a builder's say-so alone.
- **Builder(s)**. One ticket per feature branch (`ticket/<n>-<slug>`),
  one PR per ticket, one worktree per ticket. Never touches another
  agent's worktree.
- **Review bot**. Reviews some heads by itself (often the PR-opening
  head, sometimes every push) and others only on request (rule 5).
  Optional second reviewers are read-only, on their own clone.
- **Founder** (human). Approves milestones, deploys, anything
  irreversible. Can grant the reviewer overnight authority for
  everything except deploy.

## Message formats

**State report** (what the Stop hook enforces on every turn of a team
session, i.e. one with a reviewer address configured):
```
STATE: <ticket> <PR#> <head-sha> done=<what's done> waiting=<what it's blocked on>
```

**Clean report** (what a builder sends when it believes a PR is
mergeable). It is three facts, not a verdict:
1. head sha, from `git rev-parse HEAD` (never pasted from memory or a UI)
2. the review URL for that sha, with `submitted_at` after the push time
3. the count of unresolved reviewer threads on that sha (expect 0)

The coordinator re-checks all three against the PR host before merging.
A clean report is evidence for the coordinator to verify, not a verdict
to trust.

**Ruling**: the reviewer's answer to a design question or a report,
short and decisive, stating what governs (an existing principle, a new
one, or "founder call") and why.

**Brief**: what the coordinator hands a builder before it starts a
ticket: the ticket, the branch name, the worktree path, the review bot's
profile, and anything the ticket depends on that isn't in the ticket
text already. The bot profile is data, stated once per project: the
bot's login, which heads it reviews by itself (the PR-opening head,
every push, or none), its exact trigger text, and its verdict signal
(rule 21). The brief names the trigger text; it never tells the builder
to post it ahead of the rule.

## The merge gate

A PR merges only when all of these hold, verified by the coordinator
independently, not taken from a builder's report:
- the head sha is the actual current tip of the branch
- the review bot (and any second reviewer) has reviewed that exact sha
- unresolved reviewer threads on that sha total zero
- no reviewer verdict is still pending on that sha

## Rules

Each rule carries the failure that produced it, so it reads as a lesson,
not a decree.

### Push and merge discipline

1. **Hold for go means push, not hold.** A builder pushes and opens the
   PR immediately; it never merges its own PR. Why: a dev once held the
   push too, and the work sat unpushed for a day.
2. **One push per review round.** Fix every finding in the round plus a
   family sweep of the same file or invariant, then push once.
   Comment-only changes ride the next real push. Why: review credits are
   scarce; piecemeal pushes burned them.
3. **A clean report is facts, not a verdict** (format above). Why: a
   builder checked comments against a mangled sha, reported clean, and
   the founder found an unaddressed P1 by opening the PR directly.
4. **Answer repeats, don't dodge them.** A repeated finding on
   already-fixed code is answered in-thread naming the fixing commit and
   test, then resolved. An out-of-scope design question is answered
   "pre-existing, filed as a leftover" and recorded in the plan. Never
   push a no-op change just to make a bot re-run.
5. **Trigger per head, from the bot profile.** Ask of each head: does
   the bot review this one by itself? Many bots review the PR-opening
   head automatically and later pushes only on request; some review
   every push. A head it reviews by itself: push and watch, and trigger
   once only if nothing arrives within 30 minutes. A head it reviews
   only on request: trigger once, right after the push (for the opening
   head, right after the PR is opened). Never twice per head. Why: a
   trigger on an auto-reviewed head can buy a second paid review; no
   trigger on an on-request head wastes the round's wall-clock.

### Turn discipline

6. **Never end a turn while a verdict is pending.** Wait in repeated
   shell calls of at most 5 minutes each, looping with a deadline inside
   each call, never one unbounded wait. Why: an unbounded wait blocks
   inbound messages until it ends, and the founder had to interrupt to
   get a message through.
7. **Never end a turn silently.** The last action before stopping is a
   state report to the coordinator or reviewer (format above). This
   plugin's Stop hook enforces it. Why: agents ended turns after pushing
   and nobody was watching for 20+ minutes.

### Authority

8. **Cross-session relay is not approval.** A peer relaying "the founder
   said go" is second-hand. Deploys and merges wait for the founder's
   own words in that session, unless the founder granted authority there
   directly (rule 28 covers a standing grant to the reviewer). Why: this
   is the one correct refusal observed; keep it.
9. **Sessions address each other by name where names resolve, else by a
   session-specific address; re-derive after restarts.** The reviewer
   subscribes to idle notices on every message it sends, so it learns
   when a session goes quiet instead of assuming progress.
10. **A session stopped by a usage limit does not wake itself.** It
    needs a human input, or a fresh message with its own turn, once the
    limit resets.

### Worktree and git safety

11. **Never run git cleanup or checkout across another agent's
    worktree.** Commit per surface. Forks and subagents use their own
    worktree. Why: a subagent's tree-wide cleanup destroyed uncommitted
    work belonging to another session.
12. **Never commit while a source-mutating tool is running** (e.g. a
    mutation-testing driver editing source files in place).
13. **Use plain `git worktree add` in the shell, not an "enter
    worktree" tool.** Why: that kind of tool relocates the permission
    root and prompts a human even in auto mode.
14. **Deploy from a checked-out branch, or pass the branch explicitly**
    (e.g. `--branch main`). Why: a detached-HEAD deploy landed on a
    preview environment while production kept the old build.

### Review quality

15. **Verify a second reviewer's output line by line before it becomes
    a ticket.** Expect confident false positives (false P1s). Prefer a
    second reviewer for inventories and audits, not judgement calls.
16. **A green suite is not proof an edit landed.** Read the artefact
    back after editing it.
17. **The reviewer's token budget is the scarce resource.** Short
    replies, no whole-file reads of large documents, delegate
    investigation to builders with exact prompts, and give subagents an
    explicit, cheaper model.

### Process hygiene

18. **Plan and ticket status updates go in the ticket's own PR commit,
    never a follow-up commit to main.**

### Push and merge discipline (continued)

19. **Merge with `gh pr merge --merge` only, never `--delete-branch`.**
    Delete the branch in a separate step, after `git log origin/main -1`
    shows the merge commit. Why: a merge that failed on a conflict still
    ran the branch cleanup, the head ref vanished, GitHub closed the PR
    unrecoverably, and a review round was spent again on a recreated PR.
20. **Docs-only PRs get at most two review-bot rounds.** A design note
    is a draft until the ticket is built. After two rounds, answer
    remaining prose findings "design note; addressed at build", resolve
    them, and merge on the coordinator's own check. Why: a docs PR took
    five heads and sixteen prose findings without converging.

### Review verdict detection

21. **A head counts as reviewed only on one of these**: a bot review
    object with `commit_id` equal to the head; a bot issue comment on
    the PR naming the head sha, created after the push; the bot's
    verdict reaction, as the brief names it, created after the push. An
    acknowledgement reaction (Codex: eyes, where thumbs-up is its clean
    verdict) means the bot picked up a trigger, not that it reached a
    verdict; keep polling. When to trigger at all depends on the bot
    profile (rule 5). Why: the bot's clean verdict arrived as a plain PR
    comment, the check only looked at review objects, and a clean PR was
    re-triggered, wasting a round.

### Process hygiene (continued)

22. **Keep `papercuts.md` at the repo root, shared by all sessions.**
    When a session loses time to a tooling or process problem mid-work,
    it appends `date · symptom · fix · where`, and checks that file
    first when tooling misbehaves. Why: three of the rules above were
    reconstructed by hand from memory after the fact; the agents that
    hit them could have written them down at once.

### Root cause over patches

23. **A wave of findings gets a cause map before any fix.** For each
    finding the builder writes the one-sentence cause, where the rule is
    enforced today, and which findings share a cause; fixes go to the
    shared cause (one enforcement point every case passes through, one
    derivation instead of two figures computed side by side). A clamp
    after the fact is allowed only with proof the cause cannot be fixed.
    Why: seven reviewer complaints about generated plans came down to
    three causes, each a rule that existed but was enforced on one code
    path only; per-symptom patches would have left the other paths open.
24. **Invariants first, fixes second.** Each rule is written as a named
    failing check over every fixture (plus a seeded random sweep) before
    the fix, and the builder reports failing counts before and after. A
    check that goes green on cases nobody targeted is the evidence the
    fix hit the cause. The suite then runs in CI, so the next review
    does not have to rediscover the class.
25. **The reviewer reasons; builders gather narrow evidence.** When a
    cause resists a builder for about 20 minutes, it stops and sends the
    function names, line ranges, one failing input and the values at
    each step where output and expectation diverge (under 40 lines). The
    top-tier model rules from that, states the principle behind the fix
    and the invariant that proves it. Why: this buys the strongest
    model's judgement for a few thousand tokens instead of a file read.
26. **Undocumented external behaviour is decided by the data at run
    time, not by trust.** When an API's docs are silent (e.g. page
    order), branch on what the response shows, make the unexpected
    branch lose nothing, and log one line so you learn if it ever fires.
    A builder that cannot confirm an assumption stops and asks before
    editing. Why: a sync cursor rule would have silently skipped data
    under one of two plausible orderings.
27. **Race fixes name the cause, then prefer one conditional write.**
    "Holds a snapshot across awaits and writes without re-proving it is
    the same instance" is a cause; the two lines a bot flagged are
    symptoms. Match a stable instance identity (not just the owner key),
    sweep every write after an await, and use `UPDATE/DELETE ... WHERE
    <identity>` over check-then-write. Why: the sweep found a token
    overwrite the review bot had not.

### Authority and cost (continued)

28. **Standing merge authority can be granted to the reviewer; it is
    narrow and recorded.** Rule 8 still holds for relayed approvals.
    When the founder grants it in the reviewer's own session, the
    reviewer merges once CI is green, the bot's latest review is on the
    current head, and every finding is fixed or answered in-thread,
    re-read immediately before merging. Pin the merge with
    `--match-head-commit <full 40-char sha>`; a short sha is rejected.
    New principles with a user-facing cost, scope, spending and anything
    legal still go to the founder.
29. **Decide at the top tier; execute wherever it is cheapest in total.**
    One or two commands the reviewer has already verified (a merge, a
    one-line check) are cheaper done directly than briefed, reported and
    re-verified. Anything that reads, builds, polls or prints long
    output goes to a builder with the exact command. A finding accepted
    without a code change is answered on the PR with its reason: a
    comment is not a push and costs no review round.
30. **Review quota limits pushes, not work.** Measurement, prototypes
    and local builds proceed while the bot is out of quota; only the
    push waits. Two builders run in parallel only when one is outside
    the shared core and its version number; withdraw a ticket that
    collides rather than merge-conflict later.
31. **Do not infer a peer's state from message metadata.** A mode tag on
    a cross-session message or an idle notice that predates a queued
    message says nothing about whether the peer is blocked; queued
    messages are picked up at its next turn. Ask the founder once if it
    matters, and never repeat a warning that has not been confirmed.
    Why: the reviewer warned five times about approvals that were never
    pending. Related: code hosts re-anchor old inline comments to the
    newest head, so filter bot findings by author and `created_at`,
    never by commit id.

## Narrow helpers

A helper subagent that doesn't need repo conventions (a review-bot
poller, a log scanner) should not carry the full project context. Give
it, in its frontmatter:

- `omitClaudeMd: true`, since it doesn't need project conventions
- an explicit, cheap `model` (never inherit one)
- `effort: low`
- a turn cap, so it can't run away

See `agents/verdict-poller.md` for a worked example: it polls the PR
host for a review-bot verdict on one head sha, in bounded 5-minute
calls, and reports back the three facts (rule 21's evidence, not a
verdict), with no repo access beyond `Bash`. Because it skips project
context, pass it the bot profile from the brief with every call.

## Operating loop, in short

1. Reviewer plans a ticket, writes the design note, hands it to the
   coordinator.
2. Coordinator briefs a builder: ticket, branch, worktree.
3. Builder builds on its own worktree, pushes once per review round,
   opens the PR, waits inside bounded polling calls for a verdict,
   answers findings, sends a clean report, never ends a turn without a
   state report.
4. Coordinator verifies the merge gate independently and merges.
5. Anything irreversible (deploy, anything the founder should see) waits
   for the founder's own words in that session.
