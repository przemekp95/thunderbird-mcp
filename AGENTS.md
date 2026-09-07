# Repository instructions

- Use `README.md` for setup, architecture, build, and test entry points.
- Treat `extension/mcp_server/api.js` and `extension/mcp_server/schema.json` as the source of truth for MCP behavior and schemas.
- Run `./.codex/verify` before completion; CI invokes the same canonical gate.
- Rebuild `dist/thunderbird-mcp-safe.xpi` with `node scripts/build-xpi.cjs` after extension source or version changes.
- Do not send mail or mutate unrelated Thunderbird data while testing compose behavior.
