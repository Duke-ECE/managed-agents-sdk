import { ApiError, ManagedAgentsClient, StreamError } from '../dist/index.js'

const apiKey = process.env.MANAGED_AGENTS_API_KEY
const agentId = process.env.MANAGED_AGENTS_AGENT_ID
if (!apiKey || !agentId) {
  console.error('Set MANAGED_AGENTS_API_KEY and MANAGED_AGENTS_AGENT_ID before running this example.')
  process.exitCode = 1
} else {
  const client = new ManagedAgentsClient({
    baseUrl: process.env.MANAGED_AGENTS_API_URL ?? 'https://api-managed-agent.colab.duke.edu',
    apiKey,
  })
  let sessionId
  try {
    sessionId = await client.createSession(agentId)
    console.log(`Session: ${sessionId}`)
    for (const message of ['Hello from a third-party app', 'What did I just say?']) {
      process.stdout.write(`You: ${message}\nAgent: `)
      for await (const frame of client.chat(sessionId, message)) {
        if (frame.event === 'text_delta') {
          const data = frame.data
          if (data && typeof data === 'object' && typeof data.delta === 'string') {
            process.stdout.write(data.delta)
          }
        }
      }
      process.stdout.write('\n')
    }
    const transcript = await client.getTranscript(sessionId)
    console.log(`Stored messages: ${transcript.messages.length}`)
  } catch (error) {
    if (error instanceof ApiError) {
      console.error(`API request failed (HTTP ${error.status}): ${error.message}`)
    } else if (error instanceof StreamError) {
      console.error(`Chat did not complete: ${error.message}`)
      console.error(`Read the transcript for session ${sessionId} before retrying; the current API does not deduplicate messages.`)
    } else {
      console.error(error instanceof Error ? error.message : String(error))
      if (sessionId) console.error(`If a chat request was sent, read the transcript for session ${sessionId} before retrying.`)
    }
    process.exitCode = 1
  }
}
