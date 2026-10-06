// pii-shield: screen recorder and screen-share detection. Pure helpers; the
// hooks module runs the commands through `$.process.run` and hands the output
// here.
//
// Heuristic by nature: macOS has no public "is the screen being captured" API
// and Linux compositors expose none either, so this looks for the processes
// of known recorders and sharing helpers.

export type Platform = 'darwin' | 'linux' | 'other'

/** `uname -s` output → the platform. */
export function parsePlatform(uname: string): Platform {
  const s = uname.trim().toLowerCase()
  if (s.startsWith('darwin')) return 'darwin'
  if (s.startsWith('linux')) return 'linux'
  return 'other'
}

/** A guess from the home folder, for when `uname` cannot run. */
export function platformFromHome(home: string | undefined): Platform {
  if (home === undefined) return 'other'
  if (home.startsWith('/Users/')) return 'darwin'
  if (home.startsWith('/home/') || home === '/root') return 'linux'
  return 'other'
}

/**
 * The argv that lists running processes' executable names, one per line, no
 * header. macOS's `comm` is the executable's full path; procps's is the name
 * cut to 15 characters.
 */
export function processListArgv(platform: Platform): readonly string[] | null {
  if (platform === 'darwin') return ['ps', '-axo', 'comm=']
  if (platform === 'linux') return ['ps', '-eo', 'comm=']
  return null
}

export type Recorder = {
  /** The executable's name, as `ps` shows it (case-insensitive). */
  process: string
  /** What the toast calls it. */
  label: string
}

export const RECORDERS: Readonly<Record<'darwin' | 'linux', readonly Recorder[]>> = {
  darwin: [
    { process: 'QuickTime Player', label: 'QuickTime Player' },
    { process: 'screencaptureui', label: 'macOS screen recording' },
    { process: 'screencapture', label: 'macOS screencapture' },
    { process: 'OBS', label: 'OBS' },
    { process: 'obs', label: 'OBS' },
    { process: 'Loom', label: 'Loom' },
    { process: 'CleanShot X', label: 'CleanShot X' },
    { process: 'Kap', label: 'Kap' },
    { process: 'ScreenFlow', label: 'ScreenFlow' },
    { process: 'Screen Studio', label: 'Screen Studio' },
    { process: 'Camtasia', label: 'Camtasia' },
    { process: 'Camtasia 2023', label: 'Camtasia' },
    { process: 'Camtasia 2024', label: 'Camtasia' },
    { process: 'Camtasia 2025', label: 'Camtasia' },
    { process: 'Rotato', label: 'Rotato' },
    // Zoom starts CptHost only while you share your screen.
    { process: 'CptHost', label: 'Zoom screen share' },
    { process: 'caphost', label: 'Zoom screen share' },
  ],
  linux: [
    { process: 'obs', label: 'OBS' },
    { process: 'wf-recorder', label: 'wf-recorder' },
    { process: 'simplescreenrecorder', label: 'SimpleScreenRecorder' },
    { process: 'kooha', label: 'Kooha' },
    { process: 'peek', label: 'Peek' },
    { process: 'vokoscreenNG', label: 'vokoscreenNG' },
    { process: 'kazam', label: 'Kazam' },
    { process: 'gpu-screen-recorder', label: 'GPU Screen Recorder' },
    { process: 'recordmydesktop', label: 'recordMyDesktop' },
    { process: 'green-recorder', label: 'Green Recorder' },
    { process: 'blue-recorder', label: 'Blue Recorder' },
    { process: 'byzanz-record', label: 'Byzanz' },
    { process: 'wl-screenrec', label: 'wl-screenrec' },
    { process: 'CptHost', label: 'Zoom screen share' },
  ],
}

/** The part after the last `/`: macOS `comm` is a full path. */
function baseName(line: string): string {
  const trimmed = line.trim()
  const slash = trimmed.lastIndexOf('/')
  return slash === -1 ? trimmed : trimmed.slice(slash + 1)
}

/** procps cuts a process name to 15 characters (TASK_COMM_LEN - 1). */
const LINUX_COMM_LENGTH = 15

/**
 * The first known recorder in a process list (`ps` output), by its label, or
 * null when none runs.
 */
export function findRecorder(processList: string, platform: Platform): string | null {
  if (platform === 'other') return null
  const known = RECORDERS[platform]
  const running = new Set<string>()
  for (const line of processList.split('\n')) {
    const name = baseName(line).toLowerCase()
    if (name.length > 0) running.add(name)
  }
  for (const recorder of known) {
    const want = recorder.process.toLowerCase()
    if (running.has(want)) return recorder.label
    if (platform === 'linux' && want.length > LINUX_COMM_LENGTH && running.has(want.slice(0, LINUX_COMM_LENGTH))) {
      return recorder.label
    }
  }
  return null
}

/** OS usernames too generic to mask everywhere they appear as a word. */
const GENERIC_USERNAMES = new Set([
  'root',
  'user',
  'users',
  'admin',
  'administrator',
  'ubuntu',
  'debian',
  'ec2-user',
  'runner',
  'vagrant',
  'pi',
  'guest',
  'test',
  'dev',
  'developer',
  'node',
  'app',
  'docker',
  'nobody',
  'www-data',
  'default',
  'me',
])

/** Whether an OS username is specific enough to mask as a word. */
export function isMaskableUsername(name: string): boolean {
  const n = name.trim().toLowerCase()
  return n.length >= 3 && !GENERIC_USERNAMES.has(n)
}
