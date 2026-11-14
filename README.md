# keepwarm

A Claude Code mod that keeps your session's prompt cache warm. The cache lasts one hour after the last request, so `/keepwarm` sends one tiny ping after 50 idle minutes. That keeps a long, paused session from paying to rebuild its whole context when you come back.

## Install

In a terminal session:

```
/plugin install keepwarm --marketplace ferra-language/keepwarm
```

Answer `y` to add the marketplace, then pick the user scope so it works in every project.

## Use

- `/keepwarm` runs for 6 hours.
- `/keepwarm 12h` or `/keepwarm 30m` sets another length.
- `/keepwarm off` stops it.

## How it behaves

- A ping goes out 50 minutes after your last finished turn. Any turn pushes it back, so while you are working it sends nothing.
- It stops by itself at the deadline, with a toast.
- The deadline is kept in session state, so `/reload-plugins` resumes the run. A restart or a new session starts clean.
- Each ping is a full turn that re-reads the context. That is cheap per token, but on a subscription it uses request quota and saves no money.

## Test

```
claude plugin test .
```
