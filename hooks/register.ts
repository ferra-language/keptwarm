import type { EngineInterface, Register } from 'claude-code'

// ponytail: fixed 50-min wait (1-hour cache TTL); a ping fires only after 50 idle minutes.
const PING_MS = 50 * 60_000
const PING = 'Cache keepalive from the keepwarm mod. Reply with just "ok" and do nothing else.'
const UNITS: Record<string, number> = { m: 60_000, h: 3_600_000 }
// The deadline lives in $.state so a hot reload resumes the run instead of dropping it.
const until = { plugin: 'keepwarm', key: 'until' } as const

let timer: { cancel(): void } | undefined

async function stop($: EngineInterface) {
  timer?.cancel()
  timer = undefined
  await $.state.set(until, 0)
  $.ui.status(undefined)
}

// One ping, PING_MS after the last activity. Each finished turn (the ping's own included) pushes it back.
async function schedule($: EngineInterface) {
  timer?.cancel()
  timer = undefined
  const end = (await $.state.get(until)).value ?? 0
  if ((await $.clock.now()) >= end) return
  $.ui.status(`keepwarm until ${new Date(end).toLocaleTimeString()}`)
  timer = $.clock.after(PING_MS, async () => {
    if ((await $.clock.now()) + PING_MS > end) {
      await stop($)
      void $.ui.toast('keepwarm: finished')
      return
    }
    void $.prompt.submit({ text: PING })
    await schedule($) // keeps the chain alive if the ping never completes a turn
  })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'keepwarm',
      description: 'Keep the prompt cache warm for 6h; /keepwarm off to stop',
      argumentHint: '[12h | 30m | off]',
    })
    // A reload re-runs this: carry on if a run is still open.
    if (((await $.state.get(until)).value ?? 0) > (await $.clock.now())) {
      await schedule($)
      void $.ui.toast('keepwarm: resumed after reload')
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined && timer) await schedule($)
    return next(e)
  })

  on('command.run', { command: 'keepwarm' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase() || '6h'

    if (arg === 'off') {
      await stop($)
      return { text: 'keepwarm: off' }
    }
    const m = /^(\d+(?:\.\d+)?)\s*([mh])$/.exec(arg)
    if (!m) return { text: 'Usage: /keepwarm (6h default) | /keepwarm 12h | /keepwarm off' }

    await $.state.set(until, (await $.clock.now()) + Number(m[1]) * UNITS[m[2]])
    await schedule($)
    return { text: `keepwarm: on for ${arg}, pings after 50 idle minutes. /keepwarm off to stop.` }
  })
}
