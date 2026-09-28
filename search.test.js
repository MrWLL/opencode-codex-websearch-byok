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
  assert.equal(normalizeInput({ queries: ["a", "b"] }).queries.length, 2)
})

test("requires a real search call and source URL", () => {
  assert.throws(() => parseResponse({ output: [{ type: "message", content: [] }] }), /did not perform/)
  assert.throws(() => parseResponse({ output: [{ type: "web_search_call", action: { sources: [] } }] }), /no valid source/)
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
      runSearch({ query: "test" }, { responsesUrl: `http://127.0.0.1:${server.address().port}/v1/responses`, apiKey: "test-key", model: "test-model" }),
      /HTTP 503/,
    )
  } finally {
    server.close()
    await once(server, "close")
  }
})
