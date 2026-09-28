const MAX_QUERIES = 4
const MAX_RESULTS = 20
const DEFAULT_RESULTS = 8
const DEFAULT_TIMEOUT_MS = 300_000
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024

export const inputSchema = {
  type: "object",
  properties: {
    query: { type: "string", description: "One web search query. Use specific scientific terms, paper titles, DOI, or site names when useful." },
    queries: { type: "array", items: { type: "string" }, minItems: 1, maxItems: MAX_QUERIES, description: "Two to four distinct search angles for a research question. Each query runs separately; avoid near duplicates." },
    allowedDomains: { type: "array", items: { type: "string" }, description: "Optional strict domain allowlist, such as pubmed.ncbi.nlm.nih.gov or nature.com. Domain names only." },
    blockedDomains: { type: "array", items: { type: "string" }, description: "Optional strict domain blocklist. Domain names only." },
    recencyDays: { type: "integer", minimum: 1, maximum: 3650, description: "Prefer sources from this many recent days. This is a preference, not a strict date filter." },
    maxResults: { type: "integer", minimum: 1, maximum: MAX_RESULTS, description: "Maximum source links returned per query, default 8. The remote search may find fewer." },
    searchContextSize: { type: "string", enum: ["low", "medium", "high"], description: "Remote web search context size; default medium. High may use more time and tokens." },
  },
  additionalProperties: false,
}

