import { existsSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { inputSchema, runSearch } from "./search.js"

export default {
  id: "codex.websearch.byok",
  async setup(ctx) {
    const options = ctx.options ?? {}
    let fileConfig = {}
    const defaultConfigFile = fileURLToPath(new URL("../../research-websearch.json", import.meta.url))
    const configFile = options.configFile ?? (existsSync(defaultConfigFile) ? defaultConfigFile : undefined)
    if (configFile) fileConfig = JSON.parse(readFileSync(configFile, "utf8"))
    const config = {
      responsesUrl: options.responsesUrl ?? fileConfig.responsesUrl ?? process.env.OC2_CODEX_RESPONSES_URL ?? process.env.OC2_RESEARCH_WEBSEARCH_URL,
      model: options.model ?? fileConfig.model ?? process.env.OC2_CODEX_RESPONSES_MODEL ?? process.env.OC2_RESEARCH_WEBSEARCH_MODEL,
      apiKey: fileConfig.apiKey ?? (options.apiKeyEnv ? process.env[options.apiKeyEnv] : process.env.OC2_CODEX_RESPONSES_API_KEY ?? process.env.OC2_RESEARCH_WEBSEARCH_API_KEY),
      timeoutMs: options.timeoutMs ?? fileConfig.timeoutMs,
    }
    await ctx.tool.transform((editor) => {
      editor.add({
        name: "websearch",
        description: "Search the live web for research. Use query for one search or queries for 2–4 distinct research angles. Return verifiable source URLs and a clearly marked remote summary. Use allowedDomains or blockedDomains for strict site restrictions. This tool only searches; it does not fetch full pages. Search failures are reported; no fallback provider is used.",
        input: inputSchema,
        options: { permission: "websearch" },
        execute: async (input, context) => ({ content: await runSearch(input, config, context.signal) }),
      })
    })
  },
}
