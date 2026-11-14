import { expect, mock, test } from 'claude-code/testing'

const MIN = 60_000
const H = 60 * MIN

// One main-thread turn, start to finish.
const turn = async ($: any) => {
  await $.turn.start({ text: 'ping', turnId: 't', agentId: undefined } as never)
  await $.turn.complete({ agentId: undefined, reason: 'answer', answer: 'ok' } as never)
}

// Boots the mod on a mock clock and store; returns what the engine saw and runners for the user's actions.
async function boot($: any, on: any, store: Record<string, unknown> = {}, opts: { now?: number; ping?: 'fail' | 'drop'; project?: { current: string; repo?: string | null; root?: string } } = {}) {
  const clock = mock.clock(on, { now: opts.now })
  mock.store(on, store)
  const pings: string[] = []
  const statuses: string[] = []
  const toasts: string[] = []
  on('command.register', () => ({ value: { command: 'keptwarm' } }))
  on('session.start', (_: unknown, e: any) => ({ cwd: e.cwd }))
  on('prompt.submit', (_: unknown, e: any) => {
    if (!e.text.includes('keepalive')) return { text: e.text }
    pings.push(e.text)
    if (opts.ping === 'fail') throw new Error('refused')
    return opts.ping === 'drop' ? ({ drop: 'blocked' } as never) : { text: e.text }
  })
  on('turn.complete', () => ({ text: 'x' }) as never)
  on('turn.start', (_: unknown, e: any) => ({ turnId: e.turnId }) as never)
  on('session.end', (_: unknown, e: any) => ({ sessionId: e.sessionId }) as never)
  on('ui.status', (_: unknown, e: any) => (statuses.push(JSON.stringify(e)), { value: undefined }) as never)
  on('ui.toast', (_: unknown, e: any) => (toasts.push(JSON.stringify(e)), { value: undefined }) as never)

  if (opts.project) {
    const proj = opts.project
    // `current` is the git root; `repo: null` means no repository; `root` is the session's own folder (a worktree's).
    on('session.repo', () => ({ value: proj.repo === null ? null : { root: proj.repo ?? proj.current, remote: null, internal: false, name: null } }) as never)
    on('session.root', () => ({ value: proj.root ?? proj.current }) as never)
  }
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const run = async (args: string) =>
    (await $.command.run({ command: 'keptwarm', args, origin: { kind: 'composer' } } as never)).text as string
  // A prompt as the engine raises it: typed by the person unless the origin or flags say otherwise.
  const prompt = (extra: Record<string, unknown> = {}) =>
    $.prompt.submit({ text: 'hello', origin: { kind: 'composer' }, ...extra } as never)
  await turn($) // the module's variables outlive a test: start with no turn running and no ping pending
  statuses.length = 0
  toasts.length = 0
  return { clock, pings, statuses, toasts, run, prompt }
}

const last = (a: string[]) => a[a.length - 1] ?? ''

test('pings after 50 idle minutes, a finished turn pushes it back, the deadline stops it', async ($, on) => {
  const { clock, pings, toasts, run } = await boot($, on)
  await run('3h')

  await clock.advance(49 * MIN)
  expect(pings.length).toBe(0)

  await $.turn.complete({ agentId: undefined, reason: 'answer', answer: 'x' } as never)
  await clock.advance(49 * MIN) // minute 98: 49 idle minutes since the turn
  expect(pings.length).toBe(0)
  await clock.advance(1 * MIN) // minute 99: 50 idle
  expect(pings.length).toBe(1)
  await turn($) // the ping's own turn: its end re-arms the timer

  await clock.advance(50 * MIN) // minute 149
  expect(pings.length).toBe(2)
  await turn($)

  await clock.advance(300 * MIN)
  expect(pings.length).toBe(2) // the deadline (minute 180) is past: no third ping
  expect(toasts.some(t => t.includes('keptwarm: ended, session went idle'))).toBe(true)
})

test('a run shorter than 100 minutes still ends cleanly at its deadline', async ($, on) => {
  const { clock, pings, toasts, run } = await boot($, on)
  await run('30m')
  await clock.advance(29 * MIN)
  expect(toasts.length).toBe(0)
  await clock.advance(2 * MIN)
  expect(pings.length).toBe(0) // the cache from the command still covers 30 minutes
  expect(toasts.some(t => t.includes('ended'))).toBe(true)

  await run('90m')
  await clock.advance(51 * MIN)
  expect(pings.length).toBe(1) // minute 50 ping covers the cache to minute 110, past the 90 deadline
  await clock.advance(41 * MIN)
  expect(pings.length).toBe(1)
})

