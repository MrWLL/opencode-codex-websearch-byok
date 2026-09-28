import { existsSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { inputSchema, runSearch } from "./search.js"

export default {
  id: "codex.websearch.byok",
  async setup(ctx) {
    const options = ctx.options ?? {}
    let fileConfig = {}
    const defaultConfigFile = fileURLToPath(new URL("../../research-websearch.json", import.meta.url))
    const explicitConfigFile = options.configFile !== undefined
    if (explicitConfigFile && (typeof options.configFile !== "string" || !options.configFile.trim())) throw new Error("configFile must be a non-empty path")
    const configFile = options.configFile ?? (existsSync(defaultConfigFile) ? defaultConfigFile : undefined)
    if (configFile) {
      let text
      try { text = readFileSync(configFile, "utf8") }
      catch { throw new Error(`Cannot read websearch config file: ${configFile}`) }
      try { fileConfig = JSON.parse(text) }
      catch { throw new Error(`Invalid JSON in websearch config file: ${configFile}`) }
      if (!fileConfig || typeof fileConfig !== "object" || Array.isArray(fileConfig)) throw new Error(`Websearch config file must contain a JSON object: ${configFile}`)
    }
    const primaryFileConfig = explicitConfigFile ? fileConfig : {}
    const legacyFileConfig = explicitConfigFile ? {} : fileConfig
    const timeoutConfig = options.timeoutSeconds !== undefined || options.timeoutMs !== undefined ? options : fileConfig
    const config = {
      responsesUrl: options.responsesUrl ?? primaryFileConfig.responsesUrl ?? process.env.OC2_CODEX_RESPONSES_URL ?? legacyFileConfig.responsesUrl ?? process.env.OC2_RESEARCH_WEBSEARCH_URL,
      model: options.model ?? primaryFileConfig.model ?? process.env.OC2_CODEX_RESPONSES_MODEL ?? legacyFileConfig.model ?? process.env.OC2_RESEARCH_WEBSEARCH_MODEL,
      apiKey: options.apiKeyEnv ? process.env[options.apiKeyEnv] : primaryFileConfig.apiKey ?? process.env.OC2_CODEX_RESPONSES_API_KEY ?? legacyFileConfig.apiKey ?? process.env.OC2_RESEARCH_WEBSEARCH_API_KEY,
      timeoutSeconds: timeoutConfig.timeoutSeconds,
      timeoutMs: timeoutConfig.timeoutMs,
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
