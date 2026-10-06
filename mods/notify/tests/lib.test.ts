import { describe, expect, test } from 'claude-code/testing'

import {
  Throttle,
  appleScriptFor,
  argvFor,
  askBody,
  base64,
  headerValue,
  maskTopic,
  ntfyRequest,
  ntfyTarget,
  shouldPush,
  statusMarkdown,
  backendsFor,
  baseName,
  clean,
  doneBody,
  errorBody,
  escapeAppleScript,
  formatDuration,
  notifySendArgv,
  osascriptArgv,
  parseBundleId,
  parseCommand,
  parseFrontAsn,
  platformFromUname,
  readConfig,
  DEFAULTS,
  subagentBody,
  terminalBundle,
  terminalNotifierArgv,
  titleFor,
} from '../hooks/lib'
import type { Note } from '../hooks/lib'

const NOTE: Note = {
  title: 'Claude Code · modemon',
  body: 'Done in 45s',
  sound: 'Glass',
  group: 'claude-code-abc',
  activate: 'com.googlecode.iterm2',
}

describe('argv', () => {
  test('terminal-notifier carries title, message, group, sound and activate', () => {
    expect(terminalNotifierArgv(NOTE)).toEqual([
      'terminal-notifier',
      '-title', 'Claude Code · modemon',
      '-message', 'Done in 45s',
      '-group', 'claude-code-abc',
      '-sound', 'Glass',
      '-activate', 'com.googlecode.iterm2',
    ])
  })

  test('terminal-notifier leaves out an empty sound and an unknown terminal', () => {
    const argv = terminalNotifierArgv({ ...NOTE, sound: '', activate: undefined })
    expect(argv).not.toContain('-sound')
    expect(argv).not.toContain('-activate')
  })

  test('terminal-notifier keeps a message that starts with a dash a value', () => {
    const argv = terminalNotifierArgv({ ...NOTE, body: '-rf everything' })
    expect(argv[4]).toBe('\u200b-rf everything')
  })

  test('osascript builds one display notification script', () => {
    expect(osascriptArgv(NOTE)).toEqual([
      'osascript',
      '-e',
      'display notification "Done in 45s" with title "Claude Code · modemon" sound name "Glass"',
    ])
    expect(appleScriptFor({ ...NOTE, sound: '' })).toBe(
      'display notification "Done in 45s" with title "Claude Code · modemon"',
    )
  })

  test('osascript escapes quotes and backslashes in the message and title', () => {
    const body = 'He said "hi" in C:\\temp\\x and \\"'
    expect(escapeAppleScript(body)).toBe('He said \\"hi\\" in C:\\\\temp\\\\x and \\\\\\"')
    const script = appleScriptFor({ ...NOTE, title: 'a "b"', body })
    expect(script).toBe(
      'display notification "He said \\"hi\\" in C:\\\\temp\\\\x and \\\\\\"" with title "a \\"b\\"" sound name "Glass"',
    )
    // every double quote inside the literals is escaped: strip escapes, count the delimiters
    const unescaped = script.replace(/\\\\/g, '').replace(/\\"/g, '')
    expect((unescaped.match(/"/g) ?? []).length).toBe(6)
  })

  test('osascript flattens newlines so the script stays one line', () => {
    expect(appleScriptFor({ ...NOTE, body: 'one\ntwo\r\nthree' })).toContain('"one two three"')
  })

  test('notify-send passes title and body after -- and escapes markup', () => {
    expect(notifySendArgv({ ...NOTE, body: '<b>x</b> & "y" \\ z' })).toEqual([
      'notify-send', '-a', 'Claude Code', '--', 'Claude Code · modemon', '&lt;b&gt;x&lt;/b&gt; &amp; "y" \\ z',
    ])
  })

  test('argvFor dispatches per backend', () => {
    expect(argvFor('terminal-notifier', NOTE)[0]).toBe('terminal-notifier')
    expect(argvFor('osascript', NOTE)[0]).toBe('osascript')
    expect(argvFor('notify-send', NOTE)[0]).toBe('notify-send')
  })
})

describe('platform and terminal', () => {
  test('uname output maps to a platform and its backends', () => {
    expect(platformFromUname('Darwin\n')).toBe('darwin')
    expect(platformFromUname('Linux\n')).toBe('linux')
    expect(platformFromUname('MINGW64_NT')).toBe('other')
    expect(backendsFor('darwin')).toEqual(['terminal-notifier', 'osascript'])
    expect(backendsFor('linux')).toEqual(['notify-send'])
    expect(backendsFor('other')).toEqual([])
  })

  test('TERM_PROGRAM maps to a bundle id, __CFBundleIdentifier as fallback', () => {
    expect(terminalBundle('Apple_Terminal', undefined)).toBe('com.apple.Terminal')
    expect(terminalBundle('iTerm.app', undefined)).toBe('com.googlecode.iterm2')
    expect(terminalBundle('ghostty', undefined)).toBe('com.mitchellh.ghostty')
    expect(terminalBundle('vscode', undefined)).toBe('com.microsoft.VSCode')
    expect(terminalBundle('WezTerm', undefined)).toBe('com.github.wez.wezterm')
    expect(terminalBundle('tmux', 'net.kovidgoyal.kitty')).toBe('net.kovidgoyal.kitty')
    expect(terminalBundle(undefined, undefined)).toBeUndefined()
    expect(terminalBundle(undefined, 'bad id; rm')).toBeUndefined()
  })

  test('lsappinfo output parses', () => {
    expect(parseFrontAsn('ASN:0x0-0x1d01d:\n')).toBe('ASN:0x0-0x1d01d:')
    expect(parseFrontAsn('')).toBeUndefined()
    expect(parseBundleId('"CFBundleIdentifier"="com.apple.Terminal"\n')).toBe('com.apple.Terminal')
    expect(parseBundleId('nothing')).toBeUndefined()
  })
})

describe('text', () => {
  test('title names the repo', () => {
    expect(titleFor('modemon')).toBe('Claude Code · modemon')
    expect(titleFor('')).toBe('Claude Code')
    expect(baseName('/home/user/modemon/')).toBe('modemon')
  })

  test('bodies are short and specific', () => {
    expect(formatDuration(45_000)).toBe('45s')
    expect(formatDuration(72_000)).toBe('1m 12s')
    expect(formatDuration(3_660_000)).toBe('1h 1m')
    expect(doneBody(45_000, '## Fixed the bug\n\nmore')).toBe('Done in 45s: Fixed the bug')
    expect(doneBody(45_000, '')).toBe('Done in 45s')
    expect(askBody([{ question: 'Which one?' }])).toBe('Question: Which one?')
    expect(errorBody('rate_limit')).toBe('Error: rate limited')
    expect(errorBody('server_error', '529')).toBe('Error: API server error (529)')
    expect(subagentBody('Find the config', 'Explore')).toBe('Agent done: Find the config')
    expect(subagentBody(undefined, 'Explore')).toBe('Agent done: Explore')
    expect(clean('x'.repeat(300)).length).toBe(180)
  })

  test('commands parse', () => {
    expect(parseCommand('')).toBe('status')
    expect(parseCommand(' Test ')).toBe('test')
    expect(parseCommand('off')).toBe('off')
    expect(parseCommand('banana')).toBe('help')
  })

  test('config fills defaults and rejects bad values', () => {
    expect(readConfig(undefined).minTurnSeconds).toBe(30)
    expect(readConfig({ minTurnSeconds: -1, sound: ' Ping ' })).toMatchObject({ minTurnSeconds: 30, sound: 'Ping' })
  })
})

describe('throttle', () => {
  test('one per kind per window', () => {
    const t = new Throttle(5000)
    expect(t.allow('done', 0)).toBe(true)
    expect(t.allow('done', 4999)).toBe(false)
    expect(t.allow('input', 4999)).toBe(true)
    expect(t.allow('done', 5000)).toBe(true)
    t.reset()
    expect(t.allow('done', 5001)).toBe(true)
  })
})

/** Decodes RFC 2047 B-encoded UTF-8 words, as ntfy does, to check round trips. */
function decodeWords(value: string): string {
  const B = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  const bytes: number[] = []
  for (const word of value.split(' ')) {
    const m = /^=\?UTF-8\?B\?([A-Za-z0-9+/=]*)\?=$/.exec(word)
    if (m === null) throw new Error(`not an encoded word: ${word}`)
    const b64 = (m[1] ?? '').replace(/=+$/, '')
    let acc = 0
    let bits = 0
    for (const ch of b64) {
      acc = (acc << 6) | B.indexOf(ch)
      bits += 6
      if (bits >= 8) {
        bits -= 8
        bytes.push((acc >> bits) & 0xff)
      }
    }
  }
  let out = ''
  for (let i = 0; i < bytes.length; ) {
    const b = bytes[i] ?? 0
    const n = b < 0x80 ? 1 : b < 0xe0 ? 2 : b < 0xf0 ? 3 : 4
    let cp = n === 1 ? b : b & (0xff >> (n + 1))
    for (let k = 1; k < n; k++) cp = (cp << 6) | ((bytes[i + k] ?? 0) & 63)
    out += String.fromCodePoint(cp)
    i += n
  }
  return out
}

describe('ntfy', () => {
  test('base64 matches the standard vectors', () => {
    expect(base64([...'Man'].map(c => c.charCodeAt(0)))).toBe('TWFu')
    expect(base64([...'Ma'].map(c => c.charCodeAt(0)))).toBe('TWE=')
    expect(base64([...'M'].map(c => c.charCodeAt(0)))).toBe('TQ==')
  })

  test('ASCII header values pass through, flattened', () => {
    expect(headerValue('Claude Code - repo')).toBe('Claude Code - repo')
    expect(headerValue('evil\r\nX-Injected: 1')).toBe('evil X-Injected: 1')
  })

  test('non-ASCII titles become RFC 2047 encoded words', () => {
    expect(headerValue('Claude Code · modemon')).toBe('=?UTF-8?B?Q2xhdWRlIENvZGUgwrcgbW9kZW1vbg==?=')
    expect(decodeWords(headerValue('Claude Code · modemon'))).toBe('Claude Code · modemon')
  })

  test('long non-ASCII titles split into words of at most 75 chars, on character boundaries', () => {
    const title = 'Claude Code · 日本語のリポジトリ 🚀 émoji-heavy-name'
    const v = headerValue(title)
    const words = v.split(' ')
    expect(words.length).toBeGreaterThan(1)
    for (const w of words) expect(w.length).toBeLessThanOrEqual(75)
    expect(decodeWords(v)).toBe(title)
  })

  test('ASCII text that looks like an encoded word is encoded itself', () => {
    const v = headerValue('=?UTF-8?B?aGk=?=')
    expect(v).toStartWith('=?UTF-8?B?')
    expect(decodeWords(v)).toBe('=?UTF-8?B?aGk=?=')
  })

  test('target: off, bad topic, bad server, trailing slash, self-hosted path', () => {
    expect(ntfyTarget('https://ntfy.sh', '')).toEqual({ error: 'off (no ntfyTopic set)' })
    expect('error' in ntfyTarget('https://ntfy.sh', 'has space')).toBe(true)
    expect('error' in ntfyTarget('https://ntfy.sh', 'a/b')).toBe(true)
    expect('error' in ntfyTarget('ftp://x', 'topic')).toBe(true)
    expect('error' in ntfyTarget('https://user@evil', 'topic')).toBe(true)
    expect(ntfyTarget('https://ntfy.sh/', 'abc_DEF-123')).toEqual({
      url: 'https://ntfy.sh/abc_DEF-123',
      server: 'https://ntfy.sh',
      topic: 'abc_DEF-123',
    })
    expect(ntfyTarget('', 'abc')).toMatchObject({ url: 'https://ntfy.sh/abc' })
    expect(ntfyTarget('http://10.0.0.2:8080/ntfy//', 'abc')).toMatchObject({ url: 'http://10.0.0.2:8080/ntfy/abc' })
  })

  test('request: POST with Title, Priority, Tags and the body', () => {
    const needs = ntfyRequest('https://ntfy.sh/t', 'input', { title: 'Claude Code', body: 'Question: <which> & "why"?' })
    expect(needs).toEqual({
      url: 'https://ntfy.sh/t',
      init: {
        method: 'POST',
        headers: {
          Title: 'Claude Code',
          Priority: 'high',
          Tags: 'question',
          'Content-Type': 'text/plain; charset=utf-8',
        },
        body: 'Question: <which> & "why"?',
      },
    })
    expect(ntfyRequest('u', 'error', NOTE).init.headers).toMatchObject({ Priority: 'high', Tags: 'warning' })
    expect(ntfyRequest('u', 'done', NOTE).init.headers).toMatchObject({ Priority: 'default', Tags: 'white_check_mark' })
    expect(ntfyRequest('u', 'subagent', NOTE).init.headers).toMatchObject({ Priority: 'default', Tags: 'robot' })
    // non-ASCII bodies stay UTF-8 (ntfy reads the body as UTF-8); only headers are encoded
    expect(ntfyRequest('u', 'done', { title: 'é', body: 'Done: café ✓' }).init.body).toBe('Done: café ✓')
  })

  test('topic masking keeps only the ends', () => {
    expect(maskTopic('claude-x7Hq9vR2mK4pL8sT')).toBe('cl••••sT')
    expect(maskTopic('abc')).toBe('••••')
    expect(maskTopic('abcdefg')).not.toContain('a')
  })

  test('shouldPush: skipped only while focused and the desktop side did not fail', () => {
    expect(shouldPush(true, false, 'failed')).toBe(true) // cloud / no notifier
    expect(shouldPush(true, false, 'sent')).toBe(true) // away from a working desktop
    expect(shouldPush(true, true, 'skipped')).toBe(false)
    expect(shouldPush(true, true, 'sent')).toBe(false)
    expect(shouldPush(true, true, 'failed')).toBe(true)
    expect(shouldPush(false, true, 'sent')).toBe(true)
  })

  test('readConfig: ntfy defaults and trimming', () => {
    expect(readConfig(undefined)).toMatchObject({ ntfyTopic: '', ntfyServer: 'https://ntfy.sh', ntfyOnlyWhenAway: true })
    expect(readConfig({ ntfyTopic: ' abc ', ntfyServer: '  ' })).toMatchObject({ ntfyTopic: 'abc', ntfyServer: 'https://ntfy.sh' })
  })

  test('status markdown masks the topic and flags a short one', () => {
    const base = { isMuted: false, platform: 'linux' as const, backend: undefined, lastError: undefined, focus: 'x', lastNtfy: undefined }
    const long = statusMarkdown({ ...base, config: { ...DEFAULTS, ntfyTopic: 'claude-x7Hq9vR2mK4pL8sT' } })
    expect(long).toContain('`https://ntfy.sh/cl••••sT`')
    expect(long).not.toContain('x7Hq9vR2mK4pL8sT')
    expect(long).not.toContain('short topic')
    const short = statusMarkdown({ ...base, config: { ...DEFAULTS, ntfyTopic: 'mytopic123' } })
    expect(short).toContain('short topic')
    const off = statusMarkdown({ ...base, config: DEFAULTS })
    expect(off).toContain('**Phone (ntfy):** off')
  })
})
