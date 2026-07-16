#!/bin/sh
# Pre-push gate: one headless pipeline oracle run (task oracle-ci).
# Full 20-run cold matrix: npm run oracle:cold
set -e
cd "$(git rev-parse --show-toplevel)"
npm run typecheck
npm test
npm run oracle
