/**
 * bash-checkin — non-blocking bash with check-in semantics.
 *
 * Replaces the built-in `bash` tool. Every bash invocation runs in a managed
 * child process. The call returns at min(check_in, exit) with the current
 * status. If still running, the agent gets a handle and can:
 *   - bash_continue(handle, check_in?)  — wait some more
 *   - bash_input(handle, text)          — write to stdin
 *   - bash_kill(handle, signal?)        — terminate
 *
 * If the child exits before the check-in fires, the call returns final output
 * and no handle. There is no kill-on-timeout: timeouts surface status to the
 * agent, they don't kill anything.
 *
 * Output: each yield includes the rolling tail (last ~50KB) of stdout/stderr
 * plus byte counters and a full-log file path.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const DEFAULT_CHECK_IN_SEC = 10;
const MIN_CHECK_IN_SEC = 1;
const MAX_CHECK_IN_SEC = 600;
const TAIL_MAX_BYTES = 50 * 1024;

type ManagedProcess = {
	id: string;
	child: ChildProcess;
	cwd: string;
	command: string;
	startedAt: number;
	endedAt: number | undefined;
	lastOutputAt: number;
	stdoutTail: string;
	stderrTail: string;
	totalStdoutBytes: number;
	totalStderrBytes: number;
	logPath: string;
	logStream: WriteStream;
	exitCode: number | null | undefined;
	exitSignal: NodeJS.Signals | null | undefined;
	exited: boolean;
	yieldedAfterExit: boolean;
	stdinClosed: boolean;
};

const procs = new Map<string, ManagedProcess>();
let nextId = 1;

const tmpRoot = join(tmpdir(), `pi-bash-checkin-${process.pid}`);
mkdirSync(tmpRoot, { recursive: true });

// Kill any children we still own when pi exits.
const cleanupAll = () => {
	for (const p of procs.values()) {
		if (!p.exited && p.child.pid) {
			try {
				process.kill(-p.child.pid, "SIGKILL");
			} catch {
				try {
					p.child.kill("SIGKILL");
				} catch {
					/* ignore */
				}
			}
		}
		try {
			p.logStream.end();
		} catch {
			/* ignore */
		}
	}
};
process.on("exit", cleanupAll);

function appendTail(prev: string, chunk: string, cap: number): string {
	const combined = prev + chunk;
	if (combined.length <= cap) return combined;
	return combined.slice(-cap);
}

function clampCheckIn(seconds: number | undefined): number {
	if (seconds === undefined || !Number.isFinite(seconds)) return DEFAULT_CHECK_IN_SEC;
	if (seconds < MIN_CHECK_IN_SEC) return MIN_CHECK_IN_SEC;
	if (seconds > MAX_CHECK_IN_SEC) return MAX_CHECK_IN_SEC;
	return seconds;
}

function killGroup(p: ManagedProcess, signal: NodeJS.Signals): void {
	if (p.exited || !p.child.pid) return;
	try {
		process.kill(-p.child.pid, signal);
	} catch {
		try {
			p.child.kill(signal);
		} catch {
			/* ignore */
		}
	}
}

