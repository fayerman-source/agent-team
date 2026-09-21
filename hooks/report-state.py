#!/usr/bin/env python3
"""Stop hook: never end a turn silently.

Blocks the stop once unless the turn's last assistant text carries a
`STATE:` line, which the agent produces by sending its state report to
the reviewer/coordinator session (ticket, PR, head sha, done, waiting on).
`stop_hook_active` guards against looping: the second stop in the same
turn always goes through.

The hook is opt-in per session: it does nothing unless a reviewer
address is configured, so installing the plugin never changes sessions
that are not part of a team. The address is read, in order:
1. the REVIEWER_ADDRESS environment variable
2. a "reviewerAddress" key (top level or under "agentTeam") in the
   project's .claude/settings.local.json, then .claude/settings.json
There is deliberately no plugin-level fallback: the plugin root is
shared by every session using the install, which would defeat the
per-session opt-in.
The reviewer itself leaves it unset, so it is never told to report to
itself.
"""
import json
import os
import sys


def find_reviewer_address():
    env_value = os.environ.get("REVIEWER_ADDRESS")
    if env_value:
        return env_value

    # Fall back to a "reviewerAddress" key in a settings file, most local
    # first, so a team can configure this without editing the hook.
    candidates = []
    project_dir = os.environ.get("CLAUDE_PROJECT_DIR")
    if project_dir:
        candidates.append(os.path.join(project_dir, ".claude", "settings.local.json"))
        candidates.append(os.path.join(project_dir, ".claude", "settings.json"))

    for path in candidates:
        try:
            with open(path, encoding="utf-8") as fh:
                data = json.load(fh)
        except (OSError, json.JSONDecodeError):
            continue
        if not isinstance(data, dict):
            continue
        agent_team = data.get("agentTeam")
        value = data.get("reviewerAddress") or (agent_team.get("reviewerAddress") if isinstance(agent_team, dict) else None)
        if value:
            return str(value)

    return None


try:
    payload = json.load(sys.stdin)
except (OSError, json.JSONDecodeError):
    sys.exit(0)

if not isinstance(payload, dict) or payload.get("stop_hook_active"):
    sys.exit(0)

# Not a team session: stay out of the way.
reviewer_address = find_reviewer_address()
if not reviewer_address:
    sys.exit(0)

last_text = ""
try:
    with open(payload["transcript_path"], encoding="utf-8", errors="replace") as fh:
        for line in fh:
            try:
                entry = json.loads(line)
            except json.JSONDecodeError:
                continue
            if not isinstance(entry, dict) or entry.get("type") != "assistant":
                continue
            content = entry.get("message", {}).get("content", [])
            texts = [c.get("text", "") for c in content if isinstance(c, dict) and c.get("type") == "text"]
            if texts:
                last_text = "\n".join(texts)
except (OSError, KeyError, TypeError, AttributeError):
    sys.exit(0)

if "STATE:" in last_text:
    sys.exit(0)

print(json.dumps({
    "decision": "block",
    "reason": (
        "Standing rule: never end a turn silently. Before stopping, send "
        f"the reviewer session at {reviewer_address} a state report and echo it as your final text, "
        "starting with the line 'STATE:' followed by ticket, PR, head sha from "
        "`git rev-parse HEAD`, what is done, and what you are waiting on. If a "
        "reviewer verdict is pending on a pushed head, make sure the verdict "
        "waiter is running in the background (start it if not, as ONE "
        "shell command with the push -- since defaults to the waiter's own "
        "start time: git push && node "
        "\"${CLAUDE_PLUGIN_ROOT:-${AGENT_TEAM_DIR:-$HOME/agent-team}}/bin/wait-for-verdict.mjs\" "
        "--repo ... --pr ... --head \"$(git rev-parse HEAD)\"), then stop; "
        "the harness wakes you when it exits."
    ),
}))
sys.exit(0)