test('off stops it, and a stale timer cannot ping after', async ($, on) => {
  const { clock, pings, run } = await boot($, on)
  await run('6h')
  await clock.advance(40 * MIN)
  expect(await run('off')).toBe('Off for this session.')
  await clock.advance(300 * MIN)
  expect(pings.length).toBe(0)
})

test('bad or out-of-range input is refused and starts nothing', async ($, on) => {
  const { clock, pings, run } = await boot($, on)
  for (const arg of ['banana', '0h', '0m', '0.0h', '0.5m', '-3h', '13h', '99999999999h', 'auto 13h', 'auto banana']) {
    expect(await run(arg)).toContain('Usage')
  }
  await clock.advance(200 * MIN)
  expect(pings.length).toBe(0)
  expect(await run(' 2 H ')).toContain('Warm until')
  expect(await run('1m')).toContain('Warm until') // a minute is the shortest
  await run('off')
})

test('a second /keptwarm replaces the first run instead of adding a timer', async ($, on) => {
  const { clock, pings, run } = await boot($, on)
  await run('2h')
  await clock.advance(10 * MIN)
  expect(await run('12h')).toContain('Warm until') // 12h is the longest accepted length
  await clock.advance(50 * MIN)
  expect(pings.length).toBe(1) // one timer, not two
  await run('off')
})

