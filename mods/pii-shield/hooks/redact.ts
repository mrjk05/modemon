// pii-shield: the redaction engine. Pure (no `$`), so it is unit-tested.
//
// Every rule replaces what it matches with a placeholder made of private-use
// characters, so a later rule never matches inside an earlier mask (a phone
// rule inside a masked card, a name inside a masked e-mail). The placeholders
// are swapped for the visible masks at the end.
//
// No rule matches across a line break and no mask holds one, so a redacted
// text has exactly the line count of the original (tool renderers such as a
// diff view rely on that).

export type Category = 'contact' | 'network' | 'financial' | 'secrets' | 'names' | 'paths'

export const CATEGORIES: readonly Category[] = [
  'contact',
  'network',
  'financial',
  'secrets',
  'names',
  'paths',
]

export type RedactOptions = {
  /** Names or words to mask, matched case-insensitively on word boundaries. */
  names?: readonly string[]
  /** Categories to mask; a category left out is on. */
  categories?: Partial<Record<Category, boolean>>
}

/** The block every mask is drawn with: fixed width, so lengths do not leak. */
export const BLOCK = '████'

/** The visible mask: the block, then the kind of value it hides. */
export function mask(tag?: string): string {
  return tag === undefined ? BLOCK : `${BLOCK}[${tag}]`
}

// ---------------------------------------------------------------------------
// Checksums

/** Luhn (mod 10) check of a string of digits. */
export function luhn(digits: string): boolean {
  if (!/^\d+$/.test(digits)) return false
  let sum = 0
  let double = false
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let d = digits.charCodeAt(i) - 48
    if (double) {
      d *= 2
      if (d > 9) d -= 9
    }
    sum += d
    double = !double
  }
  return sum % 10 === 0
}

/** Issuer prefixes of the card networks; keeps epoch-ms timestamps out. */
const CARD_PREFIX = /^(?:4|5[1-5]|2[2-7]|3[47]|3[068]|35|6)/

/** A 13 to 19 digit card number with a known issuer prefix and a valid Luhn digit. */
export function isCardNumber(digits: string): boolean {
  return digits.length >= 13 && digits.length <= 19 && CARD_PREFIX.test(digits) && luhn(digits)
}

/** ISO 13616 IBAN check: shape, then mod 97 of the rearranged number is 1. */
export function isIban(raw: string): boolean {
  const s = raw.replace(/[ \t]/g, '').toUpperCase()
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(s)) return false
  const moved = s.slice(4) + s.slice(0, 4)
  let rest = 0
  for (const ch of moved) {
    const code = ch.charCodeAt(0)
    const value = code >= 65 ? String(code - 55) : ch
    for (const digit of value) rest = (rest * 10 + (digit.charCodeAt(0) - 48)) % 97
  }
  return rest === 1
}

// ---------------------------------------------------------------------------
// Secret-ish assignment names

const SECRET_WORDS = new Set([
  'password',
  'passwd',
  'pwd',
  'pass',
  'passphrase',
  'secret',
  'secrets',
  'token',
  'credential',
  'credentials',
  'creds',
  'apikey',
  'privatekey',
  'secretkey',
  'accesskey',
  'clientsecret',
  'dsn',
  'cookie',
  'auth',
])

/** Words that, beside `key`, make it an API or signing key. */
const KEY_QUALIFIERS = new Set([
  'api',
  'access',
  'secret',
  'private',
  'client',
  'signing',
  'sign',
  'encryption',
  'enc',
  'master',
  'license',
  'licence',
  'service',
  'account',
  'app',
  'session',
  'webhook',
  'aws',
  'openai',
  'anthropic',
  'stripe',
  'gcp',
  'google',
  'gemini',
  'deploy',
  'ssh',
  'admin',
])

