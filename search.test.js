import assert from "node:assert/strict"
import { createServer } from "node:http"
import { once } from "node:events"
import { test } from "node:test"
import { normalizeInput, parseResponse, runSearch } from "./search.js"

const sample = {
  output: [
    { type: "web_search_call", action: { sources: [{ url: "https://example.org/paper", title: "Paper" }] } },
    { type: "message", content: [{ type: "output_text", text: "A cited result.", annotations: [{ type: "url_citation", url: "https://example.org/paper", title: "Paper" }] }] },
  ],
}

test("validates mutually exclusive query forms and domains", () => {
  assert.throws(() => normalizeInput({ query: "a", queries: ["b"] }), /exactly one/)
  assert.throws(() => normalizeInput({ query: "a", allowedDomains: ["https://example.org/"] }), /domain names/)
  assert.throws(() => normalizeInput({ query: "a", allowedDomains: ["example.org"], blockedDomains: ["other.org"] }), /either allowedDomains or blockedDomains/)
  assert.equal(normalizeInput({ queries: ["a", "b"] }).queries.length, 2)
})

test("requires a real search call and source URL", () => {
  assert.throws(() => parseResponse({ output: [{ type: "message", content: [] }] }), /did not perform/)
  assert.throws(() => parseResponse({ output: [{ type: "web_search_call", action: { sources: [] } }] }), /no valid source/)
  assert.throws(() => parseResponse({ ...sample, status: "incomplete", incomplete_details: { reason: "max_output_tokens" } }), /max_output_tokens/)
  assert.throws(() => parseResponse({ output: [{ ...sample.output[0], status: "failed" }] }), /web_search failed/)
  assert.equal(parseResponse(sample).sources.length, 1)
})

