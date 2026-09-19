#!/usr/bin/env python3
"""Stop hook: never end a turn silently.

Blocks the stop once unless the turn's last assistant text carries a
`STATE:` line, which the agent produces by sending its state report to
the reviewer/coordinator session (ticket, PR, head sha, done, waiting on).
`stop_hook_active` guards against looping: the second stop in the same
turn always goes through.

The reviewer's address is never hard-coded. It is read, in order:
1. the REVIEWER_ADDRESS environment variable
2. a "reviewerAddress" key in the plugin's settings (settings.json, under
   this plugin's config, or a project-level .claude/settings.json)
3. if neither is set, the block message tells the agent to ask for it
   instead of guessing a socket path or session name.
"""
import json
import os
import sys


def find_reviewer_address():
    env_value = os.environ.get("REVIEWER_ADDRESS")
    if env_value:
        return env_value

    # Fall back to a "reviewerAddress" key in any settings.json reachable
    # from the plugin root or the current project, so a team can configure
    # this once without editing the hook.
    candidates = []
    plugin_root = os.environ.get("CLAUDE_PLUGIN_ROOT")
    if plugin_root:
        candidates.append(os.path.join(plugin_root, "settings.json"))
    project_dir = os.environ.get("CLAUDE_PROJECT_DIR")
    if project_dir:
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

reviewer_address = find_reviewer_address()
address_hint = (
    f"the reviewer session at {reviewer_address}"
    if reviewer_address
    else "the reviewer/coordinator session (its address is not configured: "
    "set REVIEWER_ADDRESS or a reviewerAddress setting, or ask for it before guessing)"
)

print(json.dumps({
    "decision": "block",
    "reason": (
        "Standing rule: never end a turn silently. Before stopping, send "
        f"{address_hint} a state report and echo it as your final text, "
        "starting with the line 'STATE:' followed by ticket, PR, head sha from "
        "`git rev-parse HEAD`, what is done, and what you are waiting on. If a "
        "reviewer verdict is pending on a pushed head, do not stop: keep polling "
        "inside the turn instead."
    ),
}))
sys.exit(0)
