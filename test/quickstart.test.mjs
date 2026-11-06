import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createServer } from 'node:http'
import { promisify } from 'node:util'
import { test } from 'node:test'

const run = promisify(execFile)

async function withServer(handler, callback) {
  const server = createServer((request, response) => {
    Promise.resolve(handler(request, response)).catch(error => {
      response.writeHead(500)
      response.end(error instanceof Error ? error.message : String(error))
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    return await callback(`http://127.0.0.1:${server.address().port}`)
  } finally {
    await new Promise(resolve => server.close(resolve))
  }
}

async function bodyOf(request) {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  return JSON.parse(Buffer.concat(chunks).toString())
}

test('quickstart completes two turns and reads history over HTTP', async () => {
  const sent = []
  await withServer(async (request, response) => {
    assert.equal(request.headers.authorization, 'Bearer ma_sk_fixture')
    if (request.method === 'POST' && request.url === '/api/sessions') {
      assert.deepEqual(await bodyOf(request), { agent_id: 'agent-fixture' })
      response.setHeader('Content-Type', 'application/json')
      response.end(JSON.stringify({ session_id: 'session-fixture' }))
      return
    }
    if (request.method === 'POST' && request.url === '/api/sessions/session-fixture/messages') {
      sent.push((await bodyOf(request)).content)
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      response.write('event: text_delta\ndata: {"delta":"Hello"}\n\n')
      response.end('event: done\ndata: {"status":"completed"}\n\n')
      return
    }
    if (request.method === 'GET' && request.url === '/api/sessions/session-fixture/messages') {
      response.setHeader('Content-Type', 'application/json')
      response.end(JSON.stringify({ messages: [{ seq: 1 }, { seq: 2 }], has_more: false }))
      return
    }
    response.writeHead(404).end()
  }, async baseUrl => {
    const { stdout, stderr } = await run(process.execPath, ['examples/quickstart.mjs'], {
      env: {
        ...process.env,
        MANAGED_AGENTS_API_URL: baseUrl,
        MANAGED_AGENTS_API_KEY: 'ma_sk_fixture',
        MANAGED_AGENTS_AGENT_ID: 'agent-fixture',
      },
    })
    assert.match(stdout, /Session: session-fixture/)
    assert.match(stdout, /Agent: Hello/)
    assert.match(stdout, /Stored messages: 2/)
    assert.equal(stderr, '')
  })
  assert.deepEqual(sent, ['Hello from a third-party app', 'What did I just say?'])
})

test('quickstart warns before retrying an incomplete turn', async () => {
  await withServer(async (request, response) => {
    if (request.method === 'POST' && request.url === '/api/sessions') {
      await bodyOf(request)
      response.setHeader('Content-Type', 'application/json')
      response.end(JSON.stringify({ session_id: 'session-fixture' }))
      return
    }
    response.writeHead(200, { 'Content-Type': 'text/event-stream' })
    response.end('event: text_delta\ndata: {"delta":"partial"}\n\n')
  }, async baseUrl => {
    await assert.rejects(run(process.execPath, ['examples/quickstart.mjs'], {
      env: {
        ...process.env,
        MANAGED_AGENTS_API_URL: baseUrl,
        MANAGED_AGENTS_API_KEY: 'ma_sk_fixture',
        MANAGED_AGENTS_AGENT_ID: 'agent-fixture',
      },
    }), error => {
      assert.match(error.stderr, /Read the transcript for session session-fixture before retrying/)
      return true
    })
  })
})
