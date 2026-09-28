# Codex Web Search BYOK for OpenCode v2

An OpenCode v2 plugin that replaces the model-facing `websearch` tool with a search backed by a separately configured, Responses-compatible `/v1/responses` endpoint. The remote model must support the `web_search` tool. Your OpenCode conversation model can be from another provider.

This is a community plugin, unaffiliated with OpenAI, Codex, or OpenCode. It calls Responses `web_search`; it does **not** call Codex Agent's standalone `alpha/search` endpoint or reproduce the full `web.run` tool. It does not read Codex, pi Agent, or OpenCode login credentials.

**Verified host version:** OpenCode `v2.0.10` (checked 2026-09-28). This plugin uses the v2 default-export plugin definition (`id`, `setup(ctx)`) and `ctx.tool.transform(...editor.add(...))` to override the effective `websearch` tool name. When upgrading OpenCode, check that plugin discovery, tool override order, JSON Schema input, Promise tool execution, and the `websearch` permission still work. Other OpenCode v2 versions have not been validated here.

[中文说明](./README.zh-CN.md)

## Features

- Overrides the OpenCode v2 tool named `websearch` rather than adding a competing tool name.
- Accepts one `query` or 1–4 `queries`, with up to three requests in parallel.
- Applies a configurable timeout to each remote search request; the default is 300 seconds per query.
- Supports `allowedDomains`, `blockedDomains`, `recencyDays`, `maxResults`, and `searchContextSize`.
- Displays source URLs before a clearly labeled remote summary.
- Reports remote errors, missing search calls, and missing source URLs without provider fallback.
- Searches only. It does not fetch full pages, read PDFs, or query academic databases directly.

`recencyDays` is a preference in the remote model instructions, not a strict date filter. `maxResults` limits the number of displayed sources per query; it does not guarantee the remote service will find that many. Search relevance and the accuracy of the remote summary depend on the remote service and query wording.

## Requirements

- OpenCode **v2**. Tested locally with v2.0.10.
- A Responses-compatible endpoint that accepts `tools: [{ "type": "web_search" }]` and returns `web_search_call` items with source URLs.
- A URL, API key, and model name for that endpoint. These are configured independently from the OpenCode conversation model.

## Install

After the package is published, add it to the global OpenCode v2 configuration:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["opencode-codex-websearch-byok@<VERSION>"]
}
```

For local development, place the package directory under `~/.config/opencode/plugins/`, or list its path in `plugins`. OpenCode v2 supports both forms. See [OpenCode v2 plugin loading](https://opencode.ai/v2/docs/plugins).

If you previously installed this project locally as `research-websearch`, remove or disable that old plugin directory before adding the npm package. Both versions register the same effective `websearch` tool name, so loading both makes the final override depend on plugin order.

Provide credentials to the OpenCode process through environment variables:

```text
OC2_CODEX_RESPONSES_URL=https://your-gateway.example/v1/responses
OC2_CODEX_RESPONSES_MODEL=your-search-model
OC2_CODEX_RESPONSES_API_KEY=your-secret-key
```

The URL must be the complete Responses endpoint. Do not commit real values. Alternatively, supply a `configFile` option in the plugin entry, pointing to a JSON file kept outside your repository:

```json
{
  "plugins": [
    {
      "package": "opencode-codex-websearch-byok@<VERSION>",
      "options": { "configFile": "/path/outside/repository/search-config.json" }
    }
  ]
}
```

The config file format is:

```json
{
  "responsesUrl": "https://your-gateway.example/v1/responses",
  "apiKey": "YOUR_KEY",
  "model": "YOUR_SEARCH_MODEL",
  "timeoutSeconds": 300
}
```

`timeoutSeconds` is optional and accepts an integer from 1 to 3600. The default is 300. Set it in the local JSON config file. Plugin `options` also accepts it for installations that use inline settings; there is no timeout environment variable. Each query gets its own timer, including queries started in a later batch; a four-query call can therefore take longer than one timeout period. Existing `timeoutMs` settings remain supported (1–3,600,000 milliseconds). If both are present in the same settings source, `timeoutSeconds` wins.

For existing local installs only, the plugin also looks for `research-websearch.json` in OpenCode's global config directory when no `configFile` option is supplied, and accepts the old `OC2_RESEARCH_WEBSEARCH_*` environment variable names. New `OC2_CODEX_RESPONSES_*` environment variables take precedence over values in that automatically discovered legacy file. An explicit `configFile` takes precedence over environment variables. The `apiKeyEnv` plugin option, if set, takes precedence over both. Those compatibility paths do not read pi Agent settings. For an npm installation, use the new environment variables or an explicit `configFile` path.

If OpenCode denies web search, allow the `websearch` permission action:

```json
{
  "permissions": [
    { "action": "websearch", "resource": "*", "effect": "allow" }
  ]
}
```

Restart OpenCode, then ask for a simple web search and check that the result contains source URLs. The plugin never chooses Exa or another provider when the remote call fails.

## Development

```sh
npm test
npm pack --dry-run --json
```

The package has no runtime npm dependencies. The archive is limited by the `files` allowlist in `package.json`. The test suite uses a local mock HTTP server and contains no real credentials.
