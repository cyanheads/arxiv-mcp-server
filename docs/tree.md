# arxiv-mcp-server - Directory Structure

Generated on: 2026-04-24 11:20:15

```text
arxiv-mcp-server/
├── .claude/
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
│   └── template.md
├── claude-plans/
├── dev-logs/
├── docs/
│   ├── arxiv-mcp-server-research.md
│   └── design.md
├── scripts/
│   ├── build-changelog.ts
│   ├── build.ts
│   ├── check-docs-sync.ts
│   ├── check-skills-sync.ts
│   ├── clean.ts
│   ├── devcheck.ts
│   ├── lint-mcp.ts
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
│   ├── api-config/
│   │   └── SKILL.md
│   ├── api-context/
│   │   └── SKILL.md
│   ├── api-errors/
│   │   └── SKILL.md
│   ├── api-linter/
│   │   └── SKILL.md
│   ├── api-services/
│   │   ├── references/
│   │   │   ├── graph.md
│   │   │   ├── llm.md
│   │   │   └── speech.md
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
│   ├── design-mcp-server/
│   │   └── SKILL.md
│   ├── devcheck/
│   │   └── SKILL.md
│   ├── field-test/
│   │   └── SKILL.md
│   ├── maintenance/
│   │   └── SKILL.md
│   ├── migrate-mcp-ts-template/
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
│   └── setup/
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
│   │       ├── arxiv-service.ts
│   │       ├── categories.ts
│   │       └── types.ts
│   └── index.ts
├── tests/
│   ├── mcp-server/
│   │   ├── resources/
│   │   │   └── definitions/
│   │   │       ├── categories.resource.test.ts
│   │   │       └── paper.resource.test.ts
│   │   └── tools/
│   │       └── definitions/
│   │           ├── arxiv-get-metadata.tool.test.ts
│   │           ├── arxiv-list-categories.tool.test.ts
│   │           ├── arxiv-read-paper.tool.test.ts
│   │           └── arxiv-search.tool.test.ts
│   └── services/
│       └── arxiv/
│           ├── arxiv-service.test.ts
│           ├── categories.test.ts
│           └── types.test.ts
├── .dockerignore
├── .env.example
├── .gitignore
├── biome.json
├── bun.lock
├── bunfig.toml
├── CHANGELOG.md
├── CLAUDE.md
├── devcheck.config.json
├── Dockerfile
├── LICENSE
├── package.json
├── README.md
├── server.json
├── tsconfig.build.json
├── tsconfig.json
└── vitest.config.ts
```

_Note: This tree excludes files and directories matched by .gitignore and default patterns._
