# keptwarm

A Claude Code mod that keeps your session's prompt cache warm. With the 1-hour cache, a session that sits idle goes cold and has to pay to rebuild its whole context when you come back. `/keptwarm` sends one tiny ping after 50 idle minutes so that does not happen.

## Install

```
claude plugin marketplace add ferra-language/keptwarm
claude plugin install keptwarm@keptwarm --scope user
```

The user scope makes `/keptwarm` available in every project. Restart a session, or run `/reload-plugins`, to pick it up.

## Use

- `/keptwarm` runs for 6 hours.
- `/keptwarm 12h` or `/keptwarm 30m` sets another length, from a minute up to 24 hours.
- `/keptwarm off` stops it.

## How it behaves

- A ping goes out 50 minutes after your last finished turn. Any turn pushes it back, so while you are working it sends nothing.
- It stops at the deadline with a "finished" toast. The last ping goes out while there is still time left, so the cache stays warm to the end of the run.
- A turn that is running holds the ping back; it is re-armed when the turn ends.
- The deadline is kept in session state, so `/reload-plugins` resumes the run, at your next turn at the latest. A restart or a new session starts clean, and `/clear` ends the run.
- Each ping is a full turn that re-reads the context, and it adds a short message and an "ok" reply to the conversation. That is cheap per token, but on a subscription it uses request quota and saves no money.
- If the machine sleeps past the hour, the cache is already cold when the next ping goes out.
- It assumes the 1-hour cache. Where the cache only lasts 5 minutes, a 50-minute ping keeps nothing warm.

## Test

```
claude plugin test .
```
