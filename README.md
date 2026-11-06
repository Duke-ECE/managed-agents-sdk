# Managed Agents chat SDK (draft)

TypeScript/JavaScript client for chatting with an **existing** Managed Agents template. It does not create agents or manage sandboxes. The package is still a local draft; the current API-key backend is deployed, but an owner-authenticated end-to-end check and the durable session contract remain outstanding.

Requires Node.js 22+. Create an API key on the platform's **API Keys** page and keep it on the server. Never embed it in a browser bundle. The default client uses the currently deployed session API.

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

The client also provides `listSessions`, `renameSession`, `endSession`, and `getTranscript`. Name a session after its first completed turn, since the runtime may generate a title for that first turn. `chat` yields named SSE events (`text_delta`, `tool_call`, `tool_result`, `done`) with parsed JSON data. HTTP failures throw `ApiError` with a status; an SSE `error` frame or a stream that ends before `done` throws `StreamError`. The deployed API does **not** deduplicate chat submissions. If a connection drops before `done`, read the transcript before deciding whether to send another message; resending may create a second turn.

For a runnable local example, build the package and use an existing agent ID:

```sh
npm ci --ignore-scripts
npm run build
MANAGED_AGENTS_API_KEY=ma_sk_... MANAGED_AGENTS_AGENT_ID=... node examples/quickstart.mjs
```

`AbortSignal` stops reading the HTTP stream; it does not guarantee that execution stopped. The unpublished durable API can be opted into with `durable: true` after it is deployed and verified. In that mode, `chat` sends an `X-Client-Request-Id`, exposes the accepted `clientRequestId` on events and stream errors, and `cancel(sessionId, requestMessageId)` calls the durable cancellation endpoint. Do not enable that mode against the current production backend.

## Development

```sh
npm install --ignore-scripts
npm test
```