/** Words that say the value is metadata about a secret, not the secret. */
const NOT_SECRET_WORDS = new Set([
  'max',
  'min',
  'count',
  'limit',
  'num',
  'size',
  'len',
  'length',
  'usage',
  'budget',
  'type',
  'kind',
  'name',
  'names',
  'id',
  'ids',
  'file',
  'path',
  'dir',
  'url',
  'uri',
  'endpoint',
  'host',
  'port',
  'header',
  'prefix',
  'expires',
  'expiry',
  'ttl',
  'timeout',
  'field',
  'param',
  'hint',
  'label',
  'placeholder',
  'policy',
  'format',
  'mode',
  'algorithm',
  'alg',
  'scope',
  'scopes',
  'provider',
  'env',
  'var',
  'required',
  'enabled',
  'tokens',
  'user',
  'username',
  'email',
  'length',
  'rotation',
  'store',
  'manager',
])

/** The parts of an identifier: `apiKey`, `API_KEY`, `api-key` → `api`, `key`. */
export function nameParts(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .split(/[_.\-]+/)
    .filter(part => part.length > 0)
}

/** Whether an assignment's name says its value is a secret. */
export function isSecretName(name: string): boolean {
  const parts = nameParts(name)
  if (parts.length === 0) return false
  if (parts.some(part => NOT_SECRET_WORDS.has(part))) return false
  if (parts.some(part => SECRET_WORDS.has(part))) return true
  const hasKey = parts.includes('key')
  if (!hasKey) return false
  if (parts.some(part => KEY_QUALIFIERS.has(part))) return true
  // `MY_SERVICE_KEY=...`: an all-caps environment name ending in KEY.
  return /^[A-Z][A-Z0-9_]*_KEY$/.test(name)
}

const PLACEHOLDER_VALUE =
  /^(?:\$\{?[\w.:-]*\}?|<[^>]*>?|\{\{[^}]*\}\}|%[\w]+%|\*+|x{3,}|X{3,}|\.\.\.|…|null|nil|none|undefined|true|false|string|number|boolean|bigint|any|unknown|object|str|int|bool|bytes|required|optional|redacted|secret|password|token|env|os\.environ.*|process\.env.*)$/i

const PATH_VALUE = /^(?:\/|~\/|\.\.?\/|[A-Za-z]:\\)/

