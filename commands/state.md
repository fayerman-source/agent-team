---
description: "Produce a STATE: report for the coordinator/reviewer session"
argument-hint: "[waiting-on]"
allowed-tools: ["Bash"]
---

# /state

Produce the state report this plugin's Stop hook requires before a turn
can end. Do this now, then send it to the coordinator or reviewer
session and echo it as your final text.

**Extra context on what you're waiting on (optional):** "$ARGUMENTS"

## Steps

1. Work out the ticket you're on (from the branch name or your brief).
2. Find the current PR number for that ticket, if one is open.
3. Get the real head sha: `git rev-parse HEAD`. Never paste a sha from
   memory or from an earlier point in the turn.
4. Summarize in one short clause what's done since the last report.
5. Summarize in one short clause what you're waiting on: a review
   verdict, a founder decision, nothing (ready to merge), etc. Use the
   argument above if given.
6. Send this to the coordinator/reviewer session's address (see the
   `agent-team` skill for how sessions address each other), and print it
   as your final line in exactly this form:

```
STATE: <ticket> <PR#> <head-sha> done=<what's done> waiting=<what you're waiting on>
```

If no PR is open yet, use `PR#=none`. If you have no ticket assigned,
say so plainly rather than inventing one.
