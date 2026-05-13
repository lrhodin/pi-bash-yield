# pi-bash-yield

Non-blocking bash for [pi](https://github.com/earendil-works/pi). Every command yields control back at a model-set `check_in` interval with a handle, partial output, and idle timing. The agent decides whether to continue waiting, send stdin, or kill.

## Why

pi's built-in `bash` tool blocks the agent loop until the child process exits. There's no default timeout, so a hung command (waiting on stdin, stuck in a loop, network stall) stops the agent indefinitely until the user hits Esc. The pi maintainers have closed this twice as wontfix and recommend the model set a `timeout` per call — but a timeout that *kills* on expiry is the wrong shape. Most "long-running" commands aren't long because they're doing work; they're long because something went wrong, and the agent needs to *see* what's happening to react.

This extension replaces `bash` with a check-in–based design. Every command is a managed background process. The tool returns at `min(check_in, exit)`: if the command finishes early, you get final output; otherwise you get a handle, the rolling output tails, and timing so the agent can decide what to do next.

## Install

```bash
pi install git:github.com/lrhodin/pi-bash-yield
```

Then `/reload` or restart pi. The built-in `bash` tool is replaced; uninstalling restores it.

## Tools

| Tool | Purpose |
|---|---|
| `bash(command, check_in?=10)` | Run a shell command. Returns at `min(check_in, exit)`. If still running, returns a handle. |
| `bash_continue(handle, check_in?)` | Keep waiting on a running handle. |
| `bash_input(handle, text, close_stdin?)` | Write to the process's stdin. |
| `bash_kill(handle, signal?)` | Terminate. SIGTERM by default; SIGKILL after 1s if still alive. |

`check_in` is bounded to 1–600 seconds.

## Output shape

```
running handle=bash-3 elapsed=10.0s last_output=2.1s ago

stdout:
last line of output…

stderr:
warning: deprecated
```

```
exited code=0 elapsed=10.02s

stdout:
done
```

Both stdout and stderr are tailed to ~50KB per stream. When truncated, the snapshot links the full log file in `/tmp/pi-bash-checkin-<pid>/`. Empty streams are omitted from the render.

## Design notes

- **Never blocks the agent loop.** Every bash call resolves at the check-in or at exit, whichever comes first.
- **No kill-on-timeout.** Check-ins are observation points, not death sentences. The agent decides.
- **`last_output` is the stuck signal.** Compare it to `elapsed` to gauge whether the process is making progress, idle, or waiting on stdin.
- **Handles live in memory for the pi session.** They survive across turns but not across pi restarts. On pi exit, surviving children get SIGKILL'd.
- **Backward-compat:** the schema accepts `timeout` as a synonym for `check_in` so older AGENTS.md guidance doesn't break.

## Known limitations

- **No PTY.** Stdin and stdout are pipes, not a terminal. Programs that demand a real TTY (`vim`, `htop`, `sudo` password prompts that insist on `/dev/tty`) won't work via `bash_input`. Line-based prompts (`read`, REPL prompts) do.
- **No per-call `cwd`.** Inherits `process.cwd()` like the built-in.
- **Last-registered wins.** Don't stack this with another extension that also overrides `bash`.

## When you want this

Install if you:

- Have hit the unbounded-bash hang in pi where a command waits on stdin or otherwise stalls and the only escape is Esc.
- Want the agent to see and react to stuck commands instead of killing them blindly.
- Want every shell call to behave the same shape — no separate "long-running" mode the agent has to opt into.

Don't install if you:

- Run mostly interactive full-screen programs (`vim`, `htop`, `sudo` with TTY-only prompts). No PTY, see *Known limitations*.
- Want a process-management UI (dock, log overlay, log watches). For that, see [`@aliou/pi-processes`](https://www.npmjs.com/package/@aliou/pi-processes) — different shape (separate `process` tool, dock, watches), complementary if you need both backgrounded daemons and bounded synchronous commands.

## Worked example

Agent runs an install that prompts for a sudo password:

```
> bash("sudo apt install foo", check_in=5)
running handle=bash-1 elapsed=5.0s last_output=4.8s ago

stderr:
[sudo] password for ludvig:
```

Agent recognizes the prompt and reacts:

```
> bash_input("bash-1", "hunter2\n")
running handle=bash-1 elapsed=5.1s last_output=5.1s ago

stderr:
[sudo] password for ludvig:

> bash_continue("bash-1", check_in=30)
exited code=0 elapsed=18.4s

stdout:
Reading package lists... Done
Building dependency tree... Done
foo is already the newest version (1.2.3).
```

Or a hung command that the agent decides to abandon:

```
> bash("curl https://broken-endpoint/", check_in=5)
running handle=bash-2 elapsed=5.0s last_output=5.0s ago
(no output yet)

> bash_continue("bash-2", check_in=10)
running handle=bash-2 elapsed=15.0s last_output=15.0s ago
(no output yet)

> bash_kill("bash-2")
exited code=(none) signal=SIGTERM elapsed=15.4s
```

In both cases the agent loop never blocks. The model sees state, decides next step, moves on.

## License

MIT
