import type { EngineInterface, Register } from 'claude-code'

// ponytail: fixed 50-min wait (1-hour cache TTL); a ping fires only after 50 idle minutes.
const PING_MS = 50 * 60_000
const H = 3_600_000
const MIN = 60_000
// A ping re-reads the cache at about a tenth of the rebuild price, so past roughly 17 idle hours it costs more than it saves.
const MAX_MS = 12 * H
const MANUAL_MS = 6 * H
const AUTO_MS = 3 * H
const PING = 'Cache keepalive from the keptwarm mod. Reply with just "ok" and do nothing else.'
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
// Only a prompt a person types counts as activity: never our own pings, loops, tasks, peers or the SDK.
const REAL_ORIGINS = ['composer', 'bridge', 'slack-ping']

// Per session (survives a hot reload): the deadline, and the window it slides by.
// win: -1 follows the saved auto setting, 0 is off for this session, n is this session's own window.
const until = { plugin: 'keptwarm', key: 'until' } as const
const win = { plugin: 'keptwarm', key: 'win' } as const

let timer: { cancel(): void } | undefined
let busy = false // a main-thread turn is running: it keeps the cache warm, and its end re-arms the timer
let pingPending = false // a ping was submitted and no turn has started for it yet

// Fixed formatting, so it never depends on the machine's locale.
function hhmm(ms: number, now: number) {
  const d = new Date(ms)
  const t = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  return d.toDateString() === new Date(now).toDateString() ? t : `${DAYS[d.getDay()]} ${t}`
}

function dur(ms: number) {
  return ms >= H ? `${+(ms / H).toFixed(1)}h` : `${Math.round(ms / MIN)}m`
}

// "2h", "30m", " 2 H " -> ms, or 0 when it is not a length from a minute to 12 hours.
function parse(arg: string) {
  const m = /^(\d+(?:\.\d+)?)\s*([mh])$/.exec(arg)
  const ms = m ? Number(m[1]) * (m[2] === 'h' ? H : MIN) : 0
  return ms >= MIN && ms <= MAX_MS ? ms : 0
}

// The project this session belongs to: its git root (the main tree's, for a worktree), else its folder.
async function project($: EngineInterface) {
  try {
    return (await $.session.repo())?.root ?? (await $.session.root())
  } catch {
    return ''
  }
}

// A saved window counts only if it is a length the commands could have written; anything else (a hand-edited store) is ignored.
const valid = (v: unknown): v is number => typeof v === 'number' && v >= MIN && v <= MAX_MS

// Saved per-project auto windows, path -> ms. The paths live only in the local store and are never sent or shown in full.
async function projects($: EngineInterface): Promise<Record<string, number>> {
  const p = await $.store.get('projects')
  return p !== null && typeof p === 'object' && !Array.isArray(p) ? (p as Record<string, number>) : {}
}

const name = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() ?? path

// The window this session slides by right now (its own, else this project's, else the global auto), and whether auto gave it.
async function window_($: EngineInterface) {
  const w = (await $.state.get(win)).value ?? -1
  if (w >= 0) return { ms: w, isAuto: false }
  const here = (await projects($))[await project($)]
  if (valid(here)) return { ms: here, isAuto: true }
  const auto = await $.store.get('auto')
  const ms = valid(auto) ? auto : 0
  return { ms, isAuto: ms > 0 }
}

async function stop($: EngineInterface) {
  timer?.cancel()
  timer = undefined
  await $.state.set(until, 0)
  $.ui.status(undefined)
}

// The deadline passed with no prompt: leave the end time on the status line until the next real prompt.
async function finish($: EngineInterface, end: number) {
  // A prompt may have moved the deadline while we were getting here: then this run is not over.
  if (((await $.state.get(until)).value ?? 0) !== end) return
  const { ms } = await window_($)
  timer?.cancel()
  timer = undefined
  await $.state.set(until, 0)
  $.ui.status(`ended ${hhmm(end, end)}${ms > 0 ? ', type to restart' : ''}`)
  void $.ui.toast('keptwarm: stopped, no prompts for a while')
}

