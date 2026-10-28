/**
 * Host half of dsh-plugin-readme-zh.
 *
 * Reads the long description document (README / locale `meta.detail`) of an
 * installed plugin bundle through `ctx.pluginManager`, splits it into
 * Markdown-safe chunks, translates every chunk into Simplified Chinese, and
 * keeps a persistent per-chunk cache under `$DSH_HOME/plugin-data`.
 *
 * Because the cache key of a chunk is the SHA-256 of its source text, a plugin
 * update whose README changes in only a few places re-translates only those
 * changed chunks; identical text is reused even when the version changed.
 */
import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

export const inject = ['pluginManager', 'webServer']

const PLUGIN_ID = 'dsh-plugin-readme-zh'
const BASE = '/api/plugin-readme-zh'
const V1_ALIAS = BASE + '/v1'
const TARGET_LANGUAGE = 'zh-CN'
const CACHE_SCHEMA = 2
/** Fixed chunk size; changing it invalidates chunk hashes, so it is not configurable. */
const CHUNK_CHARS = 3000
const MAX_DOCUMENT_CHARS = 400_000

const SYSTEM_PROMPT = [
  'You are a meticulous technical translator for developer documentation.',
  'Translate the Markdown fragment the user sends into Simplified Chinese (zh-CN).',
  'Output only the translated Markdown fragment, with no preface, explanation, or surrounding code fence.',
  'Preserve Markdown syntax exactly: headings, lists, tables, blockquotes, emphasis, inline code, links, images, HTML tags, and blank lines.',
  'Keep code, inline code, commands, URLs, file paths, package names, environment variable names, identifiers and version numbers unchanged.',
  'Translate link text, but never the URL.',
  'Do not add, remove, merge or split sections.',
].join('\n')

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

function errorText(error, max = 300) {
  const text = error instanceof Error ? error.message : String(error ?? 'unknown error')
  return text.length > max ? `${text.slice(0, max)}…` : text
}

function describeFailure(error) {
  const code = error?.code ?? error?.details?.code
  switch (code) {
    case 'plugin-manager/unknown-bundle': return '未找到这个插件包'
    case 'plugin-manager/detail-unavailable': return '这个插件的说明文件不可用，无法读取'
    case 'plugin-manager/invalid-language': return '语言参数无效'
    case 'NO_ADAPTER': return '没有可用的翻译模型（未找到模型提供方）'
    case 'MISSING_CREDENTIAL':
    case 'INVALID_CREDENTIAL': return '翻译模型的凭据缺失或无效，请检查模型配置'
    case 'RATE_LIMIT': return '翻译模型限流，请稍后再试'
    case 'QUOTA':
    case 'ACCOUNT_QUOTA': return '翻译模型额度不足'
    case 'CONTEXT_WINDOW_EXCEEDED': return '说明文档片段超出模型上下文'
    default: return errorText(error)
  }
}

function pluginDataDir() {
  const home = process.env.DSH_HOME?.trim()
  const root = home && home.length > 0 ? home : join(process.env.HOME || homedir(), '.dsh')
  return join(root, 'plugin-data', PLUGIN_ID)
}

function cacheFile(name) {
  return join(pluginDataDir(), `${name.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 160)}.json`)
}

/* ------------------------------------------------------------------ *
 * Markdown chunking
 *
 * The document is split into ordered parts. Fenced code, HTML comment blocks
 * and standalone HTML tag lines are kept verbatim ("code" parts) and never
 * sent to the model, so code samples cannot be damaged. Prose is packed into
 * chunks of at most CHUNK_CHARS characters at line boundaries; concatenating
 * the segments with a newline reproduces the source document exactly.
 * ------------------------------------------------------------------ */

