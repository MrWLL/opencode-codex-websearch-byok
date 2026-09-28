# OpenCode 2 的 Codex Web Search BYOK 插件

将 OpenCode 2 的 `websearch` 工具接到 Responses 兼容端点。插件通过远端的 `web_search` 工具检索，返回来源链接和搜索摘要。OpenCode 的对话模型可以使用其他服务商。

已于 2026-09-28 在 OpenCode `v2.0.10` 上测试。插件通过 `ctx.tool.transform(...editor.add(...))` 注册 `websearch`。升级 OpenCode 后，请检查工具注册、输入参数、执行和权限是否仍正常。

[English README](./README.md)

## 搜索选项

- 用 `query` 搜索一次，或用 `queries` 提交最多四条查询；同时执行的请求最多三条。
- 用 `allowedDomains` 或 `blockedDomains` 限定网站。
- 可设置 `recencyDays`、`maxResults` 和 `searchContextSize`。
- 每条请求都可设置超时，默认 300 秒。

`recencyDays` 让远端模型优先查找近期来源。`maxResults` 限制每条查询展示的链接数。

## 使用条件

- OpenCode 2
- 支持 `web_search` 并返回来源 URL 的 Responses 兼容 `/v1/responses` 端点
- 该端点的 URL、API Key 和模型名称

## 安装

包发布后，将它加入 OpenCode 的全局配置：

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["opencode-codex-websearch-byok@<VERSION>"]
}
```

本地开发时，可将插件目录放在 `~/.config/opencode/plugins/` 下，或把目录路径加入 `plugins`。参见 [OpenCode 插件加载说明](https://opencode.ai/v2/docs/plugins)。

安装此包前，请移除先前安装的 `research-websearch`；两者都会注册 `websearch`。

通过 `configFile` 指向仓库外的本地 JSON 文件：

```json
{
  "plugins": [
    {
      "package": "opencode-codex-websearch-byok@<VERSION>",
      "options": { "configFile": "/path/to/search-config.json" }
    }
  ]
}
```

本地配置文件内容：

```json
{
  "responsesUrl": "https://your-gateway.example/v1/responses",
  "apiKey": "YOUR_KEY",
  "model": "YOUR_SEARCH_MODEL",
  "timeoutSeconds": 300
}
```

`timeoutSeconds` 接受 1–3600 的整数，默认 300。每条查询独立计时，后续批次的查询也从发起请求时开始计时。旧配置项 `timeoutMs` 仍可使用，范围为 1–3,600,000 毫秒；同一文件中同时设置两项时，以 `timeoutSeconds` 为准。

也可以在启动 OpenCode 的进程环境中设置 URL、模型和 Key：

```text
OC2_CODEX_RESPONSES_URL=https://your-gateway.example/v1/responses
OC2_CODEX_RESPONSES_MODEL=your-search-model
OC2_CODEX_RESPONSES_API_KEY=your-secret-key
```

显式指定的 `configFile` 优先于这些环境变量。`apiKeyEnv` 可指定另一个存放 Key 的环境变量。本地安装也兼容旧版 `research-websearch.json` 文件和 `OC2_RESEARCH_WEBSEARCH_*` 环境变量。

如果 OpenCode 配置限制了网页搜索，请允许 `websearch` 权限：

```json
{
  "permissions": [
    { "action": "websearch", "resource": "*", "effect": "allow" }
  ]
}
```

重启 OpenCode 后运行一次搜索，检查结果中是否有来源 URL。

## 开发

```sh
npm test
npm pack --dry-run --json
```
