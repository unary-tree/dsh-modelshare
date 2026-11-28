/**
 * Persisted sharing settings.
 *
 * The page and the HTTP endpoint are two faces of one small document: which
 * API keys may call the endpoint, which models those keys are allowed to see,
 * and the endpoint's own base URL. It lives in the user's DSH home rather than
 * in the profile YAML because the page edits it at runtime.
 *
 * Writes are atomic (write-temp-then-rename) and every read returns a detached
 * deep copy, so a caller can never mutate the shared state by accident.
 */
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** Prefix on generated keys, so a leaked one is recognizable. */
const KEY_PREFIX = 'ms-'

/**
 * A fresh sharing key: 32 bytes of CSPRNG entropy, base64url, prefix-tagged.
 * @returns the key, e.g. `ms-Ab3d...`.
 */
export function generateKey() {
  return KEY_PREFIX + randomBytes(32).toString('base64url')
}

/** Detach a value through JSON, which is how it round-trips to disk anyway. */
const detach = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)))

/** The document an empty install starts from. */
function blankDocument() {
  return {
    /** Schema marker, so a future change can migrate rather than guess. */
    version: 1,
    /** Sharing keys. Each carries its own model allow-list. */
    keys: [],
    /** Models every key may use, unioned with each key's own list. */
    sharedModels: [],
    /**
     * Whether keys are unrestricted (every model allowed).
     *
     * This exists because an empty sharedModels list cannot mean both "no
     * restriction" and "nothing allowed": the page's Clear button made the
     * second unexpressible, and every box re-ticked itself. The flag states
     * the intent; the list is then free to be empty.
     */
    unrestricted: true,
    /** Explicit base URL; empty means derive it from the request host. */
    baseUrl: '',
    /** Master switch, so the page can pause sharing without editing YAML. */
    enabled: true,
  }
}

/**
 * Normalize one model id: provider/model for a multi-provider install, a bare
 * model id when the install has only one provider.
 * @param value - raw string from the page or the wire.
 * @returns the trimmed id, or '' when unusable.
 */
export function normalizeModelId(value) {
  return typeof value === 'string' ? value.trim() : ''
}

/** Deduplicate a model list while preserving order. */
export function uniqueModels(list) {
  const seen = new Set()
  const out = []
  for (const item of Array.isArray(list) ? list : []) {
    const id = normalizeModelId(item)
    if (id.length === 0 || seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  return out
}

/**
 * Coerce any parsed JSON into the current document shape. Tolerant on purpose:
 * a hand-edited or older file must not brick the endpoint.
 * @param raw - parsed JSON from disk.
 * @returns a well-formed document.
 */
export function coerceDocument(raw) {
  const doc = blankDocument()
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return doc
  if (Number.isInteger(raw.version) && raw.version > 0) doc.version = raw.version
  doc.enabled = raw.enabled !== false
  doc.baseUrl = typeof raw.baseUrl === 'string' ? raw.baseUrl.trim() : ''
  doc.sharedModels = uniqueModels(raw.sharedModels)
  // Files written before the flag existed meant "empty list ⇒ unrestricted",
  // so that derivation keeps them working unchanged.
  doc.unrestricted = typeof raw.unrestricted === 'boolean' ? raw.unrestricted : doc.sharedModels.length === 0
  const keys = Array.isArray(raw.keys) ? raw.keys : []
  for (const entry of keys) {
    if (entry === null || typeof entry !== 'object') continue
    const value = typeof entry.key === 'string' ? entry.key.trim() : ''
    if (value.length === 0) continue
    doc.keys.push({
      key: value,
      label: typeof entry.label === 'string' ? entry.label : '',
      models: uniqueModels(entry.models),
      createdAt: typeof entry.createdAt === 'string' ? entry.createdAt : new Date(0).toISOString(),
    })
  }
  return doc
}

/**
 * The sharing settings document, backed by one JSON file.
 *
 * One instance per plugin activation; the HTTP handler and the page route both
 * read through it, so a checkbox flipped in the UI applies to the very next
 * model request without a reload.
 */
export class ShareStore {
  /**
   * @param options.file - absolute path of the JSON document.
   * @param options.log - diagnostic sink.
   */
  constructor({ file, log = () => {} }) {
    this.file = file
    this.log = log
    this.document = this.read()
  }

  /** Load from disk, falling back to a blank document on any problem. */
  read() {
    try {
      if (!existsSync(this.file)) return blankDocument()
      const parsed = JSON.parse(readFileSync(this.file, 'utf8'))
      return coerceDocument(parsed)
    } catch (error) {
      this.log('settings unreadable, starting blank: ' + (error?.message ?? error))
      return blankDocument()
    }
  }

  /** Write the document atomically: a crash mid-write must not truncate it. */
  write() {
    const text = JSON.stringify(this.document, null, 2) + '\n'
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      const temp = this.file + '.tmp'
      writeFileSync(temp, text, 'utf8')
      renameSync(temp, this.file)
    } catch (error) {
      this.log('settings write failed: ' + (error?.message ?? error))
      throw error
    }
  }

  /** The current document as a detached copy. */
  snapshot() {
    return detach(this.document)
  }

  /** Replace the document from the page, then persist. */
  replace(raw) {
    this.document = coerceDocument(raw)
    this.write()
    return this.snapshot()
  }

  /** Whether sharing is currently on. */
  get enabled() {
    return this.document.enabled
  }

  /**
   * Add a key.
   * @param options.label - optional human label for the page.
   * @param options.models - optional initial allow-list; empty means share all.
   * @returns the new key entry.
   */
  addKey({ label = '', models = [] } = {}) {
    const entry = {
      key: generateKey(),
      label: typeof label === 'string' ? label.trim() : '',
      models: uniqueModels(models),
      createdAt: new Date().toISOString(),
    }
    this.document.keys.push(entry)
    this.write()
    return detach(entry)
  }

  /**
   * Remove a key by value.
   * @param key - the key to drop.
   * @returns whether anything was removed.
   */
  removeKey(key) {
    const before = this.document.keys.length
    this.document.keys = this.document.keys.filter((entry) => entry.key !== key)
    if (this.document.keys.length === before) return false
    this.write()
    return true
  }

  /**
   * Resolve a presented key to its entry.
   * @param presented - the raw bearer token from the request.
   * @returns the entry, or undefined when the key is unknown.
   */
  matchKey(presented) {
    const value = typeof presented === 'string' ? presented.trim() : ''
    if (value.length === 0) return undefined
    return this.document.keys.find((entry) => entry.key === value)
  }

  /**
   * Models one key may call: the shared list plus that key's own list.
   * @param entry - the matched key entry.
   * @returns the allowed ids, or undefined when the document is unrestricted.
   */
  allowedModels(entry) {
    if (this.document.unrestricted !== false) return undefined
    const own = uniqueModels(entry?.models)
    const shared = uniqueModels(this.document.sharedModels)
    return [...new Set([...shared, ...own])]
  }

  /**
   * Whether one model id may be used by this key.
   * @param entry - the matched key entry.
   * @param modelId - the id the caller asked for.
   * @returns true when allowed.
   */
  permits(entry, modelId) {
    const allowed = this.allowedModels(entry)
    if (allowed === undefined) return true
    return allowed.includes(modelId)
  }
}
