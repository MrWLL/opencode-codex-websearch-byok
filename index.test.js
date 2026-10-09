import assert from "node:assert/strict"
import { createServer } from "node:http"
import { once } from "node:events"
import { mkdtempSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import plugin from "./index.js"

test("registers the websearch override and applies explicit config precedence", async () => {
  let authorization
  let model
  const server = createServer(async (req, res) => {
    authorization = req.headers.authorization
    let body = ""
    for await (const chunk of req) body += chunk
    model = JSON.parse(body).model
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({ output: [{ type: "web_search_call", action: { sources: [{ url: "https://example.org/paper" }] } }] }))
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const directory = mkdtempSync(join(tmpdir(), "oc2-search-test-"))
  const configFile = join(directory, "config.json")
  writeFileSync(configFile, JSON.stringify({
    responsesUrl: `http://127.0.0.1:${server.address().port}/v1/responses`,
    apiKey: "file-key",
    model: "file-model",
    timeoutSeconds: 300,
  }))
  process.env.OC2_WEBSEARCH_TEST_KEY = "env-key"
  try {
    let registered
    await plugin.setup({
      options: { configFile, apiKeyEnv: "OC2_WEBSEARCH_TEST_KEY" },
      tool: { transform: async (callback) => callback({ add: (tool) => { registered = tool } }) },
    })
    assert.equal(plugin.id, "codex.websearch.byok")
    assert.equal(registered.name, "websearch")
    assert.equal(registered.options.permission, "websearch")
    const result = await registered.execute({ query: "test" }, { signal: new AbortController().signal })
    assert.match(result.content, /https:\/\/example.org\/paper/)
    assert.equal(authorization, "Bearer env-key")
    assert.equal(model, "file-model")
  } finally {
    delete process.env.OC2_WEBSEARCH_TEST_KEY
    unlinkSync(configFile)
    rmdirSync(directory)
    server.close()
    await once(server, "close")
  }
})

test("loads concurrency and silent retry settings from the local config file", async () => {
  let active = 0
  let peak = 0
  const attempts = new Map()
  const times = new Map()
  const server = createServer(async (req, res) => {
    let body = ""
    for await (const chunk of req) body += chunk
    const query = JSON.parse(body).input
    attempts.set(query, (attempts.get(query) ?? 0) + 1)
    times.set(query, [...(times.get(query) ?? []), Date.now()])
    peak = Math.max(peak, ++active)
    setTimeout(() => {
      active--
      res.writeHead(200, { "content-type": "text/event-stream" })
      const event = query === "retry" && attempts.get(query) === 1
        ? { type: "error", error: { code: "server_error", message: "temporary" } }
        : { type: "response.completed", response: { output: [{ type: "web_search_call", action: { sources: [{ url: "https://example.org/paper" }] } }] } }
      res.end(`data: ${JSON.stringify(event)}\n\n`)
    }, 40)
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const directory = mkdtempSync(join(tmpdir(), "oc2-search-test-"))
  const configFile = join(directory, "config.json")
  writeFileSync(configFile, JSON.stringify({ responsesUrl: `http://127.0.0.1:${server.address().port}`, apiKey: "test-key", model: "test-model", timeoutSeconds: 600, maxConcurrency: 1, maxRetries: 1, retryDelaySeconds: 1 }))
  try {
    let registered
    await plugin.setup({ options: { configFile }, tool: { transform: async (callback) => callback({ add: (tool) => { registered = tool } }) } })
    const signal = new AbortController().signal
    const results = await Promise.all([
      registered.execute({ query: "retry" }, { signal }),
      registered.execute({ query: "other" }, { signal }),
    ])
    assert.equal(peak, 1)
    assert.equal(attempts.get("retry"), 2)
    assert.equal(attempts.get("other"), 1)
    const wait = times.get("retry")[1] - times.get("retry")[0]
    assert.ok(wait >= 950 && wait < 2500)
    assert.match(results[0].content, /Sources/)
    assert.doesNotMatch(results[0].content, /temporary|server_error/)
  } finally {
    unlinkSync(configFile)
    rmdirSync(directory)
    server.close()
    await once(server, "close")
  }
})