/** Whether a value assigned to a secret-ish name is worth masking. */
function isSecretValue(value: string, isQuoted: boolean, isEnvStyle: boolean): boolean {
  if (value.length === 0) return false
  if (value.includes(SENTINEL_OPEN)) return !isWholeSentinel(value)
  if (PLACEHOLDER_VALUE.test(value)) return false
  if (PATH_VALUE.test(value)) return false
  if (value.includes(BLOCK)) return false
  if (isQuoted || isEnvStyle) return true
  // A bare value after `name:` or `name =` in code: skip expressions and
  // short words, which are far more often types and variables than secrets.
  if (value.length < 6) return false
  if (/[([{]/.test(value)) return false
  if (/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/.test(value)) return false
  // A bare identifier is a variable unless it carries a digit (`hunter2`).
  if (/^[A-Za-z_$][\w$]*$/.test(value) && !/\d/.test(value)) return false
  return true
}

// ---------------------------------------------------------------------------
// Placeholders

const SENTINEL_OPEN = ''
const SENTINEL_CLOSE = ''
const SENTINEL_DIGIT_BASE = 0xe100
const SENTINEL = /([-]+)/g

function isWholeSentinel(value: string): boolean {
  return /^(?:[-]+)+$/.test(value)
}

class Masks {
  readonly list: string[] = []

  put(visible: string): string {
    const index = this.list.length
    this.list.push(visible)
    const digits = index
      .toString(36)
      .split('')
      .map(ch => String.fromCharCode(SENTINEL_DIGIT_BASE + parseInt(ch, 36)))
      .join('')
    return SENTINEL_OPEN + digits + SENTINEL_CLOSE
  }

  restore(text: string): string {
    return text.replace(SENTINEL, (whole, digits: string) => {
      const index = parseInt(
        digits
          .split('')
          .map(ch => (ch.charCodeAt(0) - SENTINEL_DIGIT_BASE).toString(36))
          .join(''),
        36,
      )
      return this.list[index] ?? whole
    })
  }
}

// ---------------------------------------------------------------------------
// Rules

type Rule = {
  category: Category
  /** Global, never matching a line break. */
  pattern: RegExp
  /** The replacement, or null to keep the match. */
  replace: (masks: Masks, match: string, groups: readonly (string | undefined)[]) => string | null
}

function whole(tag: string, accept?: (match: string, groups: readonly (string | undefined)[]) => boolean): Rule['replace'] {
  return (masks, match, groups) => (accept === undefined || accept(match, groups) ? masks.put(mask(tag)) : null)
}

const hasDigitAndLetter = (s: string): boolean => /\d/.test(s) && /[A-Za-z]/.test(s)

const IMAGE_OR_CODE_TLD = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'svg',
  'webp',
  'avif',
  'ico',
  'js',
  'mjs',
  'cjs',
  'ts',
  'tsx',
  'jsx',
  'json',
  'css',
  'scss',
  'txt',
  'py',
  'rb',
  'rs',
  'html',
  'lock',
  'yaml',
  'yml',
  'toml',
])

/** A valid IPv6 address with one `::` at most, 8 groups without one. */
export function isIpv6(s: string): boolean {
  if (!/^[0-9A-Fa-f:]+$/.test(s)) return false
  const doubles = s.split('::').length - 1
  if (doubles > 1) return false
  if (doubles === 0) {
    const groups = s.split(':')
    return groups.length === 8 && groups.every(g => g.length >= 1 && g.length <= 4)
  }
  const [head = '', tail = ''] = s.split('::')
  const left = head === '' ? [] : head.split(':')
  const right = tail === '' ? [] : tail.split(':')
  const groups = [...left, ...right]
  return groups.length <= 7 && groups.every(g => g.length >= 1 && g.length <= 4)
}

function isBoringIpv6(s: string): boolean {
  const lower = s.toLowerCase()
  if (lower === '::' || lower === '::1') return true
  // `Abc::Def` (a path in C++ or Rust) is hex too; an address has digits.
  const groups = lower.split(':').filter(g => g.length > 0)
  return groups.length < 2 || !groups.some(g => /\d/.test(g))
}

const RULES: readonly Rule[] = [
  // --- secrets -------------------------------------------------------------
  {
    // A private key block: the BEGIN/END lines stay, each body line is masked.
    category: 'secrets',
    pattern:
      /-----BEGIN ([A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?)-----([\s\S]*?)(-----END \1-----|$(?![\s\S]))/g,
    replace: (masks, _match, groups) => {
      const label = groups[0] ?? 'PRIVATE KEY'
      const body = groups[1] ?? ''
      const end = groups[2] ?? ''
      let isFirst = true
      const masked = body.replace(/[^\r\n]+/g, line => {
        if (line.trim().length === 0) return line
        const visible = isFirst ? mask('private key') : BLOCK
        isFirst = false
        return masks.put(visible)
      })
      return `-----BEGIN ${label}-----${masked}${end}`
    },
  },
  {
    category: 'secrets',
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g,
    replace: whole('jwt'),
  },
  {
    category: 'secrets',
    pattern: /(?<![\w-])sk-ant-[A-Za-z0-9_-]{16,}/g,
    replace: whole('key'),
  },
  {
    category: 'secrets',
    pattern: /(?<![\w-])sk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/g,
    replace: whole('key', hasDigitAndLetter),
  },
  {
    category: 'secrets',
    pattern:
      /\b(?:[rsp]k_(?:live|test)_[A-Za-z0-9]{16,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{22,}|glpat-[A-Za-z0-9_-]{20,}|xox[abposr]-[A-Za-z0-9-]{10,}|(?:AKIA|ASIA)[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|npm_[A-Za-z0-9]{36}|hf_[A-Za-z0-9]{30,})(?![\w-])/g,
    replace: whole('key'),
  },
  {
    // `Bearer <token>`, `Basic <base64>`: the scheme stays.
    category: 'secrets',
    pattern: /\b(Bearer|Basic)([ \t]+)([A-Za-z0-9._~+/-]+=*)/g,
    replace: (masks, match, groups) => {
      const token = groups[2] ?? ''
      const isTokenLike = token.length >= 16 || (token.length >= 8 && /\d/.test(token))
      if (!isTokenLike || token.includes(SENTINEL_OPEN)) return null
      return `${groups[0] ?? ''}${groups[1] ?? ''}${masks.put(mask('token'))}`
    },
  },
  {
    // `scheme://user:password@host`: the password.
    category: 'secrets',
    pattern: /\b([a-z][a-z0-9+.-]*:\/\/)([^\s:@/?#]+):([^\s@/?#]+)@/gi,
    replace: (masks, _match, groups) => {
      const password = groups[2] ?? ''
      if (PLACEHOLDER_VALUE.test(password) || isWholeSentinel(password)) return null
      return `${groups[0] ?? ''}${groups[1] ?? ''}:${masks.put(mask('secret'))}@`
    },
  },
  {
    // `API_KEY=...`, `password: "..."`, `"client_secret": "..."`.
    category: 'secrets',
    pattern:
      /(?<![\w.$])(["']?)([A-Za-z_][A-Za-z0-9_.-]*)\1([ \t]*)(=|:)([ \t]*)(?:"([^"\r\n]*)"|'([^'\r\n]*)'|([^\s'",;)}\]{[]+))/g,
    replace: (masks, match, groups) => {
      const [quote = '', name = '', before = '', sep = '', after = '', dq, sq, bare] = groups
      if (!isSecretName(name)) return null
      // `a:b` with no space is a URL scheme, a label or a namespace, not an assignment.
      if (sep === ':' && after === '' && quote === '' && bare !== undefined) return null
      const isEnvStyle = sep === '=' && /^[A-Z][A-Z0-9_]*$/.test(name)
      const value = dq ?? sq ?? bare ?? ''
      const isQuoted = dq !== undefined || sq !== undefined
      if (!isSecretValue(value, isQuoted, isEnvStyle)) return null
      const visible = masks.put(mask('secret'))
      const head = `${quote}${name}${quote}${before}${sep}${after}`
      if (dq !== undefined) return `${head}"${visible}"`
      if (sq !== undefined) return `${head}'${visible}'`
      return `${head}${visible}`
    },
  },

  // --- contact: e-mail -----------------------------------------------------
  {
    category: 'contact',
    pattern: /(?<![\w.%+-])([A-Za-z0-9._%+-]+)@((?:[A-Za-z0-9-]+\.)+([A-Za-z]{2,}))(?![\w-])/g,
    replace: whole('email', (_match, groups) => {
      const local = groups[0] ?? ''
      const tld = (groups[2] ?? '').toLowerCase()
      if (local === 'git') return false // git@github.com: an SSH login, not a person
      return !IMAGE_OR_CODE_TLD.has(tld) // logo@2x.png
    }),
  },

  // --- financial -----------------------------------------------------------
  {
    category: 'financial',
    pattern: /(?<![\w.+-])(?:\d[ -]?){12,18}\d(?![\w-]|\.\d)/g,
    replace: whole('card', match => {
      const parts = match.split(/[ -]/)
      if (parts.length > 1) {
        // Grouped like a card (4-4-4-4, 4-6-5), not a list of small numbers.
        const head = parts.slice(0, -1)
        if (!head.every(part => part.length >= 4 && part.length <= 6)) return false
      }
      return isCardNumber(match.replace(/[ -]/g, ''))
    }),
  },
  {
    category: 'financial',
    pattern: /\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{4}){2,7}(?:[ ]?[A-Z0-9]{1,3})?\b/g,
    replace: whole('iban', match => isIban(match)),
  },
  {
    category: 'financial',
    pattern: /(?<![\w-])(?!000|666|9\d\d)\d{3}-(?!00)\d{2}-(?!0000)\d{4}(?![\w-])/g,
    replace: whole('ssn'),
  },
  {
    // A number right after a banking word: account, routing, sort code, BSB.
    category: 'financial',
    pattern:
      /\b(sort[ \t-]?code|routing(?:[ \t]+(?:number|no\.?|#))?|aba|(?:bank[ \t]+)?account(?:[ \t]+(?:number|no\.?|#))?|acct(?:[ \t]*(?:no\.?|#))?|bsb)([ \t]*[:#=]?[ \t]*)(\d[\d \t-]{4,22}\d)(?![\w-])/gi,
    replace: (masks, _match, groups) => `${groups[0] ?? ''}${groups[1] ?? ''}${masks.put(mask('bank'))}`,
  },

  // --- contact: phone ------------------------------------------------------
  {
    category: 'contact',
    pattern: /(?<![\w+])\+(?:\d[ \t.()-]{0,2}){7,14}\d(?!\w)/g,
    replace: whole('phone', match => {
      const digits = match.replace(/\D/g, '').length
      return digits >= 8 && digits <= 15
    }),
  },
  {
    category: 'contact',
    pattern: /(?<![\w.+-])\([2-9]\d{2}\)[ \t]?\d{3}[-. \t]\d{4}(?![\w-]|\.\d)/g,
    replace: whole('phone'),
  },
  {
    category: 'contact',
    pattern: /(?<![\w.+-])(?:1-)?[2-9]\d{2}([-.])\d{3}\1\d{4}(?![\w-]|\.\d)/g,
    replace: whole('phone'),
  },

  // --- network -------------------------------------------------------------
  {
    category: 'network',
    pattern:
      /(?<![\w.-])(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?![\w-]|\.\d)/g,
    replace: whole('ip', match => !/^(?:127\.|0\.0\.0\.0$|255\.255\.)/.test(match)),
  },
  {
    category: 'network',
    pattern: /(?<![\w:.])(?:[0-9A-Fa-f]{0,4}:){2,7}[0-9A-Fa-f]{0,4}(?![\w:])/g,
    replace: whole('ip', match => isIpv6(match) && !isBoringIpv6(match)),
  },

  // --- paths: the username in a home folder ---------------------------------
  {
    category: 'paths',
    pattern:
      /(?<=(?:^|[^\w.~-])(?:\/Users|\/home|[A-Za-z]:\\Users|[A-Za-z]:\\\\Users)(?:\/|\\\\|\\))([^/\\\s'"`:;,)\]}<>|*?]+)(?=[/\\\s'"`:;,)\]}<>]|$)/gm,
    replace: (masks, match) => (/^(?:Shared|Public|Default|All Users)$/i.test(match) ? null : masks.put(BLOCK)),
  },
]

// ---------------------------------------------------------------------------
// Names

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Clean a list of names: trimmed, deduplicated, two characters at least. */
export function normalizeNames(names: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of names) {
    const name = raw.trim().replace(/\s+/g, ' ')
    const key = name.toLowerCase()
    if (name.length < 2 || seen.has(key)) continue
    seen.add(key)
    out.push(name)
  }
  return out.sort((a, b) => b.length - a.length)
}

/** Parse the `names` setting: comma or newline separated. */
export function parseNameList(value: string | undefined): string[] {
  if (value === undefined) return []
  return normalizeNames(value.split(/[,\n;]/))
}

let namesCache: { key: string; pattern: RegExp | null } = { key: '', pattern: null }

function namesPattern(names: readonly string[]): RegExp | null {
  const clean = normalizeNames(names)
  const key = clean.join('\u0000')
  if (namesCache.key === key) return namesCache.pattern
  const pattern =
    clean.length === 0
      ? null
      : new RegExp(
          `(?<![\\p{L}\\p{N}_])(?:${clean
            .map(name => name.split(' ').map(escapeRegExp).join('[ \\t]+'))
            .join('|')})(?![\\p{L}\\p{N}_])`,
          'giu',
        )
  namesCache = { key, pattern }
  return pattern
}

// ---------------------------------------------------------------------------
// The engine

function isOn(options: RedactOptions | undefined, category: Category): boolean {
  return options?.categories?.[category] !== false
}

function applyRule(text: string, rule: Rule, masks: Masks): string {
  rule.pattern.lastIndex = 0
  return text.replace(rule.pattern, (...args: unknown[]) => {
    const match = args[0] as string
    // Arguments after the match: the groups, then offset, input (and groups object).
    const tail = args.slice(1)
    const hasNamed = typeof tail[tail.length - 1] === 'object'
    const groupCount = tail.length - (hasNamed ? 3 : 2)
    const groups = tail.slice(0, groupCount) as (string | undefined)[]
    return rule.replace(masks, match, groups) ?? match
  })
}

const cache = new Map<string, string>()
const CACHE_LIMIT = 500
const CACHE_MIN_LENGTH = 32

function cacheKey(text: string, options: RedactOptions | undefined): string {
  const flags = CATEGORIES.map(c => (isOn(options, c) ? '1' : '0')).join('')
  return `${flags}\u0001${normalizeNames(options?.names ?? []).join('\u0000')}\u0001${text}`
}

/** Quick test: could this text hold anything a rule matches? */
function mayHoldPii(text: string): boolean {
  return /[\d@:=/\\]|eyJ|Bearer|Basic|-----BEGIN/.test(text)
}

/**
 * Masks what looks like personal data or a secret in `text`. Lines are kept:
 * the output has the same line breaks as the input.
 */
export function redactText(text: string, options?: RedactOptions): string {
  if (text.length === 0) return text
  const names = options?.names ?? []
  const namesOn = isOn(options, 'names') && names.length > 0
  if (!namesOn && !mayHoldPii(text)) return text

  const useCache = text.length >= CACHE_MIN_LENGTH
  const key = useCache ? cacheKey(text, options) : ''
  if (useCache) {
    const hit = cache.get(key)
    if (hit !== undefined) return hit
  }

  const masks = new Masks()
  let out = text
  for (const rule of RULES) {
    if (isOn(options, rule.category)) out = applyRule(out, rule, masks)
  }
  if (namesOn) {
    const pattern = namesPattern(names)
    if (pattern !== null) {
      pattern.lastIndex = 0
      out = out.replace(pattern, () => masks.put(BLOCK))
    }
  }
  const result = masks.list.length === 0 ? text : masks.restore(out)

  if (useCache) {
    if (cache.size >= CACHE_LIMIT) {
      const oldest = cache.keys().next()
      if (oldest.done !== true) cache.delete(oldest.value)
    }
    cache.set(key, result)
  }
  return result
}

/** Keys whose string values are identifiers or enums, never drawn as text. */
const KEEP_KEYS = new Set(['type', 'id', 'tool_use_id', 'toolUseId', 'agentId', 'kind', 'mimeType', 'media_type'])

const MAX_DEPTH = 40

/**
 * Redacts every string inside a plain-data value (tool inputs and results),
 * keeping its shape: same keys, same array lengths, numbers and booleans
 * untouched. Returns the same object where nothing changed.
 */
export function redactDeep<T>(value: T, options?: RedactOptions, depth = 0): T {
  if (typeof value === 'string') return redactText(value, options) as T
  if (value === null || typeof value !== 'object' || depth > MAX_DEPTH) return value
  if (Array.isArray(value)) {
    let changed = false
    const next = value.map(item => {
      const red = redactDeep(item, options, depth + 1)
      if (red !== item) changed = true
      return red
    })
    return (changed ? next : value) as T
  }
  const proto = Object.getPrototypeOf(value) as unknown
  if (proto !== Object.prototype && proto !== null) return value
  let changed = false
  const next: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (KEEP_KEYS.has(k)) {
      next[k] = v
      continue
    }
    const red = redactDeep(v, options, depth + 1)
    if (red !== v) changed = true
    next[k] = red
  }
  return (changed ? next : value) as T
}

/** Whether `redactText` would change `text`. */
export function hasPii(text: string, options?: RedactOptions): boolean {
  return redactText(text, options) !== text
}
