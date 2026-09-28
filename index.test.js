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