test('a reload resumes an open run', async ($, on) => {
  // What an earlier load stored: a deadline three hours out, with no timer in this module.
  on('state.get', (_: unknown, e: any) => ({ value: { value: e.key === 'until' ? 3 * H : undefined, version: 1 } }))
  const { clock, pings, toasts } = await boot($, on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  expect(toasts.some(t => t.includes('resumed, warm until'))).toBe(true)
  await clock.advance(51 * MIN)
  expect(pings.length).toBe(1)
})

test('off stays off: a later finished turn does not re-arm the pings', async ($, on) => {
  const { clock, pings, run } = await boot($, on)
  await run('6h')
  await run('off')
  await $.turn.complete({ agentId: undefined, reason: 'answer', answer: 'x' } as never)
  await clock.advance(120 * MIN)
  expect(pings.length).toBe(0)
})

test('a running turn holds the ping until it completes', async ($, on) => {
  const { clock, pings, run } = await boot($, on)
  await run('6h')
  await clock.advance(40 * MIN)
  await $.turn.start({ text: 'long job', turnId: 't1', agentId: undefined } as never)
  await clock.advance(30 * MIN) // minute 70: the turn is still running
  expect(pings.length).toBe(0)
  await $.turn.complete({ agentId: undefined, reason: 'answer', answer: 'x' } as never)
  await clock.advance(49 * MIN)
  expect(pings.length).toBe(0)
  await clock.advance(1 * MIN)
  expect(pings.length).toBe(1)
  await run('off')
})

test('/clear stops the run and returns the session to the auto setting', async ($, on) => {
  const { clock, pings, run, prompt } = await boot($, on)
  await run('6h')
  await $.session.end({ reason: 'clear', sessionId: 's1' } as never)
  await clock.advance(120 * MIN)
  expect(pings.length).toBe(0)
  await prompt() // the session's own 6h window was dropped, and auto is off: a prompt arms nothing
  await clock.advance(120 * MIN)
  expect(pings.length).toBe(0)
})

test('a ping is not stacked while the previous one is still queued', async ($, on) => {
  const { clock, pings, run } = await boot($, on)
  await run('6h')
  await clock.advance(50 * MIN)
  expect(pings.length).toBe(1)
  await clock.advance(150 * MIN) // the session never went idle: no turn started for the ping
  expect(pings.length).toBe(1)
  await run('off')
})

test('a turn that starts while the timer is being re-armed wins the race', async ($, on) => {
  const { clock, pings, run } = await boot($, on)
  await run('6h')
  const first = $.turn.complete({ agentId: undefined, reason: 'answer', answer: 'x' } as never)
  await $.turn.start({ text: 'queued prompt', turnId: 'b', agentId: undefined } as never)
  await first
  await clock.advance(120 * MIN) // turn b is still running: no ping may fire inside it
  expect(pings.length).toBe(0)
  await $.turn.complete({ agentId: undefined, reason: 'aborted', answer: '' } as never) // aborted turns re-arm too
  await clock.advance(51 * MIN)
  expect(pings.length).toBe(1)
  await run('off')
})

test('a subagent turn does not move the ping', async ($, on) => {
  const { clock, pings, run } = await boot($, on)
  await run('3h')
  await clock.advance(40 * MIN)
  await $.turn.complete({ agentId: 'sub-1', reason: 'answer', answer: 'x' } as never)
  await clock.advance(11 * MIN)
  expect(pings.length).toBe(1) // still pinged at minute 50 from the command
  await run('off')
})

// ---- sliding window ----

test('an idle 6h window gives exactly 7 pings', async ($, on) => {
  const { clock, pings, run } = await boot($, on)
  await run('6h')
  for (let i = 0; i < 12; i++) {
    await clock.advance(50 * MIN)
    await turn($) // each ping's own turn
  }
  expect(pings.length).toBe(7) // minutes 50, 100, 150, 200, 250, 300 and 350, then stopped at 360
})

test('a prompt at minute 299 moves the stop to minute 659', async ($, on) => {
  const { clock, run, prompt, toasts } = await boot($, on)
  await run('6h')
  await clock.advance(299 * MIN)
  await prompt()
  await turn($)
  await clock.advance(5 * H + 50 * MIN) // minute 649: still inside the moved window
  expect(toasts.some(t => t.includes('ended'))).toBe(false)
  await clock.advance(20 * MIN) // minute 669: past 659
  expect(toasts.some(t => t.includes('ended'))).toBe(true)
})

test('only a typed prompt counts as activity', async ($, on) => {
  const { clock, toasts, run, prompt } = await boot($, on)
  await run('30m')
  await clock.advance(20 * MIN)
  // None of these may extend the 30-minute window.
  for (const extra of [
    { origin: { kind: 'plugin', name: 'keptwarm' } },
    { origin: { kind: 'sdk' } },
    { origin: { kind: 'task-notification' } },
    { origin: { kind: 'scheduled-trigger' } },
    { origin: { kind: 'auto-continuation' } },
    { command: { name: 'keptwarm' } },
    { isMeta: true },
  ]) {
    await prompt(extra)
  }
  await clock.advance(15 * MIN) // minute 35: the original deadline passed
  expect(toasts.some(t => t.includes('ended'))).toBe(true)
})

test('off sticks for the session even when auto is on and a prompt comes', async ($, on) => {
  const { clock, pings, run, prompt } = await boot($, on, { auto: 3 * H })
  await run('off')
  await prompt()
  await clock.advance(5 * H)
  expect(pings.length).toBe(0)
})

// ---- auto ----

test('auto arms a session on its first real prompt, not before', async ($, on) => {
  const { clock, pings, statuses, run, prompt } = await boot($, on)
  expect(await run('auto')).toContain('Auto on: every session you have not turned off stays warm 3h')
  await clock.advance(5 * H)
  expect(pings.length).toBe(0) // an unused session never pings
  expect(statuses.length).toBe(0)
  await prompt()
  await turn($)
  expect(last(statuses)).toMatch(/keptwarm: warm until (\w{3} )?\d\d:\d\d \(auto\)/)
  await clock.advance(51 * MIN)
  expect(pings.length).toBe(1)
})

test('a session-level length beats auto, and auto off stops new arming', async ($, on) => {
  const { clock, pings, run, prompt, toasts } = await boot($, on, { auto: 3 * H })
  await run('30m')
  await prompt()
  await clock.advance(31 * MIN)
  expect(toasts.some(t => t.includes('session went idle'))).toBe(true) // 30m, not the 3h auto window

  await $.session.end({ reason: 'clear', sessionId: 's2' } as never) // a new conversation: back to following auto
  expect(await run('auto off')).toContain('Auto off')
  await prompt()
  await clock.advance(3 * H)
  expect(pings.length).toBe(0)
})

test('a v0.3 deadline with no window keeps running as a fixed run', async ($, on) => {
  on('state.get', (_: unknown, e: any) => ({ value: { value: e.key === 'until' ? 3 * H : undefined, version: 1 } }))
  const { clock, pings, statuses, prompt } = await boot($, on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true }) // a reload
  await prompt() // no window, no auto: the old deadline is not moved
  expect(statuses.length).toBeGreaterThan(0)
  expect(last(statuses)).not.toContain('(auto)') // auto is off, so this is not an auto run
  await clock.advance(51 * MIN)
  expect(pings.length).toBe(1)
})

