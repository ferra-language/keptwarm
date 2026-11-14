# keptwarm

A Claude Code mod that keeps your session's prompt cache warm. With the 1-hour cache, a session that sits idle goes cold and has to pay to rebuild its whole context when you come back. `/keptwarm` sends one automatic prompt to Claude after 50 idle minutes so that does not happen.

**What it costs:** every ping is a real turn on your session's current model. It re-reads the whole cached context, so it uses API tokens or your subscription usage limits, a small amount each, but it adds up over many sessions and hours. It only pays off if you come back to the session.

## Example prompts

```
/keptwarm           keep this session warm, 6 hours after your last prompt
/keptwarm 2h        the same, for 2 hours
/keptwarm project   keep every session in this project warm, starting when you type in it
/keptwarm auto      do that for every session, in every project
/keptwarm off       stop, for this session
/keptwarm status    what is on or off right now
/keptwarm help      the full list of commands
```

## Install

```
claude plugin marketplace add ferra-language/keptwarm
claude plugin install keptwarm@keptwarm --scope user
```

The user scope makes `/keptwarm` available in every project. Restart a session, or run `/reload-plugins`, to pick it up.

## Use

| Command | What it does |
|---|---|
| `/keptwarm` | Keep this session warm until 6 hours after your last prompt |
| `/keptwarm 2h` or `/keptwarm 30m` | The same with another window, from a minute to 12 hours |
| `/keptwarm off` | Off for this session; it stays off, even with auto on and across `/clear` |
| `/keptwarm status` | Shows this session, the auto setting and the projects on the list |
| `/keptwarm help` | Prints the list of commands |
| `/keptwarm project` or `/keptwarm project 2h` | Every session in this project keeps itself warm after you type in it (3 hours or the length you give) |
| `/keptwarm project off` | Takes this project off the list |
| `/keptwarm auto` or `/keptwarm auto 4h` | Every session keeps itself warm, 3 hours (or the length you give) after its last prompt |
| `/keptwarm auto off` | Turns auto off for all sessions. This session stops too if only auto was running it; other sessions stay warm until their current stop time |

Auto and project are off until you turn them on. Under auto or project a session arms itself on your first prompt in it, so a session you never use never pings. While one of them applies to a session that is not running yet, the status line says `keptwarm: auto on, starts when you type`. The `⚠` the engine draws before a plugin's status line is not an error; the mod cannot change it.

`project` acts on the project you are in. A project is the git repository a session runs in (the main working tree, for a worktree), or its folder when it is not in one. Which window applies, most specific first: this session's own (`/keptwarm 2h`, or `off`), then its project's, then the all-sessions one. If two sessions change the list at the same moment, the last write wins. A home folder that is itself a git repository counts as one project.

## How it behaves

- **It slides.** Every prompt you type pushes the stop time out to the window from now, so a session you use all day is never cut off, and an idle one stops after the window. A 6-hour window costs at most 7 pings.
- **Only typed prompts count.** Prompts you type in the terminal or desktop app, and ones from Remote Control or Slack, extend the window. Its own pings, loops, scheduled tasks, background notifications and slash commands never do.
- A ping goes out 50 minutes after your last finished turn. A turn that is running holds it back, and it is re-armed when the turn ends (also when it is interrupted or fails), so while you are working it sends nothing.
- At the end the status line keeps `keptwarm: ended HH:MM, type to restart` until your next prompt, with a toast when it stops. Typing starts it again, and `/keptwarm status` says so.
- The deadline is kept in session state, so `/reload-plugins` resumes the run, at your next turn at the latest. A restart or a new session starts clean, and `/clear` ends the run and drops this session's own window, so the auto setting applies again; a session you turned `off` stays off.
- **Cost.** A cache read costs about a twentieth of a rebuild, so a run of up to about 17 idle hours costs less than one cold rebuild if you do come back; that is why the cap is 12 hours. If you never come back, the pings are pure cost. With auto on, every session you have used pings about hourly until its window ends, which on a subscription uses usage limits and saves no money.
- Settings hooks and other plugins' `prompt.submit` hooks also run on every ping, and can add to or override its text.
- If the machine sleeps past the hour, the cache is already cold when the next ping goes out.
- It assumes the 1-hour cache and cannot tell which cache your setup uses. Where the cache only lasts 5 minutes, a 50-minute ping keeps nothing warm.

## What it runs, sends and stores

- **The ping** is this exact message, submitted as a normal prompt in the session: `Cache keepalive from the keptwarm mod. Reply with just "ok" and do nothing else.` It adds that message and a short reply to the conversation. It is a real turn, so in a mode that auto-approves tools the model could in principle act on it; the text asks it to reply "ok" only.
- **What goes into the prompt:** only that fixed sentence. The mod never copies your conversation, files, folder names or any other data into a prompt it submits, so a ping cannot carry anything out.
- **What it listens to:** it hooks `prompt.submit` only to see where each prompt came from (typed by you, or automatic) and whether it is a slash command. It never reads or changes the prompt text; every prompt passes through untouched. It also hooks turn start and end, `/clear` and session start to time the pings, and registers the `/keptwarm` command.
- **Network:** the mod makes no network requests of its own and has no telemetry. The only thing that leaves your machine is the ping, which goes to Claude like any prompt you type.
- **Stored locally:** the auto length and the project list (folder paths with their window) in the mod's own store, a `keptwarm_*.json` file in the `plugins/store` folder under your Claude config folder. To reset it, run `/keptwarm auto off` and `/keptwarm project off` in each listed project, or delete that file. `status` shows folder names only, and like any command reply it becomes part of the conversation, so the model sees those names. Keep the store file out of any repository you commit.
- It does not read your conversation, memory or files.

## Troubleshooting

- **Status says "warm until" but no ping arrives:** the first ping comes 50 idle minutes after your last finished turn, and a running turn holds it back. A sleeping machine pauses the timer.
- **`ping failed` toast:** the ping could not be submitted. It tries again at the next ping; `/keptwarm off` then `/keptwarm` restarts the run.
- **`ended HH:MM, type to restart`:** the window ran out with no prompts. Type anything, or run `/keptwarm`, to start it again.
- **A `⚠` before the status line:** drawn by Claude Code for every plugin status line, not an error.
- **Stop everything:** `/keptwarm off` here, `/keptwarm auto off` for all sessions, or `claude plugin uninstall keptwarm`.

## Support

Report bugs and ask questions at [github.com/ferra-language/keptwarm/issues](https://github.com/ferra-language/keptwarm/issues).

## Test

```
claude plugin test .
```
