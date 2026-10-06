import { describe, expect, test } from 'claude-code/testing'

import {
  findRecorder,
  isMaskableUsername,
  parsePlatform,
  platformFromHome,
  processListArgv,
} from '../hooks/detect'

const MAC_PS = [
  '/sbin/launchd',
  '/usr/libexec/logd',
  '/System/Library/CoreServices/Finder.app/Contents/MacOS/Finder',
  '/Applications/iTerm.app/Contents/MacOS/iTerm2',
].join('\n')

const LINUX_PS = ['systemd', 'kthreadd', 'bash', 'node', 'gnome-shell'].join('\n')

describe('platform', () => {
  test('uname', () => {
    expect(parsePlatform('Darwin\n')).toBe('darwin')
    expect(parsePlatform('Linux\n')).toBe('linux')
    expect(parsePlatform('MINGW64_NT-10.0')).toBe('other')
  })
  test('home folder guess', () => {
    expect(platformFromHome('/Users/jins')).toBe('darwin')
    expect(platformFromHome('/home/jins')).toBe('linux')
    expect(platformFromHome(undefined)).toBe('other')
  })
  test('process list argv per platform', () => {
    expect(processListArgv('darwin')).toEqual(['ps', '-axo', 'comm='])
    expect(processListArgv('linux')).toEqual(['ps', '-eo', 'comm='])
    expect(processListArgv('other')).toBeNull()
  })
})

describe('findRecorder', () => {
  test('nothing running', () => {
    expect(findRecorder(MAC_PS, 'darwin')).toBeNull()
    expect(findRecorder(LINUX_PS, 'linux')).toBeNull()
    expect(findRecorder('', 'darwin')).toBeNull()
  })
  test('macOS recorders by full path', () => {
    const obs = `${MAC_PS}\n/Applications/OBS.app/Contents/MacOS/OBS`
    expect(findRecorder(obs, 'darwin')).toBe('OBS')
    const qt = `${MAC_PS}\n/System/Applications/QuickTime Player.app/Contents/MacOS/QuickTime Player`
    expect(findRecorder(qt, 'darwin')).toBe('QuickTime Player')
    const ui = `${MAC_PS}\n/System/Library/CoreServices/screencaptureui.app/Contents/MacOS/screencaptureui`
    expect(findRecorder(ui, 'darwin')).toBe('macOS screen recording')
    const zoom = `${MAC_PS}\n/Applications/zoom.us.app/Contents/Frameworks/CptHost.app/Contents/MacOS/CptHost`
    expect(findRecorder(zoom, 'darwin')).toBe('Zoom screen share')
    expect(findRecorder(`${MAC_PS}\n/Applications/Loom.app/Contents/MacOS/Loom`, 'darwin')).toBe('Loom')
    expect(findRecorder(`${MAC_PS}\n/Applications/CleanShot X.app/Contents/MacOS/CleanShot X`, 'darwin')).toBe(
      'CleanShot X',
    )
  })
  test('a name has to match whole, not as a part', () => {
    expect(findRecorder(`${MAC_PS}\n/usr/bin/kapture-helper\n/opt/obsidian`, 'darwin')).toBeNull()
    expect(findRecorder(`${LINUX_PS}\nobsidian\nlooming`, 'linux')).toBeNull()
  })
  test('linux recorders, including names procps cut to 15 characters', () => {
    expect(findRecorder(`${LINUX_PS}\nobs`, 'linux')).toBe('OBS')
    expect(findRecorder(`${LINUX_PS}\nwf-recorder`, 'linux')).toBe('wf-recorder')
    expect(findRecorder(`${LINUX_PS}\nsimplescreenrec`, 'linux')).toBe('SimpleScreenRecorder')
    expect(findRecorder(`${LINUX_PS}\nkooha`, 'linux')).toBe('Kooha')
    expect(findRecorder(`${LINUX_PS}\ngpu-screen-reco`, 'linux')).toBe('GPU Screen Recorder')
  })
  test('other platforms detect nothing', () => {
    expect(findRecorder('obs', 'other')).toBeNull()
  })
})

describe('usernames', () => {
  test('generic usernames are not masked as words', () => {
    expect(isMaskableUsername('jins')).toBe(true)
    expect(isMaskableUsername('root')).toBe(false)
    expect(isMaskableUsername('user')).toBe(false)
    expect(isMaskableUsername('ec2-user')).toBe(false)
    expect(isMaskableUsername('ab')).toBe(false)
  })
})
