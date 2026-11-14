# keptwarm

A Claude Code mod that keeps your session's prompt cache warm. With the 1-hour cache, a session that sits idle goes cold and has to pay to rebuild its whole context when you come back. `/keptwarm` sends one tiny ping after 50 idle minutes so that does not happen.

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
| `/keptwarm status` | Shows this session and the auto setting |
| `/keptwarm auto` or `/keptwarm auto 4h` | Every session keeps itself warm, 3 hours (or the length you give) after its last prompt |
| `/keptwarm auto off` | Turns auto off for all sessions; sessions already warm run to their end |
| `/keptwarm auto here` or `/keptwarm auto here 2h` | Auto only for this project (3 hours or the length you give) |
| `/keptwarm auto drop` | Takes this project off the auto list |
| `/keptwarm auto list` | Shows the all-sessions setting and the projects on the list, by folder name |

Auto is off until you turn it on. Under auto a session arms itself on your first prompt in it, so a session you never use never pings.

A project is the git repository a session runs in (the main working tree, for a worktree), or its folder when it is not in one. Which window applies, most specific first: this session's own (`/keptwarm 2h`, or `off`), then its project's, then the all-sessions one. The project list is saved as folder paths in the mod's own store, a local file under your Claude config folder; the mod sends nothing anywhere, and `auto list` and `status` show folder names only. Those replies, like any command reply, become part of the conversation, so the model sees the folder names. If two sessions change the list at the same moment, the last write wins. A home folder that is itself a git repository counts as one project. Keep the store file out of any repository you commit.

## How it behaves

- **It slides.** Every prompt you type pushes the stop time out to the window from now, so a session you use all day is never cut off, and an idle one stops after the window. A 6-hour window costs at most 7 pings.
- **Only typed prompts count.** Its own pings, loops, scheduled tasks, background notifications and slash commands never extend the window.
- A ping goes out 50 minutes after your last finished turn. A turn that is running holds it back, and it is re-armed when the turn ends, so while you are working it sends nothing.
- At the end the status line keeps `keptwarm: ended HH:MM` until your next prompt, with a toast when it stops.
- The deadline is kept in session state, so `/reload-plugins` resumes the run, at your next turn at the latest. A restart or a new session starts clean, and `/clear` ends the run and drops this session's own window, so the auto setting applies again; a session you turned `off` stays off.
- Each ping is a full turn that re-reads the context, and it adds a short message and an "ok" reply to the conversation. Each ping re-reads the cached context at about a tenth of the rebuild price, so a run of up to about 17 idle hours costs less than one cold rebuild; that is why the cap is 12 hours.
- **Cost scales with open sessions.** With auto on, every session you have used pings about hourly until its window ends. On a subscription that uses request quota and saves no money.
- Settings hooks and other plugins' `prompt.submit` hooks also run on every ping, and can add to or override its text.
- If the machine sleeps past the hour, the cache is already cold when the next ping goes out.
- It assumes the 1-hour cache. Where the cache only lasts 5 minutes, a 50-minute ping keeps nothing warm.

## Test

```
claude plugin test .
```
