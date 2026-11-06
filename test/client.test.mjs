import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ManagedAgentsClient, ApiError, StreamError } from '../dist/index.js'

test('durable mode preserves the accepted request identity across split SSE frames', async () => {
  const calls = []
  const encoder = new TextEncoder()
  const chunks = [
    'event: text_delta\r',
    '\ndata: {"delta":"Hi"}\r\n\r\n',
    'event: done\ndata: {"status":"completed"}\n\n',
  ]
  const client = new ManagedAgentsClient({
    baseUrl: 'https://example.test/',
    apiKey: async () => 'ma_sk_test',
    durable: true,
    fetch: async (url, init) => {
      calls.push({ url, init })
      if (url.endsWith('/api/sessions')) return Response.json({ session_id: 's-1' })
      return new Response(new ReadableStream({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
          controller.close()
        },
      }), { headers: { 'X-Client-Request-Id': 'req-accepted' } })
    },
  })
  assert.equal(await client.createSession('agent-1'), 's-1')
  const events = []
  for await (const event of client.chat('s-1', 'Hello', { clientRequestId: 'req-submitted' })) events.push(event)
  assert.deepEqual(events.map(({ event, data, clientRequestId }) => [event, data, clientRequestId]), [
    ['text_delta', { delta: 'Hi' }, 'req-accepted'],
    ['done', { status: 'completed' }, 'req-accepted'],
  ])
  assert.equal(calls[0].init.headers.get('Authorization'), 'Bearer ma_sk_test')
  assert.equal(calls[1].init.headers.get('X-Client-Request-Id'), 'req-submitted')
})

test('preserves HTTP status and SSE failures separately', async () => {
  const client = new ManagedAgentsClient({
    baseUrl: 'https://example.test',
    apiKey: 'ma_sk_test',
    fetch: async () => Response.json({ error: 'denied' }, { status: 403 }),
  })
  await assert.rejects(client.createSession('agent-1'), error => error instanceof ApiError && error.status === 403)

  const streamClient = new ManagedAgentsClient({
    baseUrl: 'https://example.test',
    apiKey: 'ma_sk_test',
    fetch: async () => new Response('event: error\ndata: {"message":"runtime failed"}\n\n'),
  })
  await assert.rejects(async () => {
    for await (const _ of streamClient.chat('s-1', 'Hello')) { /* Consume the stream. */ }
  }, error => error instanceof StreamError && error.message === 'runtime failed')

  const truncatedClient = new ManagedAgentsClient({
    baseUrl: 'https://example.test',
    apiKey: 'ma_sk_test',
    fetch: async () => new Response('event: text_delta\ndata: {"delta":"partial"}\n\n', {
      headers: { 'X-Client-Request-Id': 'req-accepted' },
    }),
  })
  await assert.rejects(async () => {
    for await (const _ of truncatedClient.chat('s-1', 'Hello')) { /* Consume the stream. */ }
  }, error => error instanceof StreamError && error.message === 'Chat stream ended before done' && error.clientRequestId === undefined)
})

test('current API mode does not promise deduplication or cancellation', async () => {
  const calls = []
  const client = new ManagedAgentsClient({
    baseUrl: 'https://example.test',
    apiKey: 'ma_sk_test',
    fetch: async (url, init) => {
      calls.push({ url, init })
      return new Response('event: done\ndata: {"status":"completed"}\n\n')
    },
  })
  const events = []
  for await (const event of client.chat('s-1', 'Hello')) events.push(event)
  assert.equal(events[0].clientRequestId, undefined)
  assert.equal(calls[0].init.headers.has('X-Client-Request-Id'), false)
  await assert.rejects(async () => {
    for await (const _ of client.chat('s-1', 'Hello', { clientRequestId: 'req-1' })) { /* Consume the stream. */ }
  }, /requires the durable session API/)
  await assert.rejects(client.cancel('s-1'), /requires the durable session API/)
  assert.equal(calls.length, 1)
})

test('durable mode sends cancellation to the durable endpoint', async () => {
  const calls = []
  const client = new ManagedAgentsClient({
    baseUrl: 'https://example.test',
    apiKey: 'ma_sk_test',
    durable: true,
    fetch: async (url, init) => { calls.push({ url, init }); return new Response(null, { status: 204 }) },
  })
  await client.cancel('session/1', 'message-1')
  assert.equal(calls[0].url, 'https://example.test/api/sessions/session%2F1/cancel')
  assert.deepEqual(JSON.parse(calls[0].init.body), { request_message_id: 'message-1' })
})

test('renames and ends a session with the platform key', async () => {
  const calls = []
  const client = new ManagedAgentsClient({
    baseUrl: 'https://example.test',
    apiKey: 'ma_sk_test',
    fetch: async (url, init) => { calls.push({ url, init }); return new Response(null, { status: 204 }) },
  })
  await client.renameSession('session/1', 'Partner conversation')
  await client.endSession('session/1')
  assert.equal(calls[0].url, 'https://example.test/api/sessions/session%2F1/title')
  assert.equal(calls[0].init.method, 'PATCH')
  assert.deepEqual(JSON.parse(calls[0].init.body), { title: 'Partner conversation' })
  assert.equal(calls[1].init.method, 'DELETE')
  assert.equal(calls[1].init.headers.get('Authorization'), 'Bearer ma_sk_test')
})

test('continues a session and retrieves its transcript', async () => {
  const requests = []
  const client = new ManagedAgentsClient({
    baseUrl: 'https://example.test',
    apiKey: 'ma_sk_test',
    fetch: async (url, init) => {
      requests.push({ url, init })
      if (url.endsWith('/messages') && init.method === 'POST') {
        return new Response('event: done\ndata: {"status":"completed"}\n\n')
      }
      return Response.json({ messages: [{ seq: 2, role: 'assistant', content_json: '{"content":"Hi"}' }], has_more: false })
    },
  })
  for await (const _ of client.chat('session-1', 'First')) { /* Consume the first turn. */ }
  for await (const _ of client.chat('session-1', 'Second')) { /* Continue the same session. */ }
  const transcript = await client.getTranscript('session-1', 50, 3)
  assert.equal(requests[0].url, requests[1].url)
  assert.equal(requests[0].url, 'https://example.test/api/sessions/session-1/messages')
  assert.deepEqual(requests.slice(0, 2).map(({ init }) => JSON.parse(init.body).content), ['First', 'Second'])
  assert.equal(requests[2].url, 'https://example.test/api/sessions/session-1/messages?limit=50&before_seq=3')
  assert.equal(transcript.messages[0].role, 'assistant')
})