// One timer, set PING_MS after the last activity, or at the deadline if that comes first.
// Every await is done before the old timer is replaced, so two calls can never leave two timers.
async function schedule($: EngineInterface) {
  const end = (await $.state.get(until)).value ?? 0
  const now = await $.clock.now()
  const { isAuto } = await window_($)
  if (end === 0 || busy) return
  if (now >= end) {
    await finish($, end)
    return
  }
  timer?.cancel()
  $.ui.status(`warm until ${hhmm(end, now)}${isAuto ? ' (auto)' : ''}`)
  timer = $.clock.after(Math.min(PING_MS, end - now), async () => {
    // Read again: /keptwarm off or a new length may have landed while this timer waited.
    const now = await $.clock.now()
    const end = (await $.state.get(until)).value ?? 0 // read last: an off or a new length that landed earlier wins
    if (end === 0 || busy) return
    if (now >= end - 1000) {
      await finish($, end)
      return
    }
    if (!pingPending) {
      pingPending = true // a session that never goes idle queues one ping, not one per cycle
      $.prompt
        .submit({ text: PING })
        .then(r => {
          if (r.drop !== undefined) pingPending = false
        })
        .catch(() => {
          pingPending = false
          $.ui.status(`until ${hhmm(end, now)}, ping failed`)
          void $.ui.toast('keptwarm: ping failed, retrying in 50 min')
        })
    }
    await schedule($) // keeps the chain alive if the ping never completes a turn
  })
}

// A real prompt pushes the deadline out to now + window; the first one arms a session under auto.
async function slide($: EngineInterface) {
  const { ms } = await window_($)
  if (ms === 0) {
    // Nothing to slide by: a stale "ended" line has had its say, and a running deadline stays as it is.
    if (((await $.state.get(until)).value ?? 0) === 0) $.ui.status(undefined)
    return
  }
  await $.state.set(until, (await $.clock.now()) + ms)
  await schedule($)
}