function formatBytes(n: number): string {
	if (n < 1024) return `${n}B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
	return `${(n / (1024 * 1024)).toFixed(1)}MB`;
}

function renderStream(label: string, tail: string, total: number, logPath: string): string[] {
	if (total === 0) return [];
	const lines = [`${label}:`];
	if (total > TAIL_MAX_BYTES) {
		lines.push(`[last ${formatBytes(TAIL_MAX_BYTES)} of ${formatBytes(total)} — full log: ${logPath}]`);
	}
	lines.push(tail);
	return lines;
}

function renderRunning(p: ManagedProcess): string {
	const elapsed = ((Date.now() - p.startedAt) / 1000).toFixed(1);
	const sinceOutput = ((Date.now() - p.lastOutputAt) / 1000).toFixed(1);
	const header = `running handle=${p.id} elapsed=${elapsed}s last_output=${sinceOutput}s ago`;
	const parts: string[] = [header];
	const out = renderStream("stdout", p.stdoutTail, p.totalStdoutBytes, p.logPath);
	const err = renderStream("stderr", p.stderrTail, p.totalStderrBytes, p.logPath);
	if (out.length === 0 && err.length === 0) {
		parts.push("(no output yet)");
	} else {
		if (out.length) parts.push("", ...out);
		if (err.length) parts.push("", ...err);
	}
	return parts.join("\n");
}

function renderExited(p: ManagedProcess): string {
	const duration = (((p.endedAt ?? Date.now()) - p.startedAt) / 1000).toFixed(2);
	const code = p.exitCode == null ? "(none)" : String(p.exitCode);
	const sig = p.exitSignal ? ` signal=${p.exitSignal}` : "";
	const header = `exited code=${code}${sig} elapsed=${duration}s`;
	const parts: string[] = [header];
	const out = renderStream("stdout", p.stdoutTail, p.totalStdoutBytes, p.logPath);
	const err = renderStream("stderr", p.stderrTail, p.totalStderrBytes, p.logPath);
	if (out.length === 0 && err.length === 0) {
		parts.push("(no output)");
	} else {
		if (out.length) parts.push("", ...out);
		if (err.length) parts.push("", ...err);
	}
	return parts.join("\n");
}

function snapshot(p: ManagedProcess): AgentToolResult {
	const text = p.exited ? renderExited(p) : renderRunning(p);
	return { content: [{ type: "text", text }], details: {} };
}

function spawnManaged(command: string, cwd: string): ManagedProcess {
	const id = `bash-${nextId++}`;
	const logPath = join(tmpRoot, `${id}.log`);
	const logStream = createWriteStream(logPath);
	const shell = process.env.SHELL ?? "/bin/bash";
	const child = spawn(shell, ["-c", command], {
		cwd,
		env: process.env,
		stdio: ["pipe", "pipe", "pipe"],
		detached: true,
	});

	const now = Date.now();
	const p: ManagedProcess = {
		id,
		child,
		cwd,
		command,
		startedAt: now,
		endedAt: undefined,
		lastOutputAt: now,
		stdoutTail: "",
		stderrTail: "",
		totalStdoutBytes: 0,
		totalStderrBytes: 0,
		logPath,
		logStream,
		exitCode: undefined,
		exitSignal: undefined,
		exited: false,
		yieldedAfterExit: false,
		stdinClosed: false,
	};

	child.stdout?.on("data", (chunk: Buffer) => {
		const s = chunk.toString("utf-8");
		p.totalStdoutBytes += chunk.byteLength;
		p.stdoutTail = appendTail(p.stdoutTail, s, TAIL_MAX_BYTES);
		p.lastOutputAt = Date.now();
		p.logStream.write(chunk);
	});
	child.stderr?.on("data", (chunk: Buffer) => {
		const s = chunk.toString("utf-8");
		p.totalStderrBytes += chunk.byteLength;
		p.stderrTail = appendTail(p.stderrTail, s, TAIL_MAX_BYTES);
		p.lastOutputAt = Date.now();
		p.logStream.write(chunk);
	});
	child.on("exit", (code, signal) => {
		p.exited = true;
		p.exitCode = code;
		p.exitSignal = signal;
		p.endedAt = Date.now();
		try {
			p.logStream.end();
		} catch {
			/* ignore */
		}
	});
	child.on("error", (err) => {
		p.exited = true;
		p.exitCode = null;
		p.exitSignal = null;
		p.endedAt = Date.now();
		const msg = `\n[spawn error] ${err.message}\n`;
		p.stderrTail = appendTail(p.stderrTail, msg, TAIL_MAX_BYTES);
		p.totalStderrBytes += Buffer.byteLength(msg);
		try {
			p.logStream.end();
		} catch {
			/* ignore */
		}
	});

	procs.set(id, p);
	return p;
}

/**
 * Wait until either the process exits, the check-in timer fires, or the signal aborts.
 */
function waitForCheckIn(p: ManagedProcess, checkInMs: number, signal: AbortSignal | undefined): Promise<"exited" | "checkin" | "aborted"> {
	return new Promise((resolve) => {
		if (p.exited) {
			resolve("exited");
			return;
		}
		if (signal?.aborted) {
			resolve("aborted");
			return;
		}
		let settled = false;
		const finish = (kind: "exited" | "checkin" | "aborted") => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			p.child.off("exit", onExit);
			signal?.removeEventListener("abort", onAbort);
			resolve(kind);
		};
		const onExit = () => finish("exited");
		const onAbort = () => finish("aborted");
		const timer = setTimeout(() => finish("checkin"), checkInMs);
		p.child.once("exit", onExit);
		signal?.addEventListener("abort", onAbort);
	});
}

async function runOneTurn(p: ManagedProcess, checkInSec: number, signal: AbortSignal | undefined): Promise<AgentToolResult> {
	const outcome = await waitForCheckIn(p, checkInSec * 1000, signal);
	if (outcome === "aborted") {
		killGroup(p, "SIGTERM");
		// Give it a moment to die so we can report the final state.
		await new Promise((r) => setTimeout(r, 200));
		if (!p.exited) killGroup(p, "SIGKILL");
		await new Promise((r) => setTimeout(r, 50));
		p.yieldedAfterExit = true;
		procs.delete(p.id);
		return snapshot(p);
	}
	if (outcome === "exited") {
		p.yieldedAfterExit = true;
		procs.delete(p.id);
		return snapshot(p);
	}
	// checkin: leave handle in the map for bash_continue / bash_input / bash_kill
	return snapshot(p);
}

const bashParams = Type.Object({
	command: Type.String({ description: "Shell command to execute. Runs under $SHELL -c." }),
	check_in: Type.Optional(
		Type.Number({
			description: `Seconds to wait before yielding status back to you. Default ${DEFAULT_CHECK_IN_SEC}s. This is NOT a kill timeout — the command keeps running even after check-in fires. You'll get a handle to continue, send input, or kill.`,
			minimum: MIN_CHECK_IN_SEC,
			maximum: MAX_CHECK_IN_SEC,
		}),
	),
	// Backward-compat alias: old AGENTS.md guidance may say `timeout`. Treated as check_in.
	timeout: Type.Optional(Type.Number({ description: "Alias for check_in (backward compat with the previous bash tool). Prefer check_in." })),
});

