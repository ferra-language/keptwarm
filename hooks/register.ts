import type { EngineInterface, Register } from 'claude-code'

// ponytail: fixed 50-min wait (1-hour cache TTL); a ping fires only after 50 idle minutes.
const PING_MS = 50 * 60_000
// A ping re-reads the cache at about a tenth of the rebuild price, so past roughly 17 idle hours it costs more than it saves.
const MAX_MS = 12 * 3_600_000
const PING = 'Cache keepalive from the keptwarm mod. Reply with just "ok" and do nothing else.'
const UNITS: Record<string, number> = { m: 60_000, h: 3_600_000 }
// The deadline lives in $.state so a hot reload resumes the run instead of dropping it.
const until = { plugin: 'keptwarm', key: 'until' } as const

let timer: { cancel(): void } | undefined
let busy = false // a main-thread turn is running: it keeps the cache warm, and its end re-arms the timer
let pingPending = false // a ping was submitted and no turn has started for it yet

async function stop($: EngineInterface) {
  timer?.cancel()
  timer = undefined
  await $.state.set(until, 0)
  $.ui.status(undefined)
}

// One timer, set PING_MS after the last activity, or at the deadline if that comes first.
// Every await is done before the old timer is replaced, so two calls can never leave two timers.
async function schedule($: EngineInterface) {
  const end = (await $.state.get(until)).value ?? 0
  const now = await $.clock.now()
  if (end === 0 || busy) return
  if (now >= end) {
    await stop($)
    void $.ui.toast('keptwarm: finished')
    return
  }
  timer?.cancel()
  $.ui.status(`keptwarm until ${new Date(end).toLocaleString()}`)
  timer = $.clock.after(Math.min(PING_MS, end - now), async () => {
    // Read again: /keptwarm off or a new length may have landed while this timer waited.
    const end = (await $.state.get(until)).value ?? 0
    const now = await $.clock.now()
    if (end === 0 || busy) return
    if (now >= end - 1000) {
      await stop($)
      void $.ui.toast('keptwarm: finished')
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
          void $.ui.toast('keptwarm: ping failed')
        })
    }
    await schedule($) // keeps the chain alive if the ping never completes a turn
  })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'keptwarm',
      description: 'Keep the prompt cache warm for 6h; /keptwarm off to stop',
      argumentHint: '[6h | 12h | 30m | off]',
    })
    // A reload re-runs this: carry on if a run is still open.
    if (((await $.state.get(until)).value ?? 0) > (await $.clock.now())) {
      await schedule($)
      void $.ui.toast('keptwarm: resumed after reload')
    }
    return next(e)
  })

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
        $.ui.status(undefined)
        void $.ui.toast('keptwarm: could not re-arm, run /keptwarm again')
      })
    }
    return next(e)
  })

  // /clear ends the conversation without a new session.start: a warm cache for it is worthless.
  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') await stop($)
    return next(e)
  })

  on('command.run', { command: 'keptwarm' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase() || '6h'

    if (arg === 'off') {
      await stop($)
      return { text: 'off' }
    }
    const m = /^(\d+(?:\.\d+)?)\s*([mh])$/.exec(arg)
    const ms = m ? Number(m[1]) * UNITS[m[2]] : 0
    if (!(ms >= UNITS.m && ms <= MAX_MS)) {
      return { text: 'Usage: /keptwarm (6h default) | /keptwarm 12h | /keptwarm 30m | /keptwarm off. Up to 12h.' }
    }

    await $.state.set(until, (await $.clock.now()) + ms)
    await schedule($)
    return { text: `on for ${arg}, pings after 50 idle minutes. /keptwarm off to stop.` }
  })
}
