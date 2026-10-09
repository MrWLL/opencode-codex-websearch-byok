import { setTimeout as delay } from "node:timers/promises"

const MAX_QUERIES = 4
const MAX_RESULTS = 20
const DEFAULT_RESULTS = 8
const DEFAULT_TIMEOUT_MS = 600_000
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024
const requestLimiters = new WeakMap()

function remoteError(detail, fallback, retryable = false) {
  const code = detail?.code ?? (detail?.type && !detail.type.startsWith("response.") && detail.type !== "error" ? detail.type : undefined)
  const error = new Error(`${code ? `[${code}] ` : ""}${detail?.message ?? fallback}`)
  error.retryable = retryable || ["server_error", "rate_limit_exceeded", "timeout", "overloaded"].includes(code)
  return error
}

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
    throw remoteError(payload.error, payload.incomplete_details?.reason ?? `Remote response ${payload.status}`)
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
        const detail = event.error ?? event.response?.error ?? event
        throw remoteError(detail, event.response?.incomplete_details?.reason ?? `Remote stream ${event.type}`, event.type === "error" && !detail.code && (!detail.type || detail.type === "error"))
      }
      if (event.type === "response.completed") completed = event.response
    }
    if (!completed) throw remoteError(undefined, "Remote stream ended without response.completed", true)
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
    if (!response.ok) {
      const retryable = [408, 429, 500, 502, 503, 504].includes(response.status)
      const error = remoteError(undefined, `Remote search HTTP ${response.status}`, retryable)
      const retryAfter = response.headers.get("retry-after")
      if (retryAfter) {
        const seconds = Number(retryAfter)
        const milliseconds = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryAfter) - Date.now()
        if (Number.isFinite(milliseconds) && milliseconds > 0) error.retryAfterMs = Math.min(milliseconds, 600_000)
      }
      await response.body?.cancel().catch(() => {})
      throw error
    }
    const text = await readResponseText(response)
    return parseResponse(decodeResponseText(text, response.headers.get("content-type") ?? ""))
  } catch (error) {
    if (timeoutSignal.aborted && !signal.aborted) {
      const seconds = config.timeoutMs / 1000
      throw remoteError(undefined, `Remote search timed out after ${seconds} second${seconds === 1 ? "" : "s"}`, true)
    }
    if (!signal.aborted && (error instanceof TypeError || ["ECONNRESET", "ETIMEDOUT", "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT"].includes(error.cause?.code))) error.retryable = true
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

function integerSetting(config, name, fallback, minimum, maximum) {
  const value = config[name] ?? fallback
  if (!Number.isInteger(value) || value < minimum || value > maximum) throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`)
  return value
}

function createLimiter(limit) {
  let active = 0
  const waiting = []
  const drain = () => {
    while (active < limit && waiting.length) waiting.shift().start()
  }
  return (signal) => new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return }
    const entry = {
      start() {
        signal.removeEventListener("abort", abort)
        active++
        let released = false
        resolve(() => {
          if (released) return
          released = true
          active--
          drain()
        })
      },
    }
    const abort = () => {
      const index = waiting.indexOf(entry)
      if (index !== -1) waiting.splice(index, 1)
      reject(signal.reason)
    }
    signal.addEventListener("abort", abort, { once: true })
    waiting.push(entry)
    drain()
  })
}

async function searchWithRetry(query, input, config, signal, acquire) {
  for (let attempt = 0; ; attempt++) {
    signal.throwIfAborted()
    let error
    const release = await acquire(signal)
    try {
      signal.throwIfAborted()
      return await oneSearch(query, input, config, signal)
    } catch (caught) {
      if (signal.aborted) throw signal.reason
      error = caught
    } finally {
      release()
    }
    if (!error.retryable || attempt >= config.maxRetries) {
      if (attempt === 0) throw error
      throw new Error(`Remote search failed after ${attempt + 1} attempts: ${error.message}`, { cause: error })
    }
    const waitMs = Math.max(config.retryDelaySeconds * 1000 * 2 ** attempt, error.retryAfterMs ?? 0)
    await delay(waitMs, undefined, { signal })
  }
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
  const maxConcurrency = integerSetting(config, "maxConcurrency", 2, 1, 8)
  const maxRetries = integerSetting(config, "maxRetries", 2, 0, 5)
  const retryDelaySeconds = integerSetting(config, "retryDelaySeconds", 5, 1, 300)
  const safeConfig = { responsesUrl, apiKey, model, timeoutMs, maxRetries, retryDelaySeconds }
  let limiter = requestLimiters.get(config)
  if (!limiter) {
    limiter = { limit: maxConcurrency, acquire: createLimiter(maxConcurrency) }
    requestLimiters.set(config, limiter)
  }
  if (limiter.limit !== maxConcurrency) throw new Error("Create a new config object when changing maxConcurrency")
  const failed = new AbortController()
  const combinedSignal = AbortSignal.any([signal, failed.signal])
  const pending = input.queries.map(async (query) => ({ query, result: await searchWithRetry(query, input, safeConfig, combinedSignal, limiter.acquire) }))
  let batches
  try {
    batches = await Promise.all(pending)
  } catch (error) {
    failed.abort(error)
    await Promise.allSettled(pending)
    throw error
  }
  const sections = batches.map(({ query, result }) => {
    const sourceLines = result.sources.slice(0, input.maxResults).map((source, index) => `${index + 1}. ${source.title}\n   ${source.url}${source.snippet ? `\n   ${source.snippet.slice(0, 500)}` : ""}`)
    return `Query: ${query}\n\nSources (${sourceLines.length}):\n${sourceLines.join("\n")}\n\nRemote summary (verify against sources):\n${result.answer || "No summary returned."}`
  })
  return sections.join("\n\n---\n\n")
}