// Whenever auto changes for this session (a command, a start, a /clear): stop the run if it is running but no window applies
// any more (and say so by returning true); otherwise show whether auto will start it on your next prompt. Other sessions
// cannot be reached from here and stay warm until their current stop time.
async function afterAutoChange($: EngineInterface) {
  const end = (await $.state.get(until)).value ?? 0
  const w = (await $.state.get(win)).value ?? -1
  const { ms } = await window_($) // a session's own window (/keptwarm 2h) counts, so a manual run is never stopped here
  if (end > (await $.clock.now())) {
    if (ms > 0) return false
    await stop($)
    return true
  }
  $.ui.status(w === -1 && ms > 0 ? 'auto on, starts when you type' : undefined)
  return false
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'keptwarm',
      description: 'Keep the prompt cache warm: /keptwarm, /keptwarm auto, /keptwarm off',
      argumentHint: '[2h | off | status | project [3h] | project off | auto [3h] | auto off]',
    })
    // A reload re-runs this: carry on if a run is still open.
    const end = (await $.state.get(until)).value ?? 0
    const now = await $.clock.now()
    if (end > now) {
      await schedule($)
      void $.ui.toast(`keptwarm: resumed, warm until ${hhmm(end, now)}`)
    } else {
      await afterAutoChange($).catch(() => {})
    }
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    if (REAL_ORIGINS.includes(e.origin?.kind) && !e.command && !e.isMeta) {
      await slide($).catch(() => {}) // never let the keepalive hold up a prompt
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  // A running turn keeps the cache warm itself: hold the timer until it completes.
  on('turn.start', ($, e, next) => {
    if (e.agentId === undefined) {
      busy = true
      pingPending = false
      timer?.cancel()
      timer = undefined
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      busy = false
      await schedule($).catch(() => {
        timer = undefined
        $.ui.status('error, run /keptwarm again')
        void $.ui.toast('keptwarm: stopped by an error')
      })
    }
    return next(e)
  })

  // /clear ends the conversation without a new session.start. It stops the run and drops this session's own
  // window, so auto applies to the new conversation again; "off" for this session stays off.
  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      await stop($)
      if (((await $.state.get(win)).value ?? -1) > 0) await $.state.set(win, -1)
      await afterAutoChange($).catch(() => {}) // /clear starts no session.start: show whether auto is on for the new conversation
    }
    return next(e)
  })

  on('command.run', { command: 'keptwarm' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    const usage = 'Usage: /keptwarm [2h], off, status, project [3h], project off, auto [3h], auto off. Lengths up to 12h.'
    const others = (stopped: boolean) => `${stopped ? 'This session stopped too; other' : 'Other'} sessions stay warm until their current stop time.`

    if (arg === 'help' || arg === '?') return { text: usage }

    if (arg === 'off') {
      await stop($)
      await $.state.set(win, 0)
      const auto = await $.store.get('auto')
      const autoOn = valid(auto) || Object.values(await projects($)).some(valid)
      return { text: `Off for this session.${autoOn ? ' Auto still applies to other sessions.' : ''}` }
    }

    if (arg === 'status') {
      const end = (await $.state.get(until)).value ?? 0
      const now = await $.clock.now()
      const w = (await $.state.get(win)).value ?? -1
      const { ms, isAuto } = await window_($)
      const session =
        w === 0
          ? 'off.'
          : end <= now
            ? ms > 0
              ? `idle; your next prompt starts it again (${dur(ms)}).`
              : 'not being kept warm.'
            : ms > 0
              ? `kept warm until ${hhmm(end, now)}, ${dur(ms)} after your last prompt${isAuto ? ' (auto)' : ''}.`
              : `kept warm until ${hhmm(end, now)} (your prompts will not extend it).`
      const all = await $.store.get('auto')
      const global = valid(all) ? all : 0
      const key = await project($)
      const here = (await projects($))[key]
      const hereMs = valid(here) ? here : 0
      const auto =
        global && hereMs
          ? `${dur(hereMs)} in this project, ${dur(global)} everywhere else.`
          : hereMs
            ? `${dur(hereMs)} in this project.`
            : global
              ? `${dur(global)} in every session.`
              : 'off.'
      const listed = Object.entries(await projects($))
        .filter(([, v]) => valid(v))
        .map(([path, v]) => `${name(path)} ${dur(v)}${path === key ? ' (this one)' : ''}`)
      return { text: `This session: ${session}\nAuto: ${auto}${listed.length ? `\nAuto projects: ${listed.join(', ')}.` : ''}` }
    }

    if (arg === 'auto off') {
      await $.store.delete('auto')
      const stopped = await afterAutoChange($)
      const listed = valid((await projects($))[await project($)])
      return { text: `Auto is off for all sessions. ${others(stopped)}${listed ? ' This project is still on the list: /keptwarm project off.' : ''}` }
    }

    if (arg === 'project off') {
      const key = await project($)
      const ps = await projects($)
      if (!(key in ps)) return { text: 'This project was not on the auto list.' }
      delete ps[key]
      await $.store.set('projects', ps)
      const stopped = await afterAutoChange($)
      return { text: `Auto is off for this project. ${others(stopped)}` }
    }

    if (arg === 'project' || arg.startsWith('project ')) {
      const ms = arg === 'project' ? AUTO_MS : parse(arg.slice(8).trim())
      if (ms === 0) return { text: usage }
      const key = await project($)
      if (key === '') return { text: 'Could not tell which project this is, so nothing was saved.' }
      const ps = await projects($)
      ps[key] = ms
      await $.store.set('projects', ps)
      await afterAutoChange($)
      return { text: `Auto is on for this project. Its sessions keep their cache warm for ${dur(ms)} after your last prompt in them; sessions you turned off stay off. Stop with /keptwarm project off.` }
    }

    if (arg === 'auto' || arg.startsWith('auto ')) {
      const ms = arg === 'auto' ? AUTO_MS : parse(arg.slice(5).trim())
      if (ms === 0) return { text: usage }
      await $.store.set('auto', ms)
      await afterAutoChange($)
      return { text: `Auto is on. Every session now keeps its cache warm for ${dur(ms)} after your last prompt in it; sessions you turned off stay off. Turn it off with /keptwarm auto off.` }
    }

    const ms = arg === '' ? MANUAL_MS : parse(arg)
    if (ms === 0) return { text: usage }
    await $.state.set(win, ms)
    await $.state.set(until, (await $.clock.now()) + ms)
    await schedule($)
    const now = await $.clock.now()
    return { text: `Keeping this session's cache warm for ${dur(ms)} after your last prompt (now until ${hhmm(now + ms, now)}). Stop with /keptwarm off.` }
  })
}