const continueParams = Type.Object({
	handle: Type.String({ description: "Handle returned by a previous bash/bash_continue call (e.g. bash-3)." }),
	check_in: Type.Optional(
		Type.Number({
			description: `Seconds to wait before yielding status again. Default ${DEFAULT_CHECK_IN_SEC}s.`,
			minimum: MIN_CHECK_IN_SEC,
			maximum: MAX_CHECK_IN_SEC,
		}),
	),
});

const inputParams = Type.Object({
	handle: Type.String({ description: "Handle returned by a previous bash/bash_continue call." }),
	text: Type.String({ description: "Text to write to the process's stdin. Append \\n yourself if the process expects a line." }),
	close_stdin: Type.Optional(Type.Boolean({ description: "If true, close stdin after writing." })),
});

const killParams = Type.Object({
	handle: Type.String({ description: "Handle of the process to terminate." }),
	signal: Type.Optional(Type.String({ description: "Signal name, e.g. SIGTERM, SIGINT, SIGKILL. Default SIGTERM, then SIGKILL after 1s if still alive." })),
});

function notFound(handle: string): AgentToolResult {
	return {
		content: [{ type: "text", text: `Error: no live process for handle '${handle}'. It may have already exited and been drained, or never existed.` }],
		details: {},
	};
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "bash",
		label: "Bash",
		description:
			"Execute a shell command. Non-blocking: returns at min(check_in, exit). If the command exits before check_in, you get final output. " +
			"If check_in fires first, you get a handle plus current stdout/stderr tails and idle status — use bash_continue/bash_input/bash_kill to manage it. " +
			"Default check_in is " + DEFAULT_CHECK_IN_SEC + "s. Output is tailed to ~50KB per stream; full log path is included. " +
			"For commands that require a real TTY (sudo password prompts, ssh interactive auth, vim, htop), bash_input via pipe will not work — run them inside tmux instead: " +
			"`tmux new-session -d -s pi-tmux-<name> '<cmd>'`, then `tmux send-keys -t pi-tmux-<name> '<input>' Enter` and `tmux capture-pane -t pi-tmux-<name> -p` via subsequent bash calls. Always `tmux kill-session -t pi-tmux-<name>` when done.",
		parameters: bashParams,
		async execute(_toolCallId, params, signal) {
			const checkIn = clampCheckIn(params.check_in ?? params.timeout);
			const cwd = process.cwd();
			const p = spawnManaged(params.command, cwd);
			return runOneTurn(p, checkIn, signal ?? undefined);
		},
	});

	pi.registerTool({
		name: "bash_continue",
		label: "Bash continue",
		description:
			"Continue waiting on a running bash handle. Returns at min(check_in, exit). Use this when bash returned status=running and you want to wait more.",
		parameters: continueParams,
		async execute(_toolCallId, params, signal) {
			const p = procs.get(params.handle);
			if (!p) return notFound(params.handle);
			const checkIn = clampCheckIn(params.check_in);
			return runOneTurn(p, checkIn, signal ?? undefined);
		},
	});

	pi.registerTool({
		name: "bash_input",
		label: "Bash input",
		description:
			"Write text to the stdin of a running bash handle. Use this when a command is prompting for input (password, y/n, REPL). Returns immediately with current status — call bash_continue afterwards to wait for new output.",
		parameters: inputParams,
		async execute(_toolCallId, params) {
			const p = procs.get(params.handle);
			if (!p) return notFound(params.handle);
			if (p.exited) {
				return {
					content: [{ type: "text", text: `Error: process ${params.handle} has already exited.` }],
					details: {},
				};
			}
			if (p.stdinClosed || !p.child.stdin || p.child.stdin.destroyed) {
				return {
					content: [{ type: "text", text: `Error: stdin for ${params.handle} is closed.` }],
					details: {},
				};
			}
			try {
				p.child.stdin.write(params.text);
				if (params.close_stdin) {
					p.child.stdin.end();
					p.stdinClosed = true;
				}
			} catch (err) {
				return {
					content: [{ type: "text", text: `Error writing to stdin: ${(err as Error).message}` }],
					details: {},
				};
			}
			return snapshot(p);
		},
	});

	pi.registerTool({
		name: "bash_kill",
		label: "Bash kill",
		description:
			"Terminate a running bash handle. Sends SIGTERM by default; if still alive after 1s sends SIGKILL. Returns the final captured output.",
		parameters: killParams,
		async execute(_toolCallId, params) {
			const p = procs.get(params.handle);
			if (!p) return notFound(params.handle);
			if (p.exited) {
				procs.delete(p.id);
				return snapshot(p);
			}
			const sig = (params.signal as NodeJS.Signals | undefined) ?? "SIGTERM";
			killGroup(p, sig);
			// Wait up to 1s for graceful exit, then SIGKILL.
			const deadline = Date.now() + 1000;
			while (!p.exited && Date.now() < deadline) {
				await new Promise((r) => setTimeout(r, 50));
			}
			if (!p.exited) {
				killGroup(p, "SIGKILL");
				const hardDeadline = Date.now() + 500;
				while (!p.exited && Date.now() < hardDeadline) {
					await new Promise((r) => setTimeout(r, 50));
				}
			}
			procs.delete(p.id);
			return snapshot(p);
		},
	});
}