test('typed prompts from the composer, the bridge and Slack all extend the window', async ($, on) => {
  const { clock, toasts, run, prompt } = await boot($, on)
  await run('30m')
  // Each typed prompt pushes the stop out by 30 minutes from its own moment; none may let the run end.
  for (const kind of ['composer', 'bridge', 'slack-ping']) {
    await clock.advance(20 * MIN)
    await prompt({ origin: { kind } })
    expect(toasts.some(t => t.includes('ended'))).toBe(false)
  }
  await clock.advance(25 * MIN) // 85 minutes in: past the first 30-minute deadline and every unmoved one
  expect(toasts.some(t => t.includes('ended'))).toBe(false)
  await run('off')
})

test('a session.end that is not /clear leaves the run alone', async ($, on) => {
  const { clock, pings, run } = await boot($, on)
  await run('6h')
  await $.session.end({ reason: 'other', sessionId: 's1' } as never)
  await clock.advance(51 * MIN)
  expect(pings.length).toBe(1)
  await run('off')
})

test('a dropped ping does not block the next one', async ($, on) => {
  const { clock, pings, run } = await boot($, on, {}, { ping: 'drop' })
  await run('6h')
  await clock.advance(50 * MIN)
  expect(pings.length).toBe(1)
  await clock.advance(50 * MIN) // no turn ever started for the first: the drop must have cleared the pending mark
  expect(pings.length).toBe(2)
  await run('off')
})

test('a refused ping shows a failure toast and the run carries on', async ($, on) => {
  const { clock, pings, toasts, statuses, run } = await boot($, on, {}, { ping: 'fail' })
  await run('6h')
  await clock.advance(50 * MIN)
  expect(pings.length).toBe(1)
  expect(toasts.some(t => t.includes('keptwarm: ping failed, retrying in 50 min'))).toBe(true)
  expect(statuses.some(t => t.includes('ping failed'))).toBe(true)
  await clock.advance(50 * MIN)
  expect(pings.length).toBe(2) // retried
  await run('off')
})

test('the weekday shows when the stop time is on another day', async ($, on) => {
  const local = (d: number, h: number) => new Date(2026, 0, d, h, 0).getTime() // Monday 5 Jan 2026, local time
  const { run } = await boot($, on, {}, { now: local(5, 23) })
  expect(await run('2h')).toMatch(/^Warm until Tue 01:00, 2h after each prompt\./)
  expect(await run('90m')).toMatch(/^Warm until Tue 00:30, 1\.5h after each prompt\./) // 1.5h, not rounded to 2h
  await run('off')
})

test('a stale ended line is cleared by the next prompt when nothing is left to slide', async ($, on) => {
  const { clock, statuses, run, prompt } = await boot($, on, { auto: 1 * H })
  await prompt()
  await run('auto off') // the window is now 0 for a session that follows auto
  await clock.advance(61 * MIN)
  expect(last(statuses)).toMatch(/"keptwarm: ended \d\d:\d\d"/)
  await prompt()
  expect(last(statuses)).not.toContain('ended') // cleared, not left up for good
})

test('status never claims a 0m window or an auto tag that is not true', async ($, on) => {
  const { run, prompt } = await boot($, on, { auto: 1 * H })
  await prompt()
  await run('auto off')
  const text = await run('status')
  expect(text).toContain('not extended by prompts')
  expect(text).not.toContain('0m')
  expect(text).not.toContain('(auto)')
})

test('a v0.3 deadline is never moved by a prompt, and a prompt at the deadline does not lose its new stop time', async ($, on) => {
  const store: Record<string, number> = { until: 3 * H }
  on('state.get', (_: unknown, e: any) => ({ value: { value: store[e.key], version: 1 } }))
  on('state.set', (_: unknown, e: any) => ((store[e.key] = e.value), { value: { isSet: true, version: 2 } }) as never)
  const { clock, prompt } = await boot($, on)
  store.until = 3 * H // boot's setup may have written; the run is a v0.3 one
  delete store.win
  await prompt() // no window and no auto: nothing to slide by
  expect(store.until).toBe(3 * H)
  void clock
})

