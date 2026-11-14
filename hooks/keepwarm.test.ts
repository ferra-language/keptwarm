import { expect, mock, test } from 'claude-code/testing'

const MIN = 60_000

test('pings after 50 idle minutes, skips when active, stops at the deadline', async ($, on) => {
  const clock = mock.clock(on)
  const pings: string[] = []
  on('command.register', () => ({ value: { command: 'keepwarm' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('prompt.submit', (_, e) => (pings.push(e.text), { text: e.text }))
  on('turn.complete', () => ({ text: 'x' }) as never)
  on('ui.status', () => ({ value: undefined }) as never)
  on('ui.toast', () => ({ value: undefined }) as never)

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'keepwarm', args: '3h', origin: { kind: 'composer' } } as never)

  await clock.advance(49 * MIN)
  expect(pings.length).toBe(0)

  // A finished turn at minute 49 pushes the ping to minute 99.
  await $.turn.complete({ agentId: undefined, reason: 'answer', answer: 'x' } as never)
  await clock.advance(49 * MIN)
  expect(pings.length).toBe(0)
  await clock.advance(1 * MIN)
  expect(pings.length).toBe(1)

  // Idle from here: pings at 50-minute steps until the 3h deadline.
  await clock.advance(50 * MIN)
  await clock.advance(50 * MIN)
  const before = pings.length
  await clock.advance(200 * MIN)
  expect(pings.length).toBe(before) // past the deadline: no more pings
})