function nonempty(value, name) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be a non-empty string`)
  return value.trim()
}

function domains(value, name) {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length > 100) throw new Error(`${name} must be an array of at most 100 domains`)
  const list = value.map((item) => {
    const domain = nonempty(item, name).toLowerCase()
    if (!/^(?:[a-z0-9-]+\.)+[a-z0-9-]+$/.test(domain)) throw new Error(`${name} must contain domain names without scheme or path`)
    return domain
  })
  return [...new Set(list)]
}

export function normalizeInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("websearch input must be an object")
  const hasQuery = input.query !== undefined
  const hasQueries = input.queries !== undefined
  if (hasQuery === hasQueries) throw new Error("Provide exactly one of query or queries")
  const queries = hasQuery ? [nonempty(input.query, "query")] : input.queries
  if (!Array.isArray(queries) || queries.length < 1 || queries.length > MAX_QUERIES) throw new Error("queries must contain 1 to 4 items")
  const cleanQueries = queries.map((query) => nonempty(query, "query"))
  if (new Set(cleanQueries.map((query) => query.toLowerCase())).size !== cleanQueries.length) throw new Error("queries must not contain duplicates")
  const maxResults = input.maxResults ?? DEFAULT_RESULTS
  if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > MAX_RESULTS) throw new Error("maxResults must be 1 to 20")
  if (input.recencyDays !== undefined && (!Number.isInteger(input.recencyDays) || input.recencyDays < 1 || input.recencyDays > 3650)) throw new Error("recencyDays must be 1 to 3650")
  const searchContextSize = input.searchContextSize ?? "medium"
  if (!["low", "medium", "high"].includes(searchContextSize)) throw new Error("searchContextSize must be low, medium, or high")
  if (input.allowedDomains?.length && input.blockedDomains?.length) throw new Error("Use either allowedDomains or blockedDomains, not both")
  return {
    queries: cleanQueries,
    allowedDomains: domains(input.allowedDomains, "allowedDomains"),
    blockedDomains: domains(input.blockedDomains, "blockedDomains"),
    recencyDays: input.recencyDays,
    maxResults,
    searchContextSize,
  }
}

function validSource(url) {
  if (typeof url !== "string") return undefined
  try {
    const parsed = new URL(url)
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.href : undefined
  } catch {
    return undefined
  }
}

export function parseResponse(payload) {
  if (payload?.status && payload.status !== "completed") {
    throw new Error(payload.error?.message ?? payload.incomplete_details?.reason ?? `Remote response ${payload.status}`)
  }
  const output = Array.isArray(payload?.output) ? payload.output : []
  if (!output.some((item) => item?.type === "web_search_call")) throw new Error("Remote response did not perform web_search")
  const failedSearch = output.find((item) => item?.type === "web_search_call" && (item.status === "failed" || item.status === "incomplete"))
  if (failedSearch) throw new Error(`Remote web_search ${failedSearch.status}`)
  const sources = new Map()
  const add = (url, title, snippet) => {
    const href = validSource(url)
    if (!href) return
    const old = sources.get(href)
    sources.set(href, {
      url: href,
      title: typeof title === "string" && title.trim() ? title.trim() : old?.title ?? href,
      snippet: typeof snippet === "string" && snippet.trim() ? snippet.trim() : old?.snippet ?? "",
    })
  }
  const answers = []
  for (const item of output) {
    if (item?.type === "message" && Array.isArray(item.content)) {
      for (const part of item.content) {
        if (typeof part?.text === "string" && part.text.trim()) answers.push(part.text.trim())
        if (Array.isArray(part?.annotations)) {
          for (const annotation of part.annotations) {
            if (annotation?.type === "url_citation") add(annotation.url, annotation.title)
          }
        }
      }
    }
    if (item?.type === "web_search_call") {
      for (const group of [item.action?.sources, item.sources, item.results]) {
        if (Array.isArray(group)) {
          for (const source of group) add(source?.url ?? source?.source_website_url, source?.title ?? source?.caption, source?.snippet ?? source?.content)
        }
      }
    }
  }
  if (sources.size === 0) throw new Error("Remote search returned no valid source URLs")
  return { answer: answers.join("\n\n"), sources: [...sources.values()] }
}

function decodeResponseText(text, contentType) {
  if (contentType.includes("text/event-stream") || text.startsWith("data:") || text.startsWith("event:")) {
    let completed
    for (const block of text.split(/\r?\n\r?\n/)) {
      const data = block.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n")
      if (!data || data === "[DONE]") continue
      let event
      try { event = JSON.parse(data) } catch { throw new Error("Remote stream contained invalid JSON") }
      if (event.type === "response.failed" || event.type === "response.incomplete" || event.type === "error") {
        throw new Error(event.response?.error?.message ?? event.response?.incomplete_details?.reason ?? event.message ?? `Remote stream ${event.type}`)
      }
      if (event.type === "response.completed") completed = event.response
    }
    if (!completed) throw new Error("Remote stream ended without response.completed")
    return completed
  }
  try { return JSON.parse(text) } catch { throw new Error("Remote response was not valid JSON or SSE") }
}

function requestBody(query, input, model) {
  const filters = {}
  if (input.allowedDomains?.length) filters.allowed_domains = input.allowedDomains
  if (input.blockedDomains?.length) filters.blocked_domains = input.blockedDomains
  const instructions = [
    "Search the live web. Return a concise, evidence-grounded answer and cite source URLs. Do not invent papers, titles, DOIs, or publication dates.",
    input.recencyDays ? `Prefer sources from the past ${input.recencyDays} days; this is not a strict date filter.` : "",
    `Prefer up to ${input.maxResults} distinct useful sources.`,
  ].filter(Boolean).join(" ")
  return {
    model,
    instructions,
    input: query,
    tools: [{ type: "web_search", search_context_size: input.searchContextSize, ...(Object.keys(filters).length ? { filters } : {}) }],
    tool_choice: "required",
    include: ["web_search_call.action.sources"],
    store: false,
    stream: true,
  }
}

async function oneSearch(query, input, config, signal) {
  const timeoutSignal = AbortSignal.timeout(config.timeoutMs)
  try {
    const response = await fetch(config.responsesUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
        "OpenAI-Beta": "responses=experimental",
      },
      body: JSON.stringify(requestBody(query, input, config.model)),
      signal: AbortSignal.any([signal, timeoutSignal]),
    })
    if (!response.ok) throw new Error(`Remote search HTTP ${response.status}`)
    const text = await readResponseText(response)
    return parseResponse(decodeResponseText(text, response.headers.get("content-type") ?? ""))
  } catch (error) {
    if (timeoutSignal.aborted && !signal.aborted) {
      const seconds = config.timeoutMs / 1000
      throw new Error(`Remote search timed out after ${seconds} second${seconds === 1 ? "" : "s"}`, { cause: error })
    }
    throw error
  }
}

async function readResponseText(response) {
  if (!response.body) throw new Error("Remote response body was empty")
  const decoder = new TextDecoder()
  let text = ""
  let bytes = 0
  for await (const chunk of response.body) {
    bytes += chunk.byteLength
    if (bytes > MAX_RESPONSE_BYTES) throw new Error("Remote response exceeded 8 MiB")
    text += decoder.decode(chunk, { stream: true })
  }
  return text + decoder.decode()
}

function getTimeoutMs(config) {
  if (config.timeoutSeconds !== undefined) {
    if (!Number.isInteger(config.timeoutSeconds) || config.timeoutSeconds < 1 || config.timeoutSeconds > 3600) {
      throw new Error("timeoutSeconds must be an integer from 1 to 3600")
    }
    return config.timeoutSeconds * 1000
  }
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3_600_000) {
    throw new Error("timeoutMs must be an integer from 1 to 3600000")
  }
  return timeoutMs
}

export async function runSearch(rawInput, config, signal = new AbortController().signal) {
  const input = normalizeInput(rawInput)
  const responsesUrl = nonempty(config?.responsesUrl, "responsesUrl")
  let parsedUrl
  try { parsedUrl = new URL(responsesUrl) } catch { throw new Error("responsesUrl must be a valid HTTP or HTTPS URL") }
  if (!["http:", "https:"].includes(parsedUrl.protocol)) throw new Error("responsesUrl must be HTTP or HTTPS")
  if (parsedUrl.username || parsedUrl.password) throw new Error("responsesUrl must not contain credentials")
  const apiKey = nonempty(config?.apiKey, "apiKey")
  const model = nonempty(config?.model, "model")
  const timeoutMs = getTimeoutMs(config)
  const safeConfig = { responsesUrl, apiKey, model, timeoutMs }
  const failed = new AbortController()
  const combinedSignal = AbortSignal.any([signal, failed.signal])
  const batches = []
  try {
    for (let i = 0; i < input.queries.length; i += 3) {
      const queries = input.queries.slice(i, i + 3)
      batches.push(...await Promise.all(queries.map(async (query) => ({ query, result: await oneSearch(query, input, safeConfig, combinedSignal) }))))
    }
  } catch (error) {
    failed.abort(error)
    throw error
  }
  const sections = batches.map(({ query, result }) => {
    const sourceLines = result.sources.slice(0, input.maxResults).map((source, index) => `${index + 1}. ${source.title}\n   ${source.url}${source.snippet ? `\n   ${source.snippet.slice(0, 500)}` : ""}`)
    return `Query: ${query}\n\nSources (${sourceLines.length}):\n${sourceLines.join("\n")}\n\nRemote summary (verify against sources):\n${result.answer || "No summary returned."}`
  })
  return sections.join("\n\n---\n\n")
}
