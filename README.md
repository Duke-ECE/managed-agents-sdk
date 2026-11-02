# Managed Agents chat SDK (draft)

TypeScript/JavaScript client for chatting with an **existing** Managed Agents template. It does not create agents or manage sandboxes. The package is local and private until the API-key backend is deployed and verified.

Requires Node.js 22+. Create an API key on the platform's **API Keys** page and keep it on the server. Never embed it in a browser bundle. This SDK targets the new backend API-key authentication path; the deployed backend must be upgraded before using it.

```ts
import { ManagedAgentsClient } from '@duke-ece/managed-agents-sdk'

const client = new ManagedAgentsClient({
  baseUrl: 'https://api-managed-agent.colab.duke.edu',
  apiKey: process.env.MANAGED_AGENTS_API_KEY!,
})

const sessionId = await client.createSession('existing-agent-id')
for await (const item of client.chat(sessionId, 'Hello')) {
  if (item.event === 'text_delta') process.stdout.write((item.data as { delta: string }).delta)
  if (item.event === 'done') console.log('\nDone')
}

await client.renameSession(sessionId, 'Customer support chat')

const history = await client.getTranscript(sessionId)
```

The client also provides `listSessions`, `renameSession`, `endSession`, `cancel`, and `getTranscript`. Name a session after its first completed turn, since the runtime may generate a title for that first turn. `chat` yields raw named SSE events (`text_delta`, `tool_call`, `tool_result`, `done`) with parsed JSON data and the accepted `clientRequestId`. HTTP failures throw `ApiError` with a status; an SSE `error` frame or a stream that ends before `done` throws `StreamError` with the accepted `clientRequestId`. To reconnect an uncertain submission, pass the **same** `clientRequestId` and content. Never retry with a new ID unless the caller intends a new turn.

For a runnable local example, build the package and use an existing agent ID:

```sh
npm ci --ignore-scripts
npm run build
MANAGED_AGENTS_API_KEY=ma_sk_... MANAGED_AGENTS_AGENT_ID=... node examples/quickstart.mjs
```

`AbortSignal` stops reading the HTTP stream. For durable execution, call `cancel(sessionId, requestMessageId)` to request cancellation of the active turn.

## Development

```sh
npm install --ignore-scripts
npm test
```
