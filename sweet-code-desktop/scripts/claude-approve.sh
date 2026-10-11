#!/bin/sh
# Claude Code PreToolUse hook → sikeoop's approver. Copy to ~/.sikeoop/claude-approve.sh.
# When sikeoop isn't running or anything fails, it prints nothing: Claude Code asks as usual.
CONF="$HOME/.sikeoop/approver.json"
[ -f "$CONF" ] || exit 0
PORT=$(sed -n 's/.*"port":\([0-9]*\).*/\1/p' "$CONF")
TOKEN=$(sed -n 's/.*"token":"\([0-9a-f]*\)".*/\1/p' "$CONF")
OUT=$(curl -s -m 120 -X POST "http://127.0.0.1:$PORT/" -H "Authorization: Bearer $TOKEN" --data-binary @-) || exit 0
DECISION=$(printf '%s' "$OUT" | sed -nE 's/.*"decision":"(allow|ask|deny)".*/\1/p')
REASON=$(printf '%s' "$OUT" | sed -n 's/.*"reason":"\([^"]*\)".*/\1/p')
[ -n "$DECISION" ] || exit 0
printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"%s","permissionDecisionReason":"sikeoop %s"}}\n' "$DECISION" "$REASON"