function splitParts(markdown) {
  const lines = markdown.split('\n')
  const parts = []
  let buf = []
  let fence = null
  let closeFence = null
  const flush = () => {
    if (buf.length > 0) {
      parts.push({ kind: 'text', text: buf.join('\n') })
      buf = []
    }
  }
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (fence === null) {
      // A Markdown heading starts a new section: flush the accumulated text so
      // that the chunk hashes of later sections never depend on earlier ones.
      if (/^#{1,6}\s+/.test(line) && buf.length > 0) flush()
      const open = /^\s*(`{3,}|~{3,})/.exec(line)
      if (open !== null) {
        flush()
        fence = open[1][0]
        closeFence = new RegExp(`^\\s*${fence}{3,}\\s*$`)
        buf.push(line)
        continue
      }
      if (/^\s*<!--/.test(line) && !/-->\s*$/.test(line)) {
        flush()
        const block = [line]
        while (index + 1 < lines.length && !/-->\s*$/.test(block[block.length - 1])) {
          index += 1
          block.push(lines[index])
        }
        parts.push({ kind: 'code', text: block.join('\n') })
        continue
      }
      if (/^\s*<!--.*-->\s*$/.test(line) || /^\s*<\/?[a-zA-Z][^>]*>\s*$/.test(line)) {
        flush()
        parts.push({ kind: 'code', text: line })
        continue
      }
      buf.push(line)
      continue
    }
    buf.push(line)
    if (closeFence !== null && closeFence.test(line)) {
      parts.push({ kind: 'code', text: buf.join('\n') })
      buf = []
      fence = null
    }
  }
  if (fence !== null) {
    // An unterminated fence: keep the rest verbatim rather than guessing.
    if (buf.length > 0) parts.push({ kind: 'code', text: buf.join('\n') })
  } else {
    flush()
  }
  return parts
}

function splitLongLine(line, maxChars) {
  // A single line longer than maxChars is cut at word boundaries so that no
  // chunk ever exceeds the model's text limit.
  if (line.length <= maxChars) return [line]
  const pieces = []
  let cursor = 0
  while (cursor < line.length) {
    let end = Math.min(cursor + maxChars, line.length)
    if (end < line.length) {
      const space = line.lastIndexOf(' ', end)
      if (space > cursor) end = space + 1
    }
    pieces.push(line.slice(cursor, end))
    cursor = end
  }
  return pieces
}

function packText(text, maxChars) {
  const lines = text.split('\n')
  const chunks = []
  let buf = []
  let size = 0
  const flush = () => {
    if (buf.length > 0) {
      chunks.push(buf.join('\n'))
      buf = []
      size = 0
    }
  }
  for (const rawLine of lines) {
    for (const line of splitLongLine(rawLine, maxChars)) {
      const extra = buf.length === 0 ? line.length : line.length + 1
      if (buf.length > 0 && size + extra > maxChars) flush()
      if (buf.length === 0) size = line.length
      else size += extra
      buf.push(line)
    }
  }
  flush()
  return chunks
}

function buildSegments(markdown) {
  const segments = []
  for (const part of splitParts(markdown)) {
    if (part.kind === 'code') {
      segments.push({ kind: 'code', text: part.text })
      continue
    }
    for (const chunk of packText(part.text, CHUNK_CHARS)) {
      if (chunk.trim() === '') {
        segments.push({ kind: 'code', text: chunk })
        continue
      }
      segments.push({ kind: 'text', text: chunk, hash: sha256(chunk) })
    }
  }
  return segments
}

function materialize(segments, translations) {
  return segments
    .map(segment => (segment.kind === 'text' ? translations.get(segment.hash) : segment.text))
    .join('\n')
}

function cjkRatio(markdown) {
  const prose = markdown
    .replace(/```[\s\S]*?```/g, '')
    .replace(/~~~[\s\S]*?~~~/g, '')
    .replace(/`[^`]*`/g, '')
  const cjk = (prose.match(/[\u3400-\u9fff]/g) ?? []).length
  const latin = (prose.match(/[A-Za-z]/g) ?? []).length
  if (cjk === 0) return 0
  return cjk / (cjk + latin)
}

function isAlreadyChinese(detail) {
  return detail.origin === 'locale' || cjkRatio(detail.markdown) >= 0.3
}

/* ------------------------------------------------------------------ *
 * Translation engine
 * ------------------------------------------------------------------ */

async function resolveRoute(ctx, config) {
  if (typeof config.provider === 'string' && config.provider !== ''
    && typeof config.model === 'string' && config.model !== '') {
    return { provider: config.provider, model: config.model }
  }
  const defaults = ctx.get('agentDefaultModel')
  if (defaults !== undefined && typeof defaults.currentSelection === 'function') {
    const selection = defaults.currentSelection()
    if (selection !== undefined && typeof selection.provider === 'string'
      && typeof selection.model === 'string' && selection.provider !== '' && selection.model !== '') {
      return { provider: selection.provider, model: selection.model }
    }
  }
  throw new Error('没有可用的翻译模型：请设置默认模型，或在本插件配置中填写 provider 与 model')
}

async function resolveEngine(ctx, config) {
  const mode = config.engine === 'translator' || config.engine === 'llm' ? config.engine : 'auto'
  const llm = ctx.get('llm')
  const translator = ctx.get('translator')
  if (mode !== 'translator' && llm !== undefined) {
    try {
      const route = await resolveRoute(ctx, config)
      // The translator is a per-chunk fallback only when the user accepted auto mode.
      return { kind: 'llm', llm, route, translator: mode === 'auto' ? translator : undefined }
    } catch (error) {
      if (mode === 'llm') throw error
    }
  }
  if (translator !== undefined) return { kind: 'translator', translator }
  throw new Error('没有可用的翻译能力：既没有模型服务，也没有 translator 服务')
}

async function reasoningEffortFor(ctx, config, engine) {
  if (typeof config.reasoningEffort === 'string') {
    return config.reasoningEffort === '' || config.reasoningEffort === 'auto' ? undefined : config.reasoningEffort
  }
  try {
    const info = await engine.llm.resolveModelInfo(engine.route.provider, engine.route.model)
    const efforts = info?.reasoning?.efforts ?? []
    if (efforts.some(effort => effort?.id === 'off')) return 'off'
  } catch {
    // Discovery is best-effort; the adapter default still works.
  }
  return undefined
}

async function streamTranslation(ctx, config, engine, text, signal, strict, systemOverride) {
  const options = {
    provider: engine.route.provider,
    model: engine.route.model,
    system: systemOverride ?? SYSTEM_PROMPT,
    messages: [{
      role: 'user',
      content: [{
        type: 'text',
        text: `The Markdown fragment to translate:\n\n<fragment>\n${text}\n</fragment>`
          + (strict ? '\n\n你的上一条输出不是简体中文。现在请直接、只输出简体中文翻译。' : ''),
      }],
    }],
    temperature: 0,
    maxTokens: Math.max(1024, Number(config.maxTokens) || 8192),
    signal,
  }
  if (engine.reasoningEffort !== undefined) options.reasoningEffort = engine.reasoningEffort
  let output = ''
  let finished = false
  for await (const chunk of engine.llm.stream(options)) {
    if (finished) throw new Error('翻译模型在结束标记之后仍继续输出')
    if (chunk.type === 'text-delta') output += chunk.text
    else if (chunk.type === 'finish') {
      finished = true
      const reason = chunk.reason
      if (reason?.kind === 'error' || reason?.kind === 'aborted') {
        const failure = reason.failure ?? {}
        const error = new Error(failure.message ?? `模型流异常结束：${String(reason.kind)}`)
        error.code = failure.code
        throw error
      }
      if (reason?.kind !== 'stop') throw new Error(`模型流异常结束：${String(reason?.kind ?? 'unknown')}`)
    }
  }
  if (!finished) throw new Error('翻译模型没有返回结束标记')
  return output
}

async function translatorTranslation(ctx, config, engine, text, signal) {
  const service = engine.translator
  if (service === undefined) throw new Error('translator 服务不可用')
  const provider = typeof config.translatorProvider === 'string' && config.translatorProvider !== ''
    ? config.translatorProvider
    : 'bing'
  const spec = service.resolve({ text, targetLanguage: TARGET_LANGUAGE, provider })
  return await service.translate(spec, signal)
}

function cleanTranslation(raw, source) {
  let text = String(raw ?? '').trim()
  const wrapped = /^```[a-zA-Z0-9_-]*\n([\s\S]*?)\n```$/.exec(text)
  if (wrapped !== null && !/^\s*```/.test(source.trim())) text = wrapped[1].trim()
  return text
}

function restoreBlankLines(source, translated) {
  const lead = /^\n*/.exec(source)?.[0] ?? ''
  const trail = /\n*$/.exec(source)?.[0] ?? ''
  const core = translated.replace(/^\n+|\n+$/g, '')
  return `${lead}${core}${trail}`
}

function validTranslation(source, translated) {
  if (translated.trim() === '') return false
  const latin = (source.match(/[A-Za-z]/g) ?? []).length
  const cjk = (translated.match(/[\u3400-\u9fff]/g) ?? []).length
  if (latin >= 20 && cjk === 0) return false
  return true
}

function abortError() {
  const error = new Error('翻译已取消')
  error.name = 'AbortError'
  return error
}

const STRUCTURAL_LLM_ERRORS = new Set([
  'NO_ADAPTER', 'MISSING_CREDENTIAL', 'INVALID_CREDENTIAL', 'AUTH',
  'CONTEXT_WINDOW_EXCEEDED', 'QUOTA', 'ACCOUNT_QUOTA',
])

function isStructuralLlmError(error) {
  return typeof error?.code === 'string' && STRUCTURAL_LLM_ERRORS.has(error.code)
}

/** LLM translation with bounded retries; transient failures are retried, structural ones surface. */
async function llmTranslation(ctx, config, engine, source, signal, strict, systemOverride) {
  let lastError
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    if (signal?.aborted === true) throw abortError()
    try {
      return await streamTranslation(ctx, config, engine, source, signal, strict, systemOverride)
    } catch (error) {
      if (error?.name === 'AbortError' || signal?.aborted === true) throw error
      lastError = error
      if (isStructuralLlmError(error)) break
      if (attempt < 3) await sleep(1500 * attempt)
    }
  }
  throw lastError ?? new Error('翻译模型调用失败')
}

/**
 * Translate one chunk. Transient model failures retry on the model; only a
 * structural model failure uses the translator fallback, and that is decided
 * per chunk, so one bad call never turns the rest of the job off.
 * @returns { { text: string, fallback: boolean, keptSource: boolean } }
 */
async function translateChunk(ctx, config, engine, source, signal) {
  const canFallBack = engine.kind === 'llm' && engine.translator !== undefined
  for (let round = 0; round < 2; round += 1) {
    if (signal?.aborted === true) throw abortError()
    let raw
    let engineError
    try {
      raw = engine.kind === 'llm'
        ? await llmTranslation(ctx, config, engine, source, signal, round === 1)
        : await translatorTranslation(ctx, config, engine, source, signal)
    } catch (error) {
      if (error?.name === 'AbortError' || signal?.aborted === true) throw error
      engineError = error
    }
    if (raw !== undefined) {
      const translated = restoreBlankLines(source, cleanTranslation(raw, source))
      if (validTranslation(source, translated)) return { text: translated, fallback: false, keptSource: false }
      continue
    }
    if (canFallBack && isStructuralLlmError(engineError)) {
      try {
        const fallbackRaw = await translatorTranslation(ctx, config, engine, source, signal)
        const translated = restoreBlankLines(source, cleanTranslation(fallbackRaw, source))
        if (validTranslation(source, translated)) return { text: translated, fallback: true, keptSource: false }
      } catch (fallbackError) {
        if (fallbackError?.name === 'AbortError' || signal?.aborted === true) throw fallbackError
        throw new Error(`翻译模型不可用（${describeFailure(engineError)}），备用翻译服务也失败：${describeFailure(fallbackError)}`)
      }
      continue
    }
    throw engineError ?? new Error('翻译失败')
  }
  // Two rounds without a Chinese result: a code-heavy chunk may be kept as-is.
  const latin = source.match(/[A-Za-z]/g) ?? []
  if (latin.length < 20) return { text: source, fallback: false, keptSource: true }
  throw new Error('翻译结果不是中文：模型没有输出中文翻译')
}

/* ------------------------------------------------------------------ *
 * Persistent cache
 * ------------------------------------------------------------------ */

function createCache(name, detail, docHash, maxChars) {
  return {
    schema: CACHE_SCHEMA,
    bundle: name,
    version: typeof detail.version === 'string' ? detail.version : undefined,
    doc: { sha256: docHash, origin: detail.origin, path: detail.path, chars: detail.markdown.length },
    targetLanguage: TARGET_LANGUAGE,
    chunkChars: maxChars,
    complete: false,
    chunks: {},
    updatedAt: new Date().toISOString(),
  }
}

function cacheCompatible(cache) {
  return cache !== null && typeof cache === 'object'
    && cache.schema === CACHE_SCHEMA
    && cache.chunkChars === CHUNK_CHARS
    && cache.chunks !== null && typeof cache.chunks === 'object'
}

function cacheUsable(cache, docHash) {
  return cacheCompatible(cache) && cache.doc?.sha256 === docHash
}

/** How many of the document's text chunks are cached, and how many it has in total. */
function reusableChunks(cache, markdown) {
  if (!cacheCompatible(cache)) return { reusable: 0, total: 0 }
  const hashes = new Set()
  for (const segment of buildSegments(markdown)) {
    if (segment.kind === 'text') hashes.add(segment.hash)
  }
  let count = 0
  for (const hash of hashes) {
    if (typeof cache.chunks[hash]?.t === 'string' && cache.chunks[hash].t.trim() !== '') count += 1
  }
  return { reusable: count, total: hashes.size }
}

async function readCacheFile(name) {
  try {
    const parsed = JSON.parse(await readFile(cacheFile(name), 'utf8'))
    return parsed !== null && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

async function writeCacheFile(name, cache) {
  await mkdir(pluginDataDir(), { recursive: true })
  const destination = cacheFile(name)
  const temporary = `${destination}.${process.pid}.${Date.now()}.tmp`
  await writeFile(temporary, JSON.stringify(cache), 'utf8')
  await rename(temporary, destination)
}

async function loadCache(state, name) {
  if (state.caches.has(name)) return state.caches.get(name)
  const cache = await readCacheFile(name)
  state.caches.set(name, cache)
  return cache
}

function pruneCache(cache, segments) {
  const hashes = new Set(segments.filter(segment => segment.kind === 'text').map(segment => segment.hash))
  const kept = {}
  for (const hash of hashes) {
    const entry = cache.chunks[hash]
    if (entry !== undefined && typeof entry?.t === 'string') kept[hash] = entry
  }
  return kept
}

/* ------------------------------------------------------------------ *
 * Bundle helpers
 * ------------------------------------------------------------------ */

async function installedBundles(ctx, state) {
  if (state.bundleCache !== null && Date.now() - state.bundleCache.at < 3000) return state.bundleCache.list
  const list = await ctx.pluginManager.listBundles()
  state.bundleCache = { at: Date.now(), list }
  return list
}

async function findBundle(ctx, state, name) {
  const list = await installedBundles(ctx, state)
  return list.find(bundle => bundle.name === name)
}

async function readDetail(ctx, name) {
  const detail = await ctx.pluginManager.readBundleDetail(name, TARGET_LANGUAGE)
  if (detail === null || detail === undefined || detail.status !== 'found') return null
  if (typeof detail.markdown !== 'string' || detail.markdown.trim() === '') return null
  return detail
}

async function inspect(ctx, state, name) {
  const bundle = await findBundle(ctx, state, name)
  if (bundle === undefined) return { state: 'unknown-bundle' }
  if (bundle.availability === 'missing') {
    return { state: 'unavailable', bundle: name, version: bundle.version }
  }
  let detail
  try {
    detail = await readDetail(ctx, name)
  } catch (error) {
    return { state: 'error', bundle: name, version: bundle.version, error: describeFailure(error) }
  }
  if (detail === null) return { state: 'no-document', bundle: name, version: bundle.version }
  const base = {
    bundle: name,
    version: typeof bundle.version === 'string' ? bundle.version : undefined,
    origin: detail.origin,
    path: detail.path,
    chars: detail.markdown.length,
    docHash: sha256(detail.markdown),
  }
  if (isAlreadyChinese(detail)) return { ...base, state: 'source-chinese' }
  if (detail.markdown.length > MAX_DOCUMENT_CHARS) {
    return { ...base, state: 'error', error: '说明文档过大，已跳过（超过 40 万字符）' }
  }
  const running = state.jobs.get(name)
  if (running !== undefined && running.state === 'running') {
    return { ...base, ...jobView(running, false), state: 'running' }
  }
  const cache = await loadCache(state, name)
  if (cacheUsable(cache, base.docHash) && cache.complete === true) {
    return {
      ...base,
      state: 'done',
      cached: true,
      total: Number(cache.segmentCount) || 0,
      reused: Number(cache.segmentCount) || 0,
      translated: 0,
      translatedAt: cache.updatedAt,
      engine: cache.engine,
    }
  }
  if (cacheCompatible(cache)) {
    const reuse = reusableChunks(cache, detail.markdown)
    return { ...base, state: 'idle', reusable: reuse.reusable, total: reuse.total }
  }
  return { ...base, state: 'idle' }
}

/* ------------------------------------------------------------------ *
 * Jobs
 * ------------------------------------------------------------------ */

function jobView(job, includeMarkdown) {
  return {
    state: job.state,
    bundle: job.name,
    version: job.version,
    origin: job.origin,
    path: job.path,
    docHash: job.docHash,
    chars: job.chars,
    total: job.total,
    done: job.done,
    reused: job.reused,
    translated: job.translated,
    engine: job.engine,
    fallback: job.fallback === true,
    startedAt: job.startedAt,
    updatedAt: job.updatedAt,
    error: job.error,
    ...includeMarkdown && job.state === 'done' && typeof job.markdown === 'string'
      ? { markdown: job.markdown, stats: job.stats }
      : {},
  }
}

function touch(job) {
  job.updatedAt = new Date().toISOString()
}

function startJob(ctx, state, config, name, options = {}) {
  const force = options.force === true
  const expectedDocHash = typeof options.docHash === 'string' ? options.docHash : undefined
  const existing = state.jobs.get(name)
  if (existing !== undefined) {
    if (existing.state === 'running') return existing
    if (existing.state === 'done' && !force
      && (expectedDocHash === undefined || existing.docHash === expectedDocHash)) return existing
  }
  const job = {
    name,
    state: 'queued',
    total: 0,
    done: 0,
    reused: 0,
    translated: 0,
    engine: undefined,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
  state.jobs.set(name, job)
  job.promise = runJob(ctx, state, config, job, force)
    .catch(error => {
      job.state = 'error'
      job.error = describeFailure(error)
      touch(job)
      ctx.logger?.warn?.(`plugin-readme-zh: translating ${name} failed`)
      ctx.logger?.warn?.(error)
    })
    .then(() => {
      evictJobs(state)
    })
  return job
}

function evictJobs(state) {
  const done = [...state.jobs.values()].filter(job => job.state === 'done' || job.state === 'error')
  if (done.length <= 8) return
  done.sort((left, right) => String(left.updatedAt).localeCompare(String(right.updatedAt)))
  for (const job of done.slice(0, done.length - 8)) state.jobs.delete(job.name)
}

async function runJob(ctx, state, config, job, force) {
  const name = job.name
  job.state = 'running'
  touch(job)
  const detail = await readDetail(ctx, name)
  if (detail === null) throw new Error('这个插件没有可读取的说明文档')
  if (isAlreadyChinese(detail)) {
    job.state = 'done'
    job.engine = 'none'
    job.stats = { total: 0, reused: 0, translated: 0, note: '原文已是中文' }
    touch(job)
    return
  }
  if (detail.markdown.length > MAX_DOCUMENT_CHARS) throw new Error('说明文档过大，已跳过（超过 40 万字符）')
  const docHash = sha256(detail.markdown)
  job.docHash = docHash
  job.origin = detail.origin
  job.path = detail.path
  job.chars = detail.markdown.length
  try {
    const bundle = await findBundle(ctx, state, name)
    if (bundle !== undefined && typeof bundle.version === 'string') job.version = bundle.version
  } catch {
    // Version text is cosmetic; the document hash decides cache reuse.
  }
  const segments = buildSegments(detail.markdown)
  const textSegments = []
  const seen = new Set()
  for (const segment of segments) {
    if (segment.kind !== 'text' || seen.has(segment.hash)) continue
    seen.add(segment.hash)
    textSegments.push(segment)
  }
  job.total = textSegments.length
  touch(job)

  // Keep the previous document's chunks: a changed document usually reuses most of
  // them, and only the segments whose text changed are translated again.
  let cache = force === true ? null : await loadCache(state, name)
  if (!cacheCompatible(cache)) cache = createCache(name, detail, docHash, CHUNK_CHARS)
  cache.bundle = name
  cache.version = job.version
  cache.doc = { sha256: docHash, origin: detail.origin, path: detail.path, chars: detail.markdown.length }
  cache.complete = false

  const translations = new Map()
  for (const segment of textSegments) {
    const cached = cache.chunks[segment.hash]
    if (typeof cached?.t === 'string' && cached.t.trim() !== '') {
      translations.set(segment.hash, cached.t)
      job.done += 1
      job.reused += 1
    }
  }
  touch(job)

  const engine = await resolveEngine(ctx, config)
  if (engine.kind === 'llm') engine.reasoningEffort = await reasoningEffortFor(ctx, config, engine)
  job.engine = engine.kind
  let usedFallback = false
  let keptSourceCount = 0
  for (const segment of textSegments) {
    if (translations.has(segment.hash)) continue
    if (state.lifetime.signal.aborted) throw abortError()
    const result = await translateChunk(ctx, config, engine, segment.text, state.lifetime.signal)
    translations.set(segment.hash, result.text)
    if (result.fallback === true) usedFallback = true
    if (result.keptSource === true) keptSourceCount += 1
    job.done += 1
    job.translated += 1
    cache.chunks[segment.hash] = { t: result.text, at: new Date().toISOString() }
    cache.complete = false
    cache.updatedAt = new Date().toISOString()
    cache.segmentCount = textSegments.length
    cache.engine = engine.kind
    state.caches.set(name, cache)
    await writeCacheFile(name, cache).catch(() => {})
    touch(job)
  }

  const markdown = materialize(segments, translations)
  cache.chunks = pruneCache(cache, segments)
  cache.complete = true
  cache.segmentCount = textSegments.length
  cache.engine = engine.kind
  cache.updatedAt = new Date().toISOString()
  cache.doc = { sha256: docHash, origin: detail.origin, path: detail.path, chars: detail.markdown.length }
  state.caches.set(name, cache)
  await writeCacheFile(name, cache)
  job.markdown = markdown
  job.fallback = usedFallback
  job.keptSource = keptSourceCount
  job.engine = usedFallback ? `${engine.kind}+fallback` : engine.kind
  job.stats = {
    total: textSegments.length,
    reused: job.reused,
    translated: job.translated,
    keptSource: keptSourceCount,
    chunkChars: CHUNK_CHARS,
  }
  job.state = 'done'
  touch(job)
  ctx.logger?.info?.(`plugin-readme-zh: ${name} translated (${job.translated} new / ${job.reused} reused)`)
}

function materializeFromCache(detail, cache) {
  const segments = buildSegments(detail.markdown)
  const translations = new Map()
  for (const segment of segments) {
    if (segment.kind !== 'text') continue
    const entry = cache.chunks?.[segment.hash]
    if (typeof entry?.t !== 'string' || entry.t.trim() === '') return null
    translations.set(segment.hash, entry.t)
  }
  return { markdown: materialize(segments, translations), segments }
}

/* ------------------------------------------------------------------ *
 * Prefetch
 * ------------------------------------------------------------------ */

function startPrefetch(ctx, state, config) {
  if (state.prefetch.state === 'running') return state.prefetch
  state.prefetch = {
    state: 'running',
    total: 0,
    done: 0,
    current: null,
    failed: [],
    startedAt: new Date().toISOString(),
    finishedAt: null,
  }
  const prefetch = state.prefetch
  void (async () => {
    try {
      const bundles = (await installedBundles(ctx, state))
        .filter(bundle => bundle.availability !== 'missing')
      prefetch.total = bundles.length
      for (const bundle of bundles) {
        if (state.lifetime.signal.aborted) break
        prefetch.current = bundle.name
        try {
          const info = await inspect(ctx, state, bundle.name)
          if (info.state === 'unknown-bundle' || info.state === 'unavailable' || info.state === 'no-document'
            || info.state === 'source-chinese' || info.state === 'error') {
            if (info.state === 'error') prefetch.failed.push({ bundle: bundle.name, error: info.error })
          } else if (info.state === 'running') {
            const running = state.jobs.get(bundle.name)
            if (running?.promise !== undefined) await running.promise
          } else if (info.state === 'idle') {
            const job = startJob(ctx, state, config, bundle.name, { docHash: info.docHash })
            await job.promise
            if (job.state === 'error') prefetch.failed.push({ bundle: bundle.name, error: job.error })
          }
        } catch (error) {
          prefetch.failed.push({ bundle: bundle.name, error: describeFailure(error) })
        }
        prefetch.done += 1
      }
    } catch (error) {
      prefetch.failed.push({ bundle: '*', error: describeFailure(error) })
    } finally {
      try {
        await ensureMetaSidecars(ctx, config, state, false)
      } catch (metaError) {
        prefetch.failed.push({ bundle: '*meta*', error: describeFailure(metaError) })
      }
      prefetch.state = 'done'
      prefetch.current = null
      prefetch.finishedAt = new Date().toISOString()
    }
  })()
  return prefetch
}

/* ------------------------------------------------------------------ *
 * One-line meta sidecars
 *
 * The Plugins list row shows each bundle's `meta.title` / `meta.description`
 * resolved for the active UI locale; bundles that ship no `locale/zh.json`
 * fall back to their English text. Translating those short strings and
 * writing them into the bundle's own locale files (a `locale/zh.json`
 * sidecar, mirrored by `locale/en.json` when the bundle ships no locale
 * directory at all) makes the list render Chinese natively — no client-side
 * DOM patching, and the loader's normal locale resolution displays it.
 * Translations are cached by source-string hash in `strings.json`, so a
 * plugin update re-translates only the lines that actually changed.
 * ------------------------------------------------------------------ */

const META_LANG = 'zh'

const SYSTEM_PROMPT_STRINGS = [
  'You are a meticulous technical translator for developer documentation.',
  'The user sends a JSON array of short strings: plugin display titles or one-line descriptions.',
  'Translate every string into Simplified Chinese (zh-CN).',
  'Output ONLY one JSON array with the same length and order, with no code fence, no explanation and no comments.',
  'Keep package names, model ids, file paths, commands, environment variables, identifiers and version numbers unchanged.',
].join('\n')

function stringsCacheFile() {
  return join(pluginDataDir(), 'strings.json')
}

async function loadStringsCache(state) {
  if (state.stringsCache !== undefined) return state.stringsCache
  try {
    const parsed = JSON.parse(await readFile(stringsCacheFile(), 'utf8'))
    state.stringsCache = parsed !== null && typeof parsed === 'object' && parsed.schema === 1 ? parsed : null
  } catch {
    state.stringsCache = null
  }
  if (state.stringsCache === null) {
    state.stringsCache = { schema: 1, entries: {}, updatedAt: new Date().toISOString() }
  }
  return state.stringsCache
}

async function saveStringsCache(state) {
  const cache = state.stringsCache
  if (cache === null) return
  cache.updatedAt = new Date().toISOString()
  await mkdir(pluginDataDir(), { recursive: true })
  const destination = stringsCacheFile()
  const temporary = `${destination}.${process.pid}.${Date.now()}.tmp`
  await writeFile(temporary, JSON.stringify(cache), 'utf8')
  await rename(temporary, destination)
}

/** The bundle's own resolved display text for one meta field, or the manifest fallback. */
function metaTextOf(bundle, field, fallback) {
  const value = bundle.meta?.[field]
  if (typeof value === 'string') return value
  if (value !== null && typeof value === 'object' && typeof value.en === 'string') return value.en
  return fallback
}

/** Whether the bundle already carries a non-empty zh translation of this field. */
function hasMetaZh(bundle, field) {
  const value = bundle.meta?.[field]
  return value !== null && typeof value === 'object' && typeof value.zh === 'string' && value.zh.trim() !== ''
}

function profileDir() {
  const fromEnv = process.env.DSH_PROFILE_DIR?.trim()
  return fromEnv !== undefined && fromEnv !== '' ? fromEnv : join(process.env.HOME || homedir(), '.dsh', 'profiles', 'web')
}

/** The real package directory a bundle's files resolve to; undefined when absent. */
function bundleDirOf(name) {
  try {
    return realpathSync(join(profileDir(), 'node_modules', name))
  } catch {
    return undefined
  }
}

async function atomicWriteJson(dir, file, object) {
  await mkdir(dir, { recursive: true })
  const destination = join(dir, file)
  const temporary = `${destination}.${process.pid}.${Date.now()}.tmp`
  await writeFile(temporary, JSON.stringify(object, null, 2), 'utf8')
  await rename(temporary, destination)
}

/**
 * Make the bundle's locale files resolvable through the Node module resolver.
 * `readPluginMeta` reads `${specifier}/locale/*.json` as package subpath
 * resources; a package that declares an `exports` map without a locale
 * subpath hides its locale files (ERR_PACKAGE_PATH_NOT_EXPORTED). Adding the
 * standard `"./locale/*.json"` entry (as DSH's own templates declare it)
 * exposes them without touching any other subpath.
 * @returns one of `absent` (no manifest), `none` (no exports map: raw
 * filesystem resolution already works), `present`, or `patched`.
 */
async function ensureLocaleExport(dir) {
  let manifest
  try {
    manifest = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'))
  } catch {
    return 'absent'
  }
  if (manifest === null || typeof manifest !== 'object') return 'absent'
  if (manifest.exports === undefined || manifest.exports === null) return 'none'
  if (Array.isArray(manifest.exports) || typeof manifest.exports !== 'object') return 'none'
  if (manifest.exports['./locale/*.json'] !== undefined) return 'present'
  manifest.exports['./locale/*.json'] = './locale/*.json'
  await atomicWriteJson(dir, 'package.json', manifest)
  return 'patched'
}

/**
 * Translate a batch of short strings in one model call; fall back to the
 * per-chunk translator when the batch comes back malformed.
 * @returns a Map of source string to its Chinese translation
 */
async function translateStrings(ctx, config, engine, texts, signal) {
  const out = new Map()
  const prompt = JSON.stringify(texts)
  let raw
  try {
    raw = await llmTranslation(ctx, config, engine, prompt, signal, false, SYSTEM_PROMPT_STRINGS)
  } catch (error) {
    // The whole batch failed (model unavailable); per-string calls fail the same way.
    for (const text of texts) {
      const result = await translateChunk(ctx, config, engine, text, signal)
      out.set(text, result.text)
    }
    return out
  }
  let parsed
  try {
    parsed = JSON.parse(cleanTranslation(raw, prompt))
  } catch {
    parsed = null
  }
  if (Array.isArray(parsed) && parsed.length === texts.length
    && parsed.every(item => typeof item === 'string' && item.trim() !== '')) {
    for (let index = 0; index < texts.length; index += 1) out.set(texts[index], parsed[index])
    return out
  }
  // Malformed batch output: retry each string through the chunk path.
  for (const text of texts) {
    const result = await translateChunk(ctx, config, engine, text, signal)
    out.set(text, result.text)
  }
  return out
}

function metaJobView(job) {
  return {
    state: job.state,
    disabled: job.state === 'disabled',
    total: job.total,
    written: job.written,
    skipped: job.skipped,
    translated: job.translated,
    reused: job.reused,
    startedAt: job.startedAt,
    updatedAt: job.updatedAt,
    failed: job.failed,
    error: job.error,
  }
}

/**
 * Translate the missing zh one-line meta of every profile-installed bundle and
 * write the results into the bundle's own locale files. Idempotent and
 * incremental: unchanged source strings reuse `strings.json`.
 */
async function ensureMetaSidecars(ctx, config, state, force) {
  const job = state.metaJob
  // Opt-in feature: writes locale sidecars (and one exports entry) into the
  // installed packages' own directories, so a public install keeps its hands
  // off other people's packages unless the user switches it on.
  if (config?.metaSidecars !== true) {
    if (job.state !== 'disabled') {
      job.state = 'disabled'
      job.error = 'metaSidecars 未开启（默认关闭；在插件行配置中设 metaSidecars: true 后重启生效）'
      job.updatedAt = new Date().toISOString()
    }
    return job
  }
  if (job.state === 'running') return job
  if (job.state === 'done' && !force) return job
  job.state = 'running'
  job.startedAt = new Date().toISOString()
  job.updatedAt = job.startedAt
  job.total = 0
  job.written = 0
  job.skipped = 0
  job.translated = 0
  job.reused = 0
  job.failed = []
  job.error = undefined
  void (async () => {
    try {
      const engine = await resolveEngine(ctx, config)
      const stringsCache = await loadStringsCache(state)
      const bundles = await installedBundles(ctx, state)
      const targets = []
      for (const bundle of bundles) {
        if (bundle.availability !== 'profile') continue
        if (bundle.meta?.error !== undefined) {
          job.skipped += 1
          continue
        }
        const items = []
        // Translate a friendly English title; a bare package name stays as-is.
        const titleSource = metaTextOf(bundle, 'title', undefined)
        if (typeof titleSource === 'string' && titleSource !== bundle.name && !hasMetaZh(bundle, 'title')
          && cjkRatio(titleSource) < 0.3) {
          items.push({ field: 'title', source: titleSource })
        }
        const descSource = metaTextOf(bundle, 'description', typeof bundle.description === 'string' ? bundle.description : '')
        if (typeof descSource === 'string' && descSource.trim() !== '' && !hasMetaZh(bundle, 'description')
          && cjkRatio(descSource) < 0.3) {
          items.push({ field: 'description', source: descSource })
        }
        if (items.length === 0) {
          job.skipped += 1
          continue
        }
        targets.push({ bundle, items })
      }
      job.total = targets.length
      // Batch-translate every missing source string, consulting the cache first.
      const missing = []
      const seen = new Set()
      for (const target of targets) {
        for (const item of target.items) {
          const hash = sha256(item.source)
          const cached = stringsCache.entries[hash]
          if (typeof cached?.t === 'string' && cached.t.trim() !== '') {
            item.translation = cached.t
            item.reused = true
            job.reused += 1
          } else {
            if (!seen.has(hash)) {
              seen.add(hash)
              missing.push(item.source)
            }
          }
        }
      }
      if (missing.length > 0) {
        const translated = await translateStrings(ctx, config, engine, missing, state.lifetime.signal)
        for (const source of missing) {
          const hash = sha256(source)
          const text = translated.get(source)
          if (text === undefined) throw new Error(`未获得“${source.slice(0, 60)}”的翻译`)
          stringsCache.entries[hash] = { t: text, at: new Date().toISOString() }
          job.translated += 1
        }
        await saveStringsCache(state)
        for (const target of targets) {
          for (const item of target.items) {
            if (item.reused === true) continue
            item.translation = translated.get(item.source)
          }
        }
      }
      for (const target of targets) {
        const dir = bundleDirOf(target.bundle.name)
        if (dir === undefined) {
          job.failed.push({ bundle: target.bundle.name, error: '无法定位包目录' })
          continue
        }
        const localeDir = join(dir, 'locale')
        let zh = {}
        try {
          const parsed = JSON.parse(await readFile(join(localeDir, 'zh.json'), 'utf8'))
          zh = parsed !== null && typeof parsed === 'object' ? parsed : {}
        } catch {
          zh = {}
        }
        zh.meta = { ...(zh.meta ?? {}) }
        let enMirror = null
        try {
          await readFile(join(localeDir, 'en.json'), 'utf8')
        } catch {
          // Without en.json the loader reads no locale dictionaries at all, so a
          // bundle with no locale directory gains a mirrored English file too.
          const en = {}
          en.meta = {}
          for (const item of target.items) en.meta[item.field] = item.source
          enMirror = en
        }
        for (const item of target.items) {
          if (item.translation !== undefined) zh.meta[item.field] = item.translation
        }
        await atomicWriteJson(localeDir, 'zh.json', zh)
        if (enMirror !== null) await atomicWriteJson(localeDir, 'en.json', enMirror)
        const exportState = await ensureLocaleExport(dir)
        if (exportState === 'patched') {
          ctx.logger?.info?.(`plugin-readme-zh: exposed locale/ in exports of ${target.bundle.name}`)
        }
        job.written += 1
        ctx.logger?.info?.(`plugin-readme-zh: wrote meta sidecar for ${target.bundle.name}`)
      }
      job.state = 'done'
    } catch (error) {
      if (error?.name === 'AbortError') {
        job.state = 'idle'
      } else {
        job.state = 'error'
        job.error = describeFailure(error)
        ctx.logger?.warn?.('plugin-readme-zh: meta sidecar run failed')
        ctx.logger?.warn?.(error)
      }
    }
    job.updatedAt = new Date().toISOString()
  })()
  return job
}

/* ------------------------------------------------------------------ *
 * HTTP
 * ------------------------------------------------------------------ */

function sendJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

function sameOrigin(request) {
  const origin = request.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === request.headers.host
  } catch {
    return false
  }
}

function bundleNameFrom(url) {
  const name = (url.searchParams.get('name') ?? '').trim()
  if (name === '' || name.length > 214 || /[\u0000-\u001f]/.test(name)) return null
  return name
}

async function handleRequest(ctx, state, config, request, response, basePath) {
  const url = new URL(request.url ?? '/', 'http://localhost')
  const action = url.pathname.slice(basePath.length).replace(/^\/+/, '').replace(/\/+$/, '')
  const method = request.method ?? 'GET'
  if (method === 'POST') request.resume()

  if (action === '' || action === 'status') {
    if (method !== 'GET') return sendJson(response, 405, { error: '仅支持 GET' })
    if (action === '') {
      return sendJson(response, 200, {
        ok: true,
        bundle: ctx.pluginManager !== undefined,
        endpoints: ['status', 'start', 'job', 'prefetch'],
      })
    }
    const name = bundleNameFrom(url)
    if (name === null) return sendJson(response, 400, { error: '缺少有效的插件包名' })
    return sendJson(response, 200, await inspect(ctx, state, name))
  }

  if (action === 'start') {
    if (method !== 'POST') return sendJson(response, 405, { error: '仅支持 POST' })
    if (!sameOrigin(request)) return sendJson(response, 403, { error: '跨站请求被拒绝' })
    const name = bundleNameFrom(url)
    if (name === null) return sendJson(response, 400, { error: '缺少有效的插件包名' })
    const info = await inspect(ctx, state, name)
    if (info.state === 'unknown-bundle' || info.state === 'unavailable' || info.state === 'no-document'
      || info.state === 'source-chinese' || info.state === 'error') {
      return sendJson(response, 200, info)
    }
    const force = url.searchParams.get('force') === '1'
    const job = startJob(ctx, state, config, name, { force, docHash: info.docHash })
    return sendJson(response, 200, jobView(job, false))
  }

  if (action === 'job') {
    if (method !== 'GET') return sendJson(response, 405, { error: '仅支持 GET' })
    const name = bundleNameFrom(url)
    if (name === null) return sendJson(response, 400, { error: '缺少有效的插件包名' })
    const job = state.jobs.get(name)
    if (job !== undefined) {
      const view = jobView(job, true)
      if (job.state === 'done' || job.state === 'error') {
        // Live cache view for the document as it is right now, so a dialog
        // re-opened after an unchanged document shows "fully cached" instead
        // of the historical numbers of the last translation run.
        try {
          const live = await inspect(ctx, state, name)
          view.cache = {
            state: live.state,
            total: live.total ?? null,
            reusable: typeof live.reusable === 'number' ? live.reusable : null,
          }
        } catch {
          // Cache inspection is best-effort; the run stats remain visible.
        }
      }
      return sendJson(response, 200, view)
    }
    const info = await inspect(ctx, state, name)
    if (info.state !== 'done') return sendJson(response, 200, info)
    const bundle = await findBundle(ctx, state, name)
    if (bundle === undefined) return sendJson(response, 404, { error: '未找到这个插件包' })
    const detail = await readDetail(ctx, name)
    const cache = await loadCache(state, name)
    if (detail === null || cache === null) return sendJson(response, 200, { state: 'idle', bundle: name })
    const built = materializeFromCache(detail, cache)
    if (built === null) return sendJson(response, 200, { state: 'idle', bundle: name })
    return sendJson(response, 200, {
      ...info,
      state: 'done',
      markdown: built.markdown,
      stats: {
        total: Number(cache.segmentCount) || 0,
        reused: Number(cache.segmentCount) || 0,
        translated: 0,
      },
    })
  }

  if (action === 'prefetch') {
    if (method === 'GET') return sendJson(response, 200, state.prefetch)
    if (method !== 'POST') return sendJson(response, 405, { error: '仅支持 GET 或 POST' })
    if (!sameOrigin(request)) return sendJson(response, 403, { error: '跨站请求被拒绝' })
    return sendJson(response, 200, startPrefetch(ctx, state, config))
  }

  if (action === 'meta') {
    if (method === 'GET') return sendJson(response, 200, metaJobView(state.metaJob))
    if (method !== 'POST') return sendJson(response, 405, { error: '仅支持 GET 或 POST' })
    if (!sameOrigin(request)) return sendJson(response, 403, { error: '跨站请求被拒绝' })
    return sendJson(response, 200, metaJobView(await ensureMetaSidecars(ctx, config, state, true)))
  }

  return sendJson(response, 404, { error: '未知接口' })
}

export function apply(ctx, config = {}) {
  const state = {
    jobs: new Map(),
    caches: new Map(),
    bundleCache: null,
    prefetch: { state: 'idle', total: 0, done: 0, current: null, failed: [], startedAt: null, finishedAt: null },
    metaJob: { state: 'idle', startedAt: null, updatedAt: null, total: 0, written: 0, skipped: 0, translated: 0, reused: 0, failed: [], error: undefined },
    stringsCache: undefined,
    lifetime: new AbortController(),
  }
  // Own the route and the translation lifetime by the plugin fiber, so a
  // disable/reload removes the route instead of leaving a stale registration.
  // Both the stable path and the /v1 alias answer the same handler, so a client
  // module built against either keeps working after a reload.
  const makeHandler = (basePath) => (request, response) => {
    void handleRequest(ctx, state, config, request, response, basePath).catch(error => {
      ctx.logger?.warn?.('plugin-readme-zh: request failed')
      ctx.logger?.warn?.(error)
      if (response.headersSent) {
        response.end()
        return
      }
      sendJson(response, 500, { error: describeFailure(error) })
    })
  }
  ctx.effect(() => {
    const disposeStable = ctx.webServer.register({ kind: 'prefix', path: BASE, handler: makeHandler(BASE) })
    const disposeV1 = ctx.webServer.register({ kind: 'prefix', path: V1_ALIAS, handler: makeHandler(V1_ALIAS) })
    // Translate the list-row one-liners into the bundles' own locale files
    // (opt-in via `metaSidecars: true`); every string is cached, so this stays cheap.
    void ensureMetaSidecars(ctx, config, state, false).catch(error => {
      ctx.logger?.warn?.('plugin-readme-zh: meta sidecar run failed')
      ctx.logger?.warn?.(error)
    })
    return () => {
      state.lifetime.abort()
      state.jobs.clear()
      state.caches.clear()
      disposeStable()
      disposeV1()
    }
  }, 'plugin-readme-zh: routes and lifetime')
}
