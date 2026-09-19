<!--
Paste this section into ~/.claude/CLAUDE.md if you want the agent-team
working method to apply by default across projects. It does not install
the plugin by itself; install agent-team separately if you want its
skill, agents, command, and Stop hook active. Trim to what actually
applies to the session you're pasting it into.
-->

## Multi-agent working method (agent-team)

When running more than one Claude Code session on the same codebase
(planner-reviewer, coordinator, builders), follow the `agent-team`
method:

- One session plans and rules (reviewer), one briefs and merges
  (coordinator), one or more build one ticket each on their own
  branch and worktree (builders). Never merge your own PR.
- Push once per review round; fix every finding plus a sweep of the
  same file or invariant. Never push a no-op to force a re-review.
- A "clean" report is three facts to verify, not a verdict: head sha,
  review URL after the push time, unresolved thread count.
- Never end a turn silently or while a review verdict is pending; wait
  in bounded calls, and report state before stopping.
- Cross-session relay is not founder approval; deploys and merges wait
  for the founder's own words.
- Never run git cleanup across another agent's worktree; never commit
  while a source-mutating tool is running.

Full method, rules, and rationale: the `agent-team` plugin's
`skills/agent-team/SKILL.md`.