test('a deadline moved while the run is ending is not ended', async ($, on) => {
  const store: Record<string, number> = {}
  let trap = false
  on('state.get', (_: unknown, e: any) => {
    const v = store[e.key]
    if (trap && e.key === 'until' && v !== undefined) {
      trap = false
      store.until = v + H // a prompt slides the deadline just after the timer read it
    }
    return { value: { value: v, version: 1 } }
  })
  on('state.set', (_: unknown, e: any) => ((store[e.key] = e.value), { value: { isSet: true, version: 2 } }) as never)
  const { clock, toasts, run } = await boot($, on)
  await run('30m')
  const deadline = store.until as number
  trap = true
  await clock.advance(31 * MIN)
  expect(toasts.some(t => t.includes('ended'))).toBe(false)
  expect(store.until).toBe(deadline + H)
})

// ---- per project (fake paths only) ----

test('auto here arms only sessions in that project', async ($, on) => {
  const where = { current: '/work/alpha' }
  const { clock, pings, run, prompt } = await boot($, on, {}, { project: where })
  expect(await run('auto here')).toContain('Auto on for this project: its sessions stay warm 3h')

  where.current = '/work/beta' // another project's session
  await $.session.end({ reason: 'other', sessionId: 'b' } as never) // the project is read again
  await prompt()
  await clock.advance(5 * H)
  expect(pings.length).toBe(0)

  where.current = '/work/alpha'
  await $.session.end({ reason: 'other', sessionId: 'a' } as never)
  await prompt()
  await turn($)
  await clock.advance(51 * MIN)
  expect(pings.length).toBe(1)
  await run('off')
})

test('a project window beats the global auto, and auto drop removes it', async ($, on) => {
  const where = { current: '/work/alpha' }
  const { clock, pings, toasts, run, prompt } = await boot($, on, { auto: 3 * H }, { project: where })
  await run('auto here 30m')
  await prompt()
  await clock.advance(31 * MIN)
  expect(toasts.some(t => t.includes('ended'))).toBe(true) // 30m from the project, not the 3h global

  expect(await run('auto drop')).toContain('Auto dropped for this project')
  expect(await run('auto drop')).toBe('This project was not on the auto list.')
  await run('auto off') // and the global one
  await prompt()
  await clock.advance(5 * H)
  expect(pings.length).toBe(0)
})

test('status and list name projects by folder, never by full path', async ($, on) => {
  const where = { current: '/work/alpha' }
  const { run } = await boot($, on, { auto: 3 * H, projects: { '/work/alpha': 2 * H, '/work/beta': 1 * H } }, { project: where })
  expect(await run('status')).toBe('This session: not warm.\nAuto: on, 2h, this project; 3h, all sessions.')
  const list = await run('auto list')
  expect(list).toBe('Auto, all sessions: 3h.\nAuto, projects: alpha 2h (this one), beta 1h.')
  expect(list).not.toContain('/work')
  await run('auto here')
  await run('auto off')
  expect(await run('status')).toContain('Auto: on, 3h, this project.')
  expect(await run('auto off')).toContain('This project is still on the list: /keptwarm auto drop.')
  expect(await run('off')).toContain('Auto still applies to other sessions.') // projects count as auto too
})

test('per-project input is checked, and a session that cannot name its project saves nothing', async ($, on) => {
  const where = { current: '/work/alpha' }
  const { run } = await boot($, on, {}, { project: where })
  for (const arg of ['auto here 13h', 'auto here banana', 'auto here 0m']) expect(await run(arg)).toContain('Usage')
  expect(await run('auto list')).toBe('Auto, all sessions: off.\nAuto, projects: none.')
  where.current = '' // the engine could not tell
  await $.session.end({ reason: 'other', sessionId: 'x' } as never)
  expect(await run('auto here')).toBe('Could not tell which project this is, so nothing was saved.')
  expect(await run('auto list')).toBe('Auto, all sessions: off.\nAuto, projects: none.')
})

