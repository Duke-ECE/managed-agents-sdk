# managed-agents-sdk

TypeScript/JavaScript server-side SDK for chatting with existing managed agent templates. Follow the workspace and [Duke-ECE standards](../standards/AGENTS.md) rules.

- Node.js 22+, TypeScript `strict`, ESM, no runtime dependencies.
- Public SDK methods must preserve session ownership and durable request identity.
- `apiKey` is a platform key created by a user in the console. Never log or persist it in SDK output.
- Keep agent creation/configuration and sandbox execution outside this package.
- Run `npm test` after changing the transport or public API.
