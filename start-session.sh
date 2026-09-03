#!/bin/sh
cd "/private/var/folders/mw/42g6lw5d6m1c6wfb72531dmr0000gp/T/inout-m1" || exit 1
exec claude --permission-mode bypassPermissions "Do task M1 from .ai/TASKS. Skip entry (a) - session B13 owns that line, read its result instead of re-fixing it. Build the door first (the structural half). Every heavy run goes through scripts/gate.sh. Keep .ai/wip/m1.md current (DONE/NEXT/MEASURED/BLOCKED/DO NOT) as you go, committing it on this branch. Never merge to main, never checkout another branch."
