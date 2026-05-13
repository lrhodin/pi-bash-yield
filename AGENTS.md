# AGENTS.md

Context for agents working on this repo. The design took several iterations
to settle on; this file is what got preserved. Read it before changing
behavior.

## Core principle

Every bash invocation is non-blocking from the agent loop's perspective.
The tool returns at `min(check_in, exit)`. Check-ins are observation
points, not death sentences. There is no kill-on-timeout, anywhere, ever.
If a command is stuck, the agent sees the current state and decides what to
do — wait more, send stdin, kill. That decision belongs to the model.

If you find yourself adding a "auto-kill after N seconds with no output"
heuristic, stop. That was explicitly rejected. The whole point of this
extension is to *not* do that.

## Why not use `BashOperations.exec` from pi?

Pi exposes `createLocalBashOperations()` which returns an `exec()` that
streams output and resolves on exit. We can't use it: it owns the child's
lifecycle inside a single promise. We need the `ChildProcess` handle to
survive across tool calls so the agent can `bash_continue` /
`bash_input` / `bash_kill` on later turns. So we spawn directly via
`node:child_process.spawn` with `detached: true` and manage everything
ourselves.

## Output rules

Every byte we emit costs context. The render evolved through several
rounds of trimming. Rules:

- **Never echo the tool call args.** `command` and `cwd` were dropped
  because they're already in the model's previous-turn tool call.
- **Never include derived booleans.** `looks_idle` was removed in favor of
  raw `last_output=X.Xs ago`. The agent does the comparison.
- **Don't duplicate pi's TUI decorations in the text, but...** Pi's TUI
  draws a "Took X.Xs" footer for the human. That footer is *not* in the
  model's context — verify by reading the function_results in a real
  session. Therefore `elapsed=` stays in our output. If you remove it
  thinking it's redundant, you're stealing information from the model.
- **Omit empty streams.** If `stdout` is empty, don't print the `stdout:`
  header at all. Same for `stderr`. If both are empty, say
  `(no output yet)` once.
- **Truncation notes only when truncated.** Don't print byte totals or log
  paths when the entire stream fits.
- **Don't restate tool descriptions.** No "Choices: bash_continue, …"
  footer. The model already has the tool list.

## Schema backward-compat

`bash` accepts both `check_in` and `timeout` (treated as a synonym for
`check_in`). This exists so older AGENTS.md guidance that mentions
`timeout` doesn't get rejected by the new schema. Don't remove the alias.

## Handle lifecycle

- Allocated when `check_in` fires before the child exits. Format:
  `bash-<N>` where N is a monotonically increasing per-session counter.
- Stored in an in-memory `Map<string, ManagedProcess>`. Not persisted.
- Survives across agent turns within a single pi session. Does *not*
  survive pi restart.
- Removed from the map when: the process exits and we've yielded once
  more (so a pending `bash_continue` can drain final output), or
  `bash_kill` completes.
- On `process.on("exit")` of pi itself, we SIGKILL the process group of
  any surviving child. No zombies.

## TTY / PTY

We use plain pipes for stdio, not a PTY. This is a deliberate design
choice, not a feature gap.

Pipes give us:
- Separate stdout / stderr streams (useful diagnostic signal).
- No ANSI escape noise in output.
- No native module dependency.
- Bounded, well-defined behavior for the 99% case.

They don't work for programs that gate on `isatty()` or demand a real
controlling terminal (`vim`, `htop`, `sudo` password prompts that read
from `/dev/tty`, ssh interactive auth). The solution for those is
documented in the `bash` tool description: spawn them inside tmux via
the same `bash` tool. tmux is already on the system (it's also how the
subagent skill works), provides a real PTY, and lets the user attach
and watch live.

Do not add a PTY mode (`tty: true`, `node-pty`, etc.) to this
extension. The tmux fallback covers the same surface with no native
dependency, no second code path, no echo-suppression problem, and the
additional benefit that the user can `tmux attach -t pi-tmux-<name>`
to see what's happening. If you find yourself wanting `node-pty` here,
stop and write down the specific scenario it solves that tmux does
not — then revisit.

## Shell

We use `$SHELL` (falling back to `/bin/bash`) with `-c <command>`. This
inherits the user's shell, including their aliases and rc files for
interactive shells (note: `-c` typically uses a non-interactive shell,
so aliases may not load — match the built-in pi behavior here).

## Tail buffer strategy

Each stream gets a rolling tail capped at 50KB (`TAIL_MAX_BYTES`). The
full output is also written to `/tmp/pi-bash-checkin-<pid>/bash-N.log`
so the agent can read more via the regular `read` tool if needed.

The tail is the *last* 50KB seen, not the last 50KB since the last
check-in. This is deliberate — the agent should see a consistent
snapshot, not a delta that depends on when it last looked.

## Testing locally without re-publishing

```bash
pi -e ./extensions/bash-yield.ts -p "ls"
```

For an interactive session: `pi -e ./extensions/bash-yield.ts`. The `-e`
flag takes precedence over the installed package, so iterate on the file
directly without touching the install.

## Releasing

1. Bump `version` in `package.json`.
2. Commit, tag `vX.Y.Z`, push tag and main.
3. On the user's machine: `pi update git:github.com/lrhodin/pi-bash-yield`.

## Things we deliberately do NOT do

- Auto-kill on inactivity.
- Stream `output_delta` notifications mid-tool-call. Pi doesn't expose
  this primitive cleanly for custom tools; the check-in loop is the
  intended replacement.
- Expose `working_directory` / `env` parameters on `bash`. The agent can
  `cd` and set env inline. KISS for v1.
- Track per-handle telemetry, logging, or observability. The temp log
  file is enough for debugging.
- Render anything in TUI custom components. The plain-text snapshot is
  the entire interface.

## Future work (not yet justified)

- Per-call `cwd` parameter (only if the inline `cd` pattern proves awkward).
- A `bash_list` tool to enumerate live handles (only if the model gets
  confused about which handles exist).

Explicitly *not* future work: PTY support. See the TTY / PTY section.
The tmux fallback documented in the `bash` tool description is the
intended solution and is sufficient.
