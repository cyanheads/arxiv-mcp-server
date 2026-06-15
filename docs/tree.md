# arxiv-mcp-server - Directory Structure

Generated on: 2026-06-15 20:31:45

```text
arxiv-mcp-server/
├── .agents/
├── .claude/
├── .claude-plugin/
│   └── plugin.json
├── .codex-plugin/
│   ├── mcp.json
│   └── plugin.json
├── .github/
│   └── ISSUE_TEMPLATE/
│       ├── bug_report.yml
│       ├── config.yml
│       └── feature_request.yml
├── .vscode/
│   ├── extensions.json
│   └── settings.json
├── changelog/
│   ├── 0.1.x/
│   ├── 1.2.x/
│   └── template.md
├── claude-plans/
├── data/
├── dev-logs/
├── docs/
│   ├── arxiv-mcp-server-research.md
│   └── design.md
├── scripts/
│   ├── _mirror-context.ts
│   ├── arxiv-mirror-init.ts
│   ├── arxiv-mirror-refresh.ts
│   ├── arxiv-mirror-verify.ts
│   ├── build-changelog.ts
│   ├── build.ts
│   ├── check-docs-sync.ts
│   ├── check-framework-antipatterns.ts
│   ├── check-skill-versions.ts
│   ├── check-skills-sync.ts
│   ├── clean-mcpb.ts
│   ├── clean.ts
│   ├── devcheck.ts
│   ├── lint-mcp.ts
│   ├── lint-packaging.ts
│   ├── list-skills.ts
│   ├── release-github.ts
│   ├── split-changelog.ts
│   └── tree.ts
├── skills/
│   ├── add-app-tool/
│   │   └── SKILL.md
│   ├── add-prompt/
│   │   └── SKILL.md
│   ├── add-resource/
│   │   └── SKILL.md
│   ├── add-service/
│   │   └── SKILL.md
│   ├── add-test/
│   │   └── SKILL.md
│   ├── add-tool/
│   │   └── SKILL.md
│   ├── api-auth/
│   │   └── SKILL.md
│   ├── api-canvas/
│   │   └── SKILL.md
│   ├── api-config/
│   │   └── SKILL.md
│   ├── api-context/
│   │   └── SKILL.md
│   ├── api-errors/
│   │   └── SKILL.md
│   ├── api-linter/
│   │   └── SKILL.md
│   ├── api-mirror/
│   │   └── SKILL.md
│   ├── api-services/
│   │   ├── references/
│   │   │   ├── graph.md
│   │   │   ├── llm.md
│   │   │   └── speech.md
│   │   └── SKILL.md
│   ├── api-telemetry/
│   │   └── SKILL.md
│   ├── api-testing/
│   │   └── SKILL.md
│   ├── api-utils/
│   │   ├── references/
│   │   │   ├── formatting.md
│   │   │   ├── parsing.md
│   │   │   └── security.md
│   │   └── SKILL.md
│   ├── api-workers/
│   │   └── SKILL.md
│   ├── code-simplifier/
│   │   └── SKILL.md
│   ├── design-mcp-server/
│   │   └── SKILL.md
│   ├── field-test/
│   │   └── SKILL.md
│   ├── git-wrapup/
│   │   └── SKILL.md
│   ├── maintenance/
│   │   └── SKILL.md
│   ├── orchestrations/
│   │   ├── workflows/
│   │   │   ├── field-test-fix.md
│   │   │   ├── fix-wrapup-release.md
│   │   │   ├── greenfield-build.md
│   │   │   └── maintenance-release.md
│   │   └── SKILL.md
│   ├── polish-docs-meta/
│   │   ├── references/
│   │   │   ├── agent-protocol.md
│   │   │   ├── package-meta.md
│   │   │   ├── readme.md
│   │   │   └── server-json.md
│   │   └── SKILL.md
│   ├── release-and-publish/
│   │   └── SKILL.md
│   ├── report-issue-framework/
│   │   └── SKILL.md
│   ├── report-issue-local/
│   │   └── SKILL.md
│   ├── security-pass/
│   │   └── SKILL.md
│   ├── setup/
│   │   └── SKILL.md
│   ├── techniques/
│   │   ├── references/
│   │   │   └── outline-on-overflow.md
│   │   └── SKILL.md
│   └── tool-defs-analysis/
│       └── SKILL.md
├── src/
│   ├── config/
│   │   └── server-config.ts
│   ├── mcp-server/
│   │   ├── prompts/
│   │   │   └── definitions/
│   │   ├── resources/
│   │   │   └── definitions/
│   │   │       ├── categories.resource.ts
│   │   │       ├── index.ts
│   │   │       └── paper.resource.ts
│   │   └── tools/
│   │       └── definitions/
│   │           ├── arxiv-get-metadata.tool.ts
│   │           ├── arxiv-list-categories.tool.ts
│   │           ├── arxiv-read-paper.tool.ts
│   │           ├── arxiv-search.tool.ts
│   │           └── index.ts
│   ├── services/
│   │   └── arxiv/
│   │       ├── mirror/
│   │       │   ├── harvester.ts
│   │       │   ├── index.ts
│   │       │   ├── query.ts
│   │       │   ├── refresh-subprocess.ts
│   │       │   ├── runner.ts
│   │       │   ├── schema.sql
│   │       │   ├── schema.ts
│   │       │   ├── store.ts
│   │       │   └── types.ts
│   │       ├── arxiv-service.ts
│   │       ├── categories.ts
│   │       └── types.ts
│   └── index.ts
├── tests/
│   ├── mcp-server/
│   │   ├── resources/
│   │   │   └── definitions/
│   │   │       ├── categories.resource.test.ts
│   │   │       ├── paper.resource.extra.test.ts
│   │   │       └── paper.resource.test.ts
│   │   └── tools/
│   │       └── definitions/
│   │           ├── arxiv-get-metadata.tool.test.ts
│   │           ├── arxiv-list-categories.tool.test.ts
│   │           ├── arxiv-read-paper.tool.test.ts
│   │           ├── arxiv-search.tool.test.ts
│   │           ├── input-validation.test.ts
│   │           └── security.test.ts
│   └── services/
│       └── arxiv/
│           ├── mirror/
│           │   ├── harvester.test.ts
│           │   ├── migration.test.ts
│           │   ├── parity.test.ts
│           │   ├── query.test.ts
│           │   ├── refresh-subprocess.test.ts
│           │   └── store.test.ts
│           ├── arxiv-service-errors.test.ts
│           ├── arxiv-service-mirror.test.ts
│           ├── arxiv-service.test.ts
│           ├── categories.test.ts
│           ├── types-extra.test.ts
│           └── types.test.ts
├── .dockerignore
├── .env.example
├── .gitignore
├── .mcpbignore
├── AGENTS.md
├── biome.json
├── bun.lock
├── bunfig.toml
├── CHANGELOG.md
├── CITATION.cff
├── CLAUDE.md
├── devcheck.config.json
├── Dockerfile
├── LICENSE
├── manifest.json
├── package.json
├── README.md
├── server.json
├── tsconfig.build.json
├── tsconfig.json
└── vitest.config.ts
```

_Note: This tree excludes files and directories matched by .gitignore and default patterns._
