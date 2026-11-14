import { expect, mock, test } from 'claude-code/testing'

const MIN = 60_000

// Boots the mod on a mock clock; returns what the engine saw and a runner for /keptwarm.
async function boot($: any, on: any) {
  const clock = mock.clock(on)
  const pings: string[] = []
  const toasts: string[] = []
  on('command.register', () => ({ value: { command: 'keptwarm' } }))
  on('session.start', (_: unknown, e: any) => ({ cwd: e.cwd }))
  on('prompt.submit', (_: unknown, e: any) => (pings.push(e.text), { text: e.text }))
  on('turn.complete', () => ({ text: 'x' }) as never)
  on('ui.status', () => ({ value: undefined }) as never)
  on('ui.toast', (_: unknown, e: any) => (toasts.push(JSON.stringify(e)), { value: undefined }) as never)

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const run = async (args: string) =>
    (await $.command.run({ command: 'keptwarm', args, origin: { kind: 'composer' } } as never)).text as string
  await run('off') // the module's timer outlives a test: start from a clean run
  toasts.length = 0
  return { clock, pings, toasts, run }
}

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

  await clock.advance(300 * MIN)
  expect(pings.length).toBeLessThanOrEqual(3) // never pings once the deadline is past
  expect(toasts.some(t => t.includes('finished'))).toBe(true)
})

test('a run shorter than 100 minutes still ends cleanly at its deadline', async ($, on) => {
  const { clock, pings, toasts, run } = await boot($, on)
  await run('30m')
  await clock.advance(29 * MIN)
  expect(toasts.length).toBe(0)
  await clock.advance(2 * MIN)
  expect(pings.length).toBe(0) // the cache from the command still covers 30 minutes
  expect(toasts.some(t => t.includes('finished'))).toBe(true)

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
  expect(await run('off')).toBe('keptwarm: off')
  await clock.advance(300 * MIN)
  expect(pings.length).toBe(0)
})

test('bad or out-of-range input is refused and starts nothing', async ($, on) => {
  const { clock, pings, run } = await boot($, on)
  for (const arg of ['banana', '0h', '0m', '0.0h', '0.5m', '-3h', '25h', '99999999999h']) {
    expect(await run(arg)).toContain('Usage')
  }
  await clock.advance(200 * MIN)
  expect(pings.length).toBe(0)
  expect(await run(' 2 H ')).toContain('on for')
  await run('off')
})

test('a second /keptwarm replaces the first run instead of adding a timer', async ($, on) => {
  const { clock, pings, run } = await boot($, on)
  await run('2h')
  await clock.advance(10 * MIN)
  await run('12h')
  await clock.advance(50 * MIN)
  expect(pings.length).toBe(1) // one timer, not two
  await run('off')
})

test('a reload resumes an open run', async ($, on) => {
  // What an earlier load stored: a deadline three hours out, with no timer in this module.
  on('state.get', () => ({ value: { value: 3 * 60 * MIN, version: 1 } }))
  const { clock, pings, toasts } = await boot($, on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  expect(toasts.some(t => t.includes('resumed'))).toBe(true)
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
  on('turn.start', (_: unknown, e: any) => ({ turnId: e.turnId }) as never)
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

test('/clear ends the run', async ($, on) => {
  on('session.end', (_: unknown, e: any) => ({ sessionId: e.sessionId }) as never)
  const { clock, pings, run } = await boot($, on)
  await run('6h')
  await $.session.end({ reason: 'clear', sessionId: 's1' } as never)
  await clock.advance(120 * MIN)
  expect(pings.length).toBe(0)
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
