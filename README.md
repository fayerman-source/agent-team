# agent-team

A Claude Code plugin that packages a working method for running several
Claude Code sessions as a small dev team on one codebase: a
planner-reviewer, a coordinator, and one or more builders. It is process
only, no domain content. It ships:

- a skill (`agent-team`) with the roles, message formats, merge gate,
  and the rules below
- two agent definitions (`coordinator`, `builder`) for spawning those
  roles as subagents or separate sessions
- a `/state` command that produces the state report the method requires
- a Stop hook that blocks a turn from ending silently until it carries a
  `STATE:` report

## Install

This repo carries its own `.claude-plugin/marketplace.json` (name
`agent-team-marketplace`, one entry pointing at `./`), so it installs
as its own marketplace.

**From GitHub**:

```
/plugin marketplace add <owner>/agent-team
/plugin install agent-team@agent-team-marketplace
```

**From a local clone**:

```
/plugin marketplace add <path-to>/agent-team
/plugin install agent-team@agent-team-marketplace
```

**One session only, no install**: point Claude Code at the directory:

```bash
claude --plugin-dir <path-to>/agent-team
```

(Syntax checked against the Claude Code plugin docs, September 2026:
`/plugin marketplace add` takes a GitHub `owner/repo` or a local
directory containing `.claude-plugin/marketplace.json`, and
`/plugin install <plugin>@<marketplace>` installs a plugin it lists. See
https://code.claude.com/docs/en/discover-plugins and
https://code.claude.com/docs/en/plugins if this drifts.)

Nothing here modifies `~/.claude` on its own. Installing is a step the
founder takes deliberately, in whichever session should carry the role.

## Setting up the team (for the human)

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
Subagents never inherit a model by default: always pass one explicitly.

**Spreading load across accounts.** Claude Code keeps its state under
`CLAUDE_CONFIG_DIR`, so a second account can run on the same machine:

```
CLAUDE_CONFIG_DIR=$HOME/.claude-second claude
```

(log in once there). Sessions on different accounts can still message
each other, but listing agents only shows sessions on the same account,
so address the other account's session by its socket:
`uds:/run/user/<uid>/cc-socks/<pid>.sock`. Find the pid with
`pgrep -af "^claude"` and confirm its `CLAUDE_CONFIG_DIR` by reading
`/proc/<pid>/environ`. Sockets change on every restart, so re-derive
them each time. Set `"crossSessionInbound": "accept"` in that account's
`settings.json` so incoming messages aren't held for approval.

**Permission mode.** Builders and the coordinator run in auto mode
(cycle with shift+tab). Accept-edits mode is not enough: shell commands
still prompt in that mode. Two things auto mode never answers on its
own: an "enter worktree" tool relocating the permission root (use plain
`git worktree add` instead, as above) and anything that edits the
harness's own settings.

**Install this plugin in every account that runs builders**, so the
Stop hook applies there too. In each builder account, set
`REVIEWER_ADDRESS` (or the `reviewerAddress` setting) to the reviewer's
socket or name.

**Usage limits.** Each account has a 5-hour window and a weekly window.
A session stopped by a limit does not resume itself: type anything into
its terminal after the reset to continue it. The review bot has its own
quota, separate from any account's; when it's low, batch fixes per
round rather than pushing piecemeal (rule 2).

**Review bot.** Bots differ in how they signal a verdict (review
object, comment, reaction); check which yours uses before writing the
poll (rule 21).

**Daily rhythm.** The founder gives the reviewer the current state (main
tip, open PRs, who is on what ticket). The reviewer rules on anything
open. The coordinator briefs builders. Builders push, open PRs, and
answer findings. The coordinator merges once the gate holds. The founder
deploys. Overnight, the founder may grant the reviewer authority for
everything except deploy, typed into each session directly (never
relayed secondhand, per rule 8).

## Roles

```
                 founder (human)
                       |
      approves milestones, deploys, irreversible calls
                       |
                       v
   +---------------------------------------------+
   |                 reviewer                     |
   |  plans tickets, writes design notes,          |
   |  rules on reports, never builds               |
   +---------------------------------------------+
                       |
              tickets, rulings, briefs
                       v
   +---------------------------------------------+
   |               coordinator                    |
   |  briefs builders, verifies reports against    |
   |  GitHub, merges when the gate holds           |
   +---------------------------------------------+
                       |
            brief: ticket, branch, worktree
                       v
        +--------------+--------------+
        v                             v
  +-----------+                 +-----------+
  |  builder  |       ...       |  builder  |
  |  (ticket  |                 |  (ticket  |
  |   A, own  |                 |   B, own  |
  |  worktree)|                 |  worktree)|
  +-----------+                 +-----------+
        |                             |
        v                             v
   push + open PR                push + open PR
        |                             |
        v                             v
  +---------------------------------------------+
  |  review bot on every push (+ optional        |
  |  read-only second reviewers on their own      |
  |  clone)                                       |
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
5. Trigger a stalled review once after 30 minutes, never more than once
   per head.
6. Never end a turn while a verdict is pending; wait in bounded 5-minute
   calls, never one unbounded loop. An unbounded loop blocked an
   inbound message until the founder pressed escape.
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
21. A head counts as reviewed on a bot review object, a bot comment
    naming the head sha, or a bot reaction, whichever arrives after the
    push; trigger only when none of these shows up by 30 minutes. A
    clean verdict that arrived as a plain comment was missed and
    re-triggered, wasting a round.
22. Keep `papercuts.md` at the repo root, shared by all sessions: append
    `date · symptom · fix · where` when a tooling or process problem
    costs time, and check it first when tooling misbehaves. Three of
    this week's rules were reconstructed by hand from memory after the
    fact.
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
    one or two verified commands directly, anything that reads, builds
    or polls to a builder. Accepted findings are answered on the PR; a
    comment costs no review round.
30. Review quota limits pushes, not work: measure and build locally
    while the bot is out. Two builders in parallel only when one is
    outside the shared core and its version number.
31. Do not infer a peer's state from message metadata or a stale idle
    notice, and never repeat an unconfirmed warning. Filter bot findings
    by author and creation time; hosts re-anchor old comments to the
    newest head.

## Configuration

The Stop hook (`hooks/report-state.py`) needs to know where to send the
state report. It reads, in order: the `REVIEWER_ADDRESS` environment
variable, then a `reviewerAddress` key in a reachable `settings.json`.
Neither is required to run the hook; if both are absent it tells the
agent to ask for the address rather than guess one.

## Licence

MIT. See `LICENSE`.
