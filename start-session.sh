#!/bin/sh
cd "/private/var/folders/mw/42g6lw5d6m1c6wfb72531dmr0000gp/T/inout-g7" || exit 1
exec claude --permission-mode bypassPermissions "Do task G7 from .ai/TASKS. Every heavy run goes through scripts/gate.sh. Keep .ai/wip/g7.md current (DONE/NEXT/MEASURED/BLOCKED/DO NOT) as you go, committing it on this branch. Never merge to main, never checkout another branch."