test('the project is the repository root, else the folder, and follows a /cd at once', async ($, on) => {
  const where: { current: string; repo?: string | null; root?: string } = { current: '/work/main', root: '/work/main-wt' }
  const { run } = await boot($, on, {}, { project: where })
  await run('auto here')
  expect(await run('auto list')).toContain('Auto, projects: main 3h (this one).') // a worktree maps to the main tree's root

  where.repo = null // not in a repository: the session's own folder is the project
  where.root = '/work/plain'
  await run('auto here 1h')
  expect(await run('auto list')).toBe('Auto, all sessions: off.\nAuto, projects: main 3h, plain 1h (this one).')

  where.root = '/work/elsewhere' // a /cd with no session.end: no stale project
  expect(await run('auto list')).not.toContain('(this one)')
})

test('auto here and auto drop leave every other project alone', async ($, on) => {
  const where = { current: '/work/alpha' }
  const { run } = await boot($, on, {}, { project: where })
  await run('auto here')
  where.current = '/work/beta'
  await run('auto here 2h')
  expect(await run('auto list')).toContain('Auto, projects: alpha 3h, beta 2h (this one).')
  await run('auto drop')
  expect(await run('auto list')).toContain('Auto, projects: alpha 3h.')
})

test('a hand-edited store cannot break it or get past the 12h cap', async ($, on) => {
  const where = { current: '/work/alpha' }
  const store = { projects: { '/work/alpha': '7200000', '/work/beta': 1e300, '/work/gamma': -5, '/work/delta': 0 }, auto: 'soon' }
  const { clock, pings, run, prompt } = await boot($, on, store, { project: where })
  expect(await run('status')).toBe('This session: not warm.\nAuto: off.')
  expect(await run('auto list')).toBe('Auto, all sessions: off.\nAuto, projects: none.')
  await prompt()
  await clock.advance(5 * H)
  expect(pings.length).toBe(0) // a number written as a string is not a usable window
  where.current = '/work/beta' // and 1e300 is past the 12h cap
  await prompt()
  await clock.advance(5 * H)
  expect(pings.length).toBe(0)
  expect(await run('off')).toBe('Off for this session.')
})

// ---- what the user sees ----

test('status lines and replies read as designed', async ($, on) => {
  const { statuses, toasts, run, clock, prompt } = await boot($, on, { auto: 3 * H })

  expect(await run('status')).toBe('This session: not warm.\nAuto: on, 3h, all sessions.')
  await prompt()
  expect(last(statuses)).toMatch(/"keptwarm: warm until (\w{3} )?\d\d:\d\d \(auto\)"/)
  expect(await run('status')).toMatch(/^This session: warm until \d\d:\d\d, 3h after your last prompt \(auto\)\.\nAuto: on, 3h, all sessions\.$/)

  expect(await run('2h')).toMatch(/^Warm until \d\d:\d\d, 2h after each prompt\. \/keptwarm off to stop\.$/)
  expect(last(statuses)).not.toContain('(auto)')

  expect(await run('off')).toBe('Off for this session. Auto still applies to other sessions.')
  expect(await run('status')).toMatch(/^This session: off\./)
  expect(await run('auto off')).toBe('Auto off for all sessions. Sessions already warm run to their end.')
  expect(await run('auto 5h')).toContain('stays warm 5h after its last prompt')
  expect(await run('status')).toContain('Auto: on, 5h, all sessions.')
  await run('auto off')
  await run('2h')
  await clock.advance(121 * MIN)
  expect(last(statuses)).toMatch(/"keptwarm: ended \d\d:\d\d"/) // the end time stays up until the next real prompt
  expect(toasts.some(t => t.includes('keptwarm: ended, session went idle'))).toBe(true)
})

test('every status line and toast is plain ASCII and fits 42 characters', async ($, on) => {
  const { statuses, toasts, run, clock, prompt } = await boot($, on, { auto: 3 * H })
  await prompt()
  await run('30m')
  await clock.advance(31 * MIN)
  await run('1h')
  await $.turn.start({ text: 'x', turnId: 'q', agentId: undefined } as never)
  await $.turn.complete({ agentId: undefined, reason: 'answer', answer: 'ok' } as never)
  await run('off')
  let checked = 0
  for (const line of [...statuses, ...toasts]) {
    const text = (line.match(/"(keptwarm:[^"]*)"/) ?? [])[1]
    if (text === undefined) continue
    checked++
    expect(text.length).toBeLessThanOrEqual(42)
    expect(/^[\x20-\x7e]*$/.test(text)).toBe(true)
  }
  expect(checked).toBeGreaterThan(3)
})
