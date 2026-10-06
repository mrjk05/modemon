import { describe, expect, test } from 'claude-code/testing'

import {
  Throttle,
  appleScriptFor,
  argvFor,
  askBody,
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