test("sends Responses search controls and parses an SSE result", async () => {
  const requests = []
  const server = createServer(async (req, res) => {
    let body = ""
    for await (const chunk of req) body += chunk
    requests.push({ auth: req.headers.authorization, body: JSON.parse(body) })
    res.writeHead(200, { "content-type": "text/event-stream" })
    res.end(`event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: sample })}\n\n`)
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  try {
    const text = await runSearch(
      { queries: ["angle one", "angle two"], allowedDomains: ["example.org"], maxResults: 3 },
      { responsesUrl: `http://127.0.0.1:${server.address().port}/v1/responses`, apiKey: "test-key", model: "test-model" },
    )
    assert.equal(requests.length, 2)
    assert.equal(requests[0].auth, "Bearer test-key")
    assert.equal(requests[0].body.tool_choice, "required")
    assert.deepEqual(requests[0].body.tools[0].filters.allowed_domains, ["example.org"])
    assert.match(text, /https:\/\/example.org\/paper/)
    assert.match(text, /Remote summary/)
  } finally {
    server.close()
    await once(server, "close")
  }
})

test("reports remote HTTP failures without fallback", async () => {
  const server = createServer((_req, res) => { res.writeHead(503); res.end("unavailable") })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  try {
    await assert.rejects(
      runSearch({ query: "test" }, { responsesUrl: `http://127.0.0.1:${server.address().port}/v1/responses`, apiKey: "test-key", model: "test-model", maxRetries: 0 }),
      /HTTP 503/,
    )
  } finally {
    server.close()
    await once(server, "close")
  }
})

test("times out each remote query independently", async () => {
  const server = createServer(async (req, res) => {
    let body = ""
    for await (const chunk of req) body += chunk
    const query = JSON.parse(body).input
    setTimeout(() => {
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify(sample))
    }, query === "fourth" ? 650 : 750)
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  try {
    const started = Date.now()
    const result = await runSearch(
      { queries: ["first", "second", "third", "fourth"] },
      { responsesUrl: `http://127.0.0.1:${server.address().port}/v1/responses`, apiKey: "test-key", model: "test-model", timeoutSeconds: 1 },
    )
    assert.ok(Date.now() - started > 1000)
    assert.match(result, /Query: fourth/)
  } finally {
    server.close()
    await once(server, "close")
  }
})

test("reports a per-query timeout and rejects invalid timeout settings", async () => {
  const server = createServer((_req, _res) => {})
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const config = { responsesUrl: `http://127.0.0.1:${server.address().port}/v1/responses`, apiKey: "test-key", model: "test-model", maxRetries: 0 }
  try {
    await assert.rejects(runSearch({ query: "test" }, { ...config, timeoutSeconds: 0 }), /timeoutSeconds/)
    await assert.rejects(runSearch({ query: "test" }, { ...config, timeoutMs: "300000" }), /timeoutMs/)
    await assert.rejects(runSearch({ query: "test" }, { ...config, timeoutSeconds: 1 }), /timed out after 1 second/)
  } finally {
    server.closeAllConnections()
    server.close()
    await once(server, "close")
  }
})

test("shares a concurrency limit across simultaneous tool calls", async () => {
  let active = 0
  let peak = 0
  let requests = 0
  const server = createServer(async (req, res) => {
    for await (const _chunk of req) {}
    requests++
    peak = Math.max(peak, ++active)
    setTimeout(() => {
      active--
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify(sample))
    }, 40)
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const config = { responsesUrl: `http://127.0.0.1:${server.address().port}/v1/responses`, apiKey: "test-key", model: "test-model", maxConcurrency: 2 }
  try {
    const results = await Promise.all([
      runSearch({ queries: ["a", "b", "c", "d"] }, config),
      runSearch({ queries: ["e", "f", "g", "h"] }, config),
    ])
    assert.equal(requests, 8)
    assert.equal(peak, 2)
    assert.match(results[0], /Query: d/)
    assert.match(results[1], /Query: h/)
  } finally {
    server.close()
    await once(server, "close")
  }
})

test("keeps nested stream errors internal until an interval retry succeeds", async () => {
  const times = []
  let settled = false
  const server = createServer(async (req, res) => {
    for await (const _chunk of req) {}
    times.push(Date.now())
    res.writeHead(200, { "content-type": "text/event-stream" })
    const event = times.length < 3
      ? { type: "error", error: { code: "server_error", message: "Temporary backend failure, request ID test-id" } }
      : { type: "response.completed", response: sample }
    res.end(`data: ${JSON.stringify(event)}\n\n`)
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  try {
    const pending = runSearch({ query: "test" }, { responsesUrl: `http://127.0.0.1:${server.address().port}/v1/responses`, apiKey: "test-key", model: "test-model", maxRetries: 2, retryDelaySeconds: 1 })
    pending.then(() => { settled = true }, () => { settled = true })
    await new Promise((resolve) => setTimeout(resolve, 150))
    assert.equal(times.length, 1)
    assert.equal(settled, false)
    const result = await pending
    assert.equal(times.length, 3)
    assert.ok(times[1] - times[0] >= 950)
    assert.ok(times[2] - times[1] >= 1950)
    assert.match(result, /https:\/\/example.org\/paper/)
    assert.doesNotMatch(result, /server_error|test-id|failure/)
  } finally {
    server.close()
    await once(server, "close")
  }
})

test("reports the detailed final error only after retry exhaustion", async () => {
  let attempts = 0
  const server = createServer(async (req, res) => {
    for await (const _chunk of req) {}
    attempts++
    res.writeHead(200, { "content-type": "text/event-stream" })
    res.end(`data: ${JSON.stringify({ type: "error", error: { code: "server_error", message: "Backend failure, request ID final-id" } })}\n\n`)
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  try {
    await assert.rejects(runSearch({ query: "test" }, { responsesUrl: `http://127.0.0.1:${server.address().port}/v1/responses`, apiKey: "test-key", model: "test-model", maxRetries: 2, retryDelaySeconds: 1 }), /failed after 3 attempts: \[server_error\].*final-id/)
    assert.equal(attempts, 3)
  } finally {
    server.close()
    await once(server, "close")
  }
})

test("does not retry authentication failures or cancellation during backoff", async () => {
  let attempts = 0
  const server = createServer(async (req, res) => {
    for await (const _chunk of req) {}
    attempts++
    res.writeHead(req.url === "/auth" ? 401 : 503)
    res.end("failure")
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const base = `http://127.0.0.1:${server.address().port}`
  const config = { responsesUrl: `${base}/auth`, apiKey: "test-key", model: "test-model", maxRetries: 2, retryDelaySeconds: 1 }
  try {
    await assert.rejects(runSearch({ query: "test" }, config), /HTTP 401/)
    assert.equal(attempts, 1)
    const controller = new AbortController()
    const pending = runSearch({ query: "test" }, { ...config, responsesUrl: `${base}/retry` }, controller.signal)
    const rejected = assert.rejects(pending, (error) => error.name === "AbortError")
    await new Promise((resolve) => setTimeout(resolve, 150))
    controller.abort()
    await rejected
    assert.equal(attempts, 2)
  } finally {
    server.close()
    await once(server, "close")
  }
})

test("cancels queued requests and frees capacity for subsequent calls", async () => {
  let requests = 0
  const server = createServer(async (req, res) => {
    let body = ""
    for await (const chunk of req) body += chunk
    requests++
    if (JSON.parse(body).input === "held") return
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify(sample))
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const config = { responsesUrl: `http://127.0.0.1:${server.address().port}`, apiKey: "test-key", model: "test-model", maxConcurrency: 1 }
  try {
    const controller = new AbortController()
    const pending = runSearch({ queries: ["held", "queued", "also queued"] }, config, controller.signal)
    const rejected = assert.rejects(pending)
    await new Promise((resolve) => setTimeout(resolve, 100))
    controller.abort()
    await rejected
    assert.equal(requests, 1)
    assert.match(await runSearch({ query: "after cancel" }, config), /Sources/)
    assert.equal(requests, 2)
  } finally {
    server.closeAllConnections()
    server.close()
    await once(server, "close")
  }
})

test("retries HTTP 429 after Retry-After and gives each attempt its own timeout", async () => {
  const times = []
  const server = createServer(async (req, res) => {
    for await (const _chunk of req) {}
    times.push(Date.now())
    if (times.length === 1) {
      res.writeHead(429, { "retry-after": "2" })
      res.end("rate limited")
    } else {
      setTimeout(() => {
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify(sample))
      }, 650)
    }
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  try {
    const result = await runSearch({ query: "test" }, { responsesUrl: `http://127.0.0.1:${server.address().port}`, apiKey: "test-key", model: "test-model", timeoutSeconds: 1, maxRetries: 1, retryDelaySeconds: 1 })
    assert.equal(times.length, 2)
    assert.ok(times[1] - times[0] >= 1950)
    assert.match(result, /Sources/)
  } finally {
    server.close()
    await once(server, "close")
  }
})

test("retries an expired attempt while preserving successful sibling queries", async () => {
  const attempts = new Map()
  const server = createServer(async (req, res) => {
    let body = ""
    for await (const chunk of req) body += chunk
    const query = JSON.parse(body).input
    attempts.set(query, (attempts.get(query) ?? 0) + 1)
    if (query === "slow" && attempts.get(query) === 1) return
    setTimeout(() => {
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify(sample))
    }, 600)
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  try {
    const result = await runSearch({ queries: ["fast", "slow"] }, { responsesUrl: `http://127.0.0.1:${server.address().port}`, apiKey: "test-key", model: "test-model", timeoutSeconds: 1, maxRetries: 1, retryDelaySeconds: 1 })
    assert.equal(attempts.get("fast"), 1)
    assert.equal(attempts.get("slow"), 2)
    assert.match(result, /Query: fast/)
    assert.match(result, /Query: slow/)
  } finally {
    server.closeAllConnections()
    server.close()
    await once(server, "close")
  }
})

test("preserves a typed authentication stream error without retrying", async () => {
  let attempts = 0
  const server = createServer(async (req, res) => {
    for await (const _chunk of req) {}
    attempts++
    res.writeHead(200, { "content-type": "text/event-stream" })
    res.end(`data: ${JSON.stringify({ type: "error", error: { type: "authentication_error", message: "Invalid key" } })}\n\n`)
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  try {
    await assert.rejects(runSearch({ query: "test" }, { responsesUrl: `http://127.0.0.1:${server.address().port}`, apiKey: "test-key", model: "test-model" }), /\[authentication_error\] Invalid key/)
    assert.equal(attempts, 1)
  } finally {
    server.close()
    await once(server, "close")
  }
})

test("defaults to a 600-second request timeout and validates local execution settings", async () => {
  const originalFetch = globalThis.fetch
  const originalTimeout = AbortSignal.timeout
  const timeouts = []
  globalThis.fetch = async () => new Response(JSON.stringify(sample), { headers: { "content-type": "application/json" } })
  AbortSignal.timeout = (milliseconds) => { timeouts.push(milliseconds); return originalTimeout(milliseconds) }
  const config = { responsesUrl: "https://example.org/v1/responses", apiKey: "test-key", model: "test-model" }
  try {
    assert.match(await runSearch({ query: "test" }, config), /Sources/)
    assert.deepEqual(timeouts, [600000])
    for (const [name, value] of [["maxConcurrency", 0], ["maxConcurrency", 9], ["maxRetries", -1], ["maxRetries", 6], ["retryDelaySeconds", 0], ["retryDelaySeconds", 301]]) {
      await assert.rejects(runSearch({ query: "test" }, { ...config, [name]: value }), new RegExp(name))
    }
  } finally {
    globalThis.fetch = originalFetch
    AbortSignal.timeout = originalTimeout
  }
})
