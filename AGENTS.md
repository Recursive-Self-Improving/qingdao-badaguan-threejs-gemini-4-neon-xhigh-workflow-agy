# AGENTS.md

## Lessons

- The production `dist/` directory is committed. On Linux, a fresh copy of the tracked build inputs can reproduce it with `npm ci --ignore-scripts` followed by `npm run build`. Compare the complete output directory byte for byte when auditing a release.
