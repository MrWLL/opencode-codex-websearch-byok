# OpenCode 2 的 Codex Web Search BYOK 插件

此插件同名覆盖 OpenCode 2 的 `websearch` 工具，把搜索请求发送到你单独配置的 **Responses 兼容 `/v1/responses` 端点**，并要求远端调用 `web_search`。它适合已有支持该接口的 Codex 搜索网关、希望把搜索配置与 OpenCode 使用的对话模型分开的用户。

> 这是社区插件，与 OpenAI、Codex 和 OpenCode 均无官方隶属关系。它调用 Responses `web_search`，**不直接调用 Codex Agent 的 `alpha/search` 或完整 `web.run` 接口**；也不读取 Codex、pi Agent 或 OpenCode 的登录凭据。

**已验证的宿主版本：OpenCode `v2.0.10`（2026-09-28 核对）。** 本插件使用 v2 默认导出 `id`、`setup(ctx)`，并通过 `ctx.tool.transform(...editor.add(...))` 同名覆盖 `websearch`。以后升级 OpenCode 时，应复查插件发现、覆盖顺序、JSON Schema 参数、Promise 工具执行和 `websearch` 权限；其他 v2 版本尚未验证。

英文安装说明见 [README.md](./README.md)。

## 功能

- 保持模型看到的工具名为 `websearch`，并支持 `query` 或一次提交 1–4 条 `queries`。
- 每条远端检索请求可单独设置超时，默认 300 秒。
- 可设置 `allowedDomains`、`blockedDomains`、`recencyDays`、`maxResults`、`searchContextSize`。
- 输出可核查的来源 URL，并把远端回答标为“需要核对的摘要”。
- 没有真正发生远端搜索、没有来源 URL 或远端报错时明确失败；不会自动转回 Exa 等服务。
- 只做搜索，不提供网页抓取、PDF 阅读或学术数据库专用 API。

`recencyDays` 是给远端模型的时间偏好，**不保证严格过滤日期**。`maxResults` 限制展示来源的数量，不保证远端返回足量结果。搜索摘要的相关性和准确性仍取决于远端服务及查询措辞。

## 安装与配置

发布 npm 包后，在 OpenCode 2 的全局 `opencode.json` 的 `plugins` 数组里加入 `opencode-codex-websearch-byok@<VERSION>`。当前也可以把插件目录放入全局 `~/.config/opencode/plugins/` 下进行本地安装。[OpenCode 2 插件目录规则](https://opencode.ai/v2/docs/plugins)

如果以前在本机以 `research-websearch` 目录安装过旧版，改用 npm 包前要先移除或禁用旧目录。两份插件都会注册同名 `websearch`，同时加载时最终覆盖结果取决于加载顺序。

推荐用环境变量提供凭据：

```text
OC2_CODEX_RESPONSES_URL=https://your-gateway.example/v1/responses
OC2_CODEX_RESPONSES_MODEL=your-search-model
OC2_CODEX_RESPONSES_API_KEY=your-secret-key
```

这三个变量要在**启动 OpenCode 的进程环境**中设置。URL 必须是完整的 Responses endpoint。不要把真实值写进项目仓库。也可以在 `plugins` 的对象选项中传入 `configFile`，指向机器上单独保存的 JSON：

```json
{
  "responsesUrl": "https://your-gateway.example/v1/responses",
  "apiKey": "YOUR_KEY",
  "model": "YOUR_SEARCH_MODEL",
  "timeoutSeconds": 300
}
```

`timeoutSeconds` 可省略，默认 300，接受 1–3600 的整数。请把它写在本地独立 JSON 配置文件中；插件条目的 `options` 也支持这个字段，**没有超时时间环境变量**。**每条 query 独立计时**；第四条 query 如在下一批执行，也会得到完整的超时时间，因此整次四条检索可能超过 300 秒。旧版 `timeoutMs` 仍可用，范围为 1–3,600,000 毫秒；同一配置来源同时写两项时优先使用 `timeoutSeconds`。

`configFile` 文件不要提交到 Git。插件在全局插件目录中安装时，也兼容读取 OpenCode 全局配置目录下的 `research-websearch.json` 以及旧版 `OC2_RESEARCH_WEBSEARCH_*` 环境变量，以便已有本地安装继续工作。新 `OC2_CODEX_RESPONSES_*` 环境变量优先于自动发现的旧配置文件；显式指定的 `configFile` 优先于环境变量；指定 `apiKeyEnv` 时，该变量优先于上述两者。旧配置里若明确写有 `timeoutMs`，会沿用那个值，可改成 `timeoutSeconds` 来设置新的超时。

若 OpenCode 配置曾拒绝 `websearch`，需允许该权限。OpenCode 2 格式：

```json
{ "permissions": [{ "action": "websearch", "resource": "*", "effect": "allow" }] }
```

重启 OpenCode 后用一个简单查询检查来源 URL。源码目录运行 `npm test` 可检查解析和错误处理。插件已在 OpenCode v2.0.10 本地验证。
