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
  timer?.cancel()
  timer = undefined
  await $.state.set(until, 0)
  $.ui.status(`keptwarm: ended ${hhmm(end, end)}`)
  void $.ui.toast('keptwarm: ended, session went idle')
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
  $.ui.status(`keptwarm: warm until ${hhmm(end, now)}${isAuto ? ' (auto)' : ''}`)
  timer = $.clock.after(Math.min(PING_MS, end - now), async () => {
    // Read again: /keptwarm off or a new length may have landed while this timer waited.
    const end = (await $.state.get(until)).value ?? 0
    const now = await $.clock.now()
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
          $.ui.status(`keptwarm: until ${hhmm(end, now)}, ping failed`)
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

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'keptwarm',
      description: 'Keep the prompt cache warm: /keptwarm, /keptwarm auto, /keptwarm off',
      argumentHint: '[2h | off | status | auto [3h] | auto off]',
    })
    // A reload re-runs this: carry on if a run is still open.
    const end = (await $.state.get(until)).value ?? 0
    const now = await $.clock.now()
    if (end > now) {
      await schedule($)
      void $.ui.toast(`keptwarm: resumed, warm until ${hhmm(end, now)}`)
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
        $.ui.status('keptwarm: stopped, run /keptwarm')
        void $.ui.toast('keptwarm: could not re-arm')
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
    }
    return next(e)
  })

  on('command.run', { command: 'keptwarm' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    const usage = 'Usage: /keptwarm [2h | 30m] | off | status | auto [3h] | auto here [3h] | auto drop | auto list | auto off. Up to 12h.'

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
            ? 'not warm.'
            : ms > 0
              ? `warm until ${hhmm(end, now)}, ${dur(ms)} after your last prompt${isAuto ? ' (auto)' : ''}.`
              : `warm until ${hhmm(end, now)}, not extended by prompts.`
      const all = await $.store.get('auto')
      const global = valid(all) ? all : 0
      const here = (await projects($))[await project($)]
      const hereMs = valid(here) ? here : 0
      const auto =
        global && hereMs
          ? `on, ${dur(hereMs)}, this project; ${dur(global)}, all sessions.`
          : hereMs
            ? `on, ${dur(hereMs)}, this project.`
            : global
              ? `on, ${dur(global)}, all sessions.`
              : 'off.'
      return { text: `This session: ${session}\nAuto: ${auto}` }
    }

    if (arg === 'auto off') {
      await $.store.delete('auto')
      const listed = valid((await projects($))[await project($)])
      return { text: `Auto off for all sessions. Sessions already warm run to their end.${listed ? ' This project is still on the list: /keptwarm auto drop.' : ''}` }
    }

    if (arg === 'auto drop') {
      const key = await project($)
      const ps = await projects($)
      if (!(key in ps)) return { text: 'This project was not on the auto list.' }
      delete ps[key]
      await $.store.set('projects', ps)
      return { text: 'Auto dropped for this project. Sessions already warm run to their end.' }
    }

    if (arg === 'auto list') {
      const all = await $.store.get('auto')
      const key = await project($)
      const items = Object.entries(await projects($)).filter(([, ms]) => valid(ms)).map(([path, ms]) => `${name(path)} ${dur(ms)}${path === key ? ' (this one)' : ''}`)
      return { text: `Auto, all sessions: ${valid(all) ? dur(all) : 'off'}.\nAuto, projects: ${items.length ? items.join(', ') : 'none'}.` }
    }

    if (arg === 'auto here' || arg.startsWith('auto here ')) {
      const ms = arg === 'auto here' ? AUTO_MS : parse(arg.slice(10).trim())
      if (ms === 0) return { text: usage }
      const key = await project($)
      if (key === '') return { text: 'Could not tell which project this is, so nothing was saved.' }
      const ps = await projects($)
      ps[key] = ms
      await $.store.set('projects', ps)
      return { text: `Auto on for this project: its sessions stay warm ${dur(ms)} after their last prompt. Each idle session pings about hourly. /keptwarm auto drop to stop.` }
    }

    if (arg === 'auto' || arg.startsWith('auto ')) {
      const ms = arg === 'auto' ? AUTO_MS : parse(arg.slice(5).trim())
      if (ms === 0) return { text: usage }
      await $.store.set('auto', ms)
      return { text: `Auto on: every session you have not turned off stays warm ${dur(ms)} after its last prompt. Each idle session pings about hourly. /keptwarm auto off to stop.` }
    }

    const ms = arg === '' ? MANUAL_MS : parse(arg)
    if (ms === 0) return { text: usage }
    await $.state.set(win, ms)
    await $.state.set(until, (await $.clock.now()) + ms)
    await schedule($)
    const now = await $.clock.now()
    return { text: `Warm until ${hhmm(now + ms, now)}, ${dur(ms)} after each prompt. /keptwarm off to stop.` }
  })
}
