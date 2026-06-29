#!/usr/bin/env python3
# ─────────────────────────────────────────────────────────────────────────────
# secret-gate.py — PreToolUse hook (see .claude/settings.json).
#
# Blocks `git push` and prod `vercel --prod` deploys whenever the deterministic
# scanner (scripts/check-secrets.sh) finds a secret or personal-info leak. Reads
# the pending tool call on stdin; emits a "deny" decision on a hit, otherwise
# stays silent (which lets the call proceed / other gates decide).
#
# `git push` is gated because that is the moment a leak becomes visible in the
# shared repo — earlier than deploy.
# ─────────────────────────────────────────────────────────────────────────────
import sys, json, subprocess, os


def deny(reason: str) -> None:
    print(json.dumps({"hookSpecificOutput": {
        "hookEventName": "PreToolUse",
        "permissionDecision": "deny",
        "permissionDecisionReason": reason,
    }}))
    sys.exit(0)


try:
    data = json.load(sys.stdin)
except Exception:
    sys.exit(0)  # malformed input — not our gate to enforce

cmd = (data.get("tool_input") or {}).get("command", "")
is_push = "git push" in cmd
is_prod_deploy = "vercel" in cmd and "--prod" in cmd
if not (is_push or is_prod_deploy):
    sys.exit(0)

root = subprocess.run(
    ["git", "rev-parse", "--show-toplevel"], capture_output=True, text=True
)
cwd = root.stdout.strip() or os.getcwd()
res = subprocess.run(
    ["bash", "scripts/check-secrets.sh"], cwd=cwd, capture_output=True, text=True
)
if res.returncode != 0:
    action = "git push" if is_push else "prod deploy"
    deny(
        f"🔒 Secret/PII scan FAILED — {action} blocked.\n\n"
        f"{res.stdout}{res.stderr}\n"
        "Remove the leak (move it into an env var), or if it is a false positive "
        "refine scripts/check-secrets.sh. Then retry."
    )
sys.exit(0)
