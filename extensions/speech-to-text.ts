/**
 * Speech-to-Text extension for pi.
 *
 * Registers native `transcribe` and `listen` tools, a `/listen` command, and
 * shortcuts:
 *   ctrl+b        start/stop mic recording, then insert the transcript
 *   ctrl+shift+l  record 5s and insert the transcript
 *
 * Local transcription goes straight to the warm faster-whisper daemon over a
 * unix socket (model stays in memory, like Hermes), so no python/ffmpeg process
 * is spawned per request. The `speech-to-text` skill script owns daemon startup
 * and the cloud (openai/groq) fallback.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { access, unlink, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import { Key } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

interface SttDetails {
	audio: string;
	lang: string;
	model?: string;
	provider?: string;
	text: string;
	recorded?: number;
}

interface DaemonResponse {
	text?: string;
	language?: string;
	probability?: number;
	error?: string;
}

const DEFAULT_MODEL = process.env.STT_MODEL || "base";

function agentDir(): string {
	return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

// Package root (this file lives in <pkg>/extensions/).
const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

async function resolveScript(): Promise<string> {
	const candidates = [
		process.env.NEXUS_H2A_HOME && join(process.env.NEXUS_H2A_HOME, "skills", "speech-to-text", "scripts", "transcribe.sh"),
		join(PKG_ROOT, "skills", "speech-to-text", "scripts", "transcribe.sh"),
		join(agentDir(), "skills", "speech-to-text", "scripts", "transcribe.sh"),
	].filter((p): p is string => Boolean(p));
	for (const script of candidates) {
		try {
			await access(script);
			return script;
		} catch {
			/* try next */
		}
	}
	throw new Error(
		`speech-to-text: transcribe.sh not found (looked in ${candidates.join(", ")}). Set NEXUS_H2A_HOME to the package root.`,
	);
}

function run(
	command: string,
	args: string[],
	signal?: AbortSignal,
): Promise<{ stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (d) => (stdout += d.toString()));
		child.stderr.on("data", (d) => (stderr += d.toString()));
		child.on("error", (err) => reject(new Error(`speech-to-text: ${err.message}`)));
		child.on("close", (code) => {
			if (code === 0) resolve({ stdout, stderr });
			else reject(new Error(stderr.trim() || `speech-to-text: exit code ${code}`));
		});
		const onAbort = () => child.kill("SIGTERM");
		if (signal) {
			if (signal.aborted) onAbort();
			else signal.addEventListener("abort", onAbort, { once: true });
		}
	});
}

// --- warm daemon client -------------------------------------------------
function socketPath(): string {
	if (process.env.STT_SOCKET) return process.env.STT_SOCKET;
	const runtime = process.env.XDG_RUNTIME_DIR || tmpdir();
	const uid = typeof process.getuid === "function" ? process.getuid() : 0;
	return join(runtime, `pi-stt-${uid}.sock`);
}

function daemonPing(timeoutMs = 1000): Promise<boolean> {
	return new Promise((resolve) => {
		const sock = connect(socketPath());
		sock.setTimeout(timeoutMs);
		sock.once("connect", () => {
			sock.end();
			resolve(true);
		});
		sock.once("error", () => resolve(false));
		sock.once("timeout", () => {
			sock.destroy();
			resolve(false);
		});
	});
}

function daemonRequest(payload: Record<string, unknown>, timeoutMs = 300000): Promise<DaemonResponse> {
	return new Promise((resolve, reject) => {
		const sock = connect(socketPath());
		let buffer = "";
		sock.setTimeout(timeoutMs);
		sock.once("connect", () => sock.write(`${JSON.stringify(payload)}\n`));
		sock.on("data", (chunk) => {
			buffer += chunk.toString();
			const newline = buffer.indexOf("\n");
			if (newline >= 0) {
				sock.end();
				try {
					resolve(JSON.parse(buffer.slice(0, newline)) as DaemonResponse);
				} catch {
					reject(new Error("speech-to-text: invalid daemon response"));
				}
			}
		});
		sock.once("error", (err) => reject(new Error(`speech-to-text: ${err.message}`)));
		sock.once("timeout", () => {
			sock.destroy();
			reject(new Error("speech-to-text: daemon timeout"));
		});
	});
}

async function ensureDaemon(): Promise<void> {
	if (await daemonPing()) return;
	const script = await resolveScript();
	await run("bash", [script, "--warmup"]);
	if (!(await daemonPing(3000))) throw new Error("speech-to-text: daemon did not start");
}

interface TranscribeOptions {
	lang?: string;
	model?: string;
	provider?: string;
}

/** Local transcription through the warm daemon. */
async function transcribeLocal(audio: string, opts: TranscribeOptions): Promise<DaemonResponse> {
	await ensureDaemon();
	const payload: Record<string, unknown> = { audio, model: opts.model || DEFAULT_MODEL };
	if (opts.lang && opts.lang !== "auto") payload.language = opts.lang;
	if (process.env.STT_DEVICE) payload.device = process.env.STT_DEVICE;
	if (process.env.STT_COMPUTE_TYPE) payload.compute_type = process.env.STT_COMPUTE_TYPE;
	if (process.env.STT_CPU_THREADS) payload.cpu_threads = Number(process.env.STT_CPU_THREADS);
	if (process.env.STT_VAD === "1") payload.vad = true;
	const response = await daemonRequest(payload);
	if (response.error) throw new Error(response.error);
	return response;
}

/** Cloud (or forced script) transcription. */
async function transcribeViaScript(audio: string, opts: TranscribeOptions): Promise<DaemonResponse> {
	const script = await resolveScript();
	const args: string[] = [];
	if (opts.lang && opts.lang !== "auto") args.push("-l", opts.lang);
	if (opts.model) args.push("-m", opts.model);
	if (opts.provider && opts.provider !== "auto") args.push("-p", opts.provider);
	args.push("--json", audio);
	const { stdout } = await run("bash", [script, ...args]);
	const lastLine = stdout.trim().split("\n").pop() || "";
	try {
		return JSON.parse(lastLine) as DaemonResponse;
	} catch {
		return { text: stdout.trim() };
	}
}

function transcribeAudio(audio: string, opts: TranscribeOptions): Promise<DaemonResponse> {
	if (opts.provider && opts.provider !== "auto" && opts.provider !== "local") {
		return transcribeViaScript(audio, opts);
	}
	return transcribeLocal(audio, opts);
}

// --- microphone recording (toggle) --------------------------------------
const RECORDER_CMD =
	'if command -v arecord >/dev/null 2>&1; then exec arecord -q -f S16_LE -r 16000 -c 1 "$1"; ' +
	'else exec pw-record --rate 16000 --channels 1 --format s16 "$1"; fi';

let activeRecording: { child: ChildProcess; file: string } | null = null;

function startRecording(): string {
	const file = join(tmpdir(), `pi-listen-${Date.now()}.wav`);
	const child = spawn("bash", ["-c", RECORDER_CMD, "bash", file], {
		stdio: ["ignore", "ignore", "pipe"],
		detached: true,
	});
	child.on("error", () => {
		if (activeRecording?.child === child) activeRecording = null;
	});
	child.on("close", () => {
		if (activeRecording?.child === child) activeRecording = null;
	});
	activeRecording = { child, file };
	return file;
}

function stopRecording(): Promise<string | null> {
	const rec = activeRecording;
	if (!rec) return Promise.resolve(null);
	activeRecording = null;
	const { child, file } = rec;
	const finished = new Promise<void>((resolve) => {
		if (child.exitCode !== null || child.signalCode !== null) return resolve();
		child.once("close", () => resolve());
	});
	const pid = child.pid;
	try {
		if (pid) process.kill(-pid, "SIGINT");
		else child.kill("SIGINT");
	} catch {
		try {
			child.kill("SIGINT");
		} catch {
			/* already gone */
		}
	}
	return finished.then(() => file);
}

function recordFixed(seconds: number): Promise<string> {
	return new Promise((resolve, reject) => {
		const file = join(tmpdir(), `pi-listen-${Date.now()}.wav`);
		const cmd =
			'if command -v arecord >/dev/null 2>&1; then exec arecord -q -f S16_LE -r 16000 -c 1 -d "$2" "$1"; ' +
			'else exec timeout "$2" pw-record --rate 16000 --channels 1 --format s16 "$1"; fi';
		const child = spawn("bash", ["-c", cmd, "bash", file, String(seconds)], {
			stdio: ["ignore", "ignore", "pipe"],
		});
		child.on("error", (err) => reject(new Error(`speech-to-text: ${err.message}`)));
		child.on("close", (code) => {
			if (code === 0) resolve(file);
			else reject(new Error(`speech-to-text: recorder exit ${code}`));
		});
	});
}

// --- result formatting --------------------------------------------------
function formatResult(response: DaemonResponse, details: SttDetails): {
	content: { type: "text"; text: string }[];
	details: SttDetails;
} {
	const transcript = (response.text || "").trim();
	const lang = response.language || details.lang;
	return {
		content: [
			{
				type: "text",
				text: transcript
					? `Transcript (lang=${lang}):\n${transcript}`
					: `Transcript: no speech detected (lang=${lang}).`,
			},
		],
		details: { ...details, lang, text: transcript },
	};
}

/** Insert a transcript into the editor, appending to existing text. */
function insertTranscript(ctx: ExtensionContext, transcript: string): void {
	const current = ctx.ui.getEditorText();
	ctx.ui.setEditorText(current ? `${current} ${transcript}` : transcript);
}

const COMMON_LANG = Type.Optional(
	Type.Union([Type.Literal("it"), Type.Literal("en"), Type.Literal("zh"), Type.Literal("auto")], {
		description: "Spoken language; default auto-detect (forcing it is ~2x faster).",
	}),
);

const COMMON_PROVIDER = Type.Optional(
	Type.Union([Type.Literal("auto"), Type.Literal("local"), Type.Literal("openai"), Type.Literal("groq")], {
		description: "Backend; default auto (local warm daemon).",
	}),
);

export default function (pi: ExtensionAPI) {
	// Preload the model so the first request is fast.
	pi.on("session_start", async () => {
		try {
			const script = await resolveScript();
			const child = spawn("bash", [script, "--warmup"], { stdio: "ignore", detached: true });
			child.unref();
		} catch {
			/* skill not installed */
		}
	});

	pi.registerTool({
		name: "transcribe",
		label: "Speech to text",
		description:
			"Transcribe an audio file to text (Italian, English, Chinese, or auto-detect). Supports any format ffmpeg can decode " +
			"(mp3, wav, m4a, ogg). Use when the user provides an audio/voice recording or asks to transcribe, \"trascrivi\", " +
			"\"converti audio in testo\", \"speech to text\".",
		parameters: Type.Object({
			audio: Type.String({ description: "Path to the audio file to transcribe." }),
			lang: COMMON_LANG,
			model: Type.Optional(Type.String({ description: `Model (default: ${DEFAULT_MODEL}).` })),
			provider: COMMON_PROVIDER,
			output: Type.Optional(Type.String({ description: "Optional path to write the transcript to." })),
		}),
		async execute(_toolCallId, params) {
			if (!params.audio || !params.audio.trim()) throw new Error("speech-to-text: 'audio' must not be empty");
			const response = await transcribeAudio(params.audio, {
				lang: params.lang,
				model: params.model,
				provider: params.provider,
			});
			if (params.output) {
				await writeFile(params.output, `${(response.text || "").trim()}\n`, "utf-8");
			}
			return formatResult(response, {
				audio: params.audio,
				lang: params.lang && params.lang !== "auto" ? params.lang : "auto",
				model: params.model || DEFAULT_MODEL,
				provider: params.provider,
				text: "",
			});
		},
	});

	pi.registerTool({
		name: "listen",
		label: "Listen (mic)",
		description:
			"Record audio from the microphone for a number of seconds, then transcribe it to text (Italian, English, Chinese, or auto-detect). " +
			"Use when the user says \"ascolta\", \"registra\", \"listen\", \"dimmi cosa dico\" or asks to capture voice input.",
		parameters: Type.Object({
			seconds: Type.Optional(Type.Number({ description: "Recording length in seconds (default 5).", minimum: 1, maximum: 120 })),
			lang: COMMON_LANG,
			model: Type.Optional(Type.String({ description: `Model (default: ${DEFAULT_MODEL}).` })),
			provider: COMMON_PROVIDER,
		}),
		async execute(_toolCallId, params) {
			const seconds = params.seconds && params.seconds > 0 ? params.seconds : 5;
			const file = await recordFixed(seconds);
			try {
				const response = await transcribeAudio(file, { lang: params.lang, model: params.model, provider: params.provider });
				return formatResult(response, {
					audio: `${seconds}s microphone recording`,
					lang: params.lang && params.lang !== "auto" ? params.lang : "auto",
					model: params.model || DEFAULT_MODEL,
					provider: params.provider,
					text: "",
					recorded: seconds,
				});
			} finally {
				void unlink(file).catch(() => {});
			}
		},
	});

	pi.registerCommand("listen", {
		description: "Record from the mic and transcribe. Usage: /listen [seconds] [it|en|zh]",
		handler: async (args, ctx) => {
			const parts = (args || "").trim().split(/\s+/).filter(Boolean);
			let seconds = 5;
			let lang: string | undefined;
			for (const p of parts) {
				if (/^\d+$/.test(p)) seconds = Math.min(120, Math.max(1, Number(p)));
				else if (/^(it|en|zh)$/i.test(p)) lang = p.toLowerCase();
			}
			try {
				ctx.ui.notify(`Listening for ${seconds}s…`, "info");
				const file = await recordFixed(seconds);
				const response = await transcribeAudio(file, { lang });
				const transcript = (response.text || "").trim();
				ctx.ui.notify(transcript ? `Transcript: ${transcript}` : "No speech detected", transcript ? "info" : "warning");
			} catch (err) {
				ctx.ui.notify(`Listen failed: ${(err as Error).message}`, "error");
			}
		},
	});

	// ctrl+shift+l — record 5s and insert the transcript into the editor
	pi.registerShortcut(Key.ctrlShift("l"), {
		description: "Record 5s from mic and insert transcript",
		handler: async (ctx: ExtensionContext) => {
			try {
				ctx.ui.notify("Listening for 5s…", "info");
				const file = await recordFixed(5);
				const response = await transcribeAudio(file, {});
				void unlink(file).catch(() => {});
				const transcript = (response.text || "").trim();
				if (!transcript) {
					ctx.ui.notify("No speech detected", "warning");
					return;
				}
				insertTranscript(ctx, transcript);
				ctx.ui.notify("Transcript inserted into the editor", "info");
			} catch (err) {
				ctx.ui.notify(`Listen failed: ${(err as Error).message}`, "error");
			}
		},
	});

	// ctrl+b — toggle recording: start, then stop + insert transcript
	pi.registerShortcut(Key.ctrl("b"), {
		description: "Start/stop mic recording and insert transcript",
		handler: async (ctx: ExtensionContext) => {
			if (activeRecording) {
				ctx.ui.notify("Processing recording…", "info");
				try {
					const file = await stopRecording();
					if (!file) {
						ctx.ui.notify("No recording", "warning");
						return;
					}
					const response = await transcribeAudio(file, {});
					void unlink(file).catch(() => {});
					const transcript = (response.text || "").trim();
					if (!transcript) {
						ctx.ui.notify("No speech detected", "warning");
						return;
					}
					insertTranscript(ctx, transcript);
					ctx.ui.notify("Transcript inserted into the editor", "info");
				} catch (err) {
					ctx.ui.notify(`Listen failed: ${(err as Error).message}`, "error");
				}
				return;
			}
			try {
				startRecording();
				ctx.ui.notify("Recording… press ctrl+b again to stop", "info");
			} catch (err) {
				ctx.ui.notify(`Could not start recording: ${(err as Error).message}`, "error");
			}
		},
	});

	// Clean up an in-flight recording on reload/shutdown.
	pi.on("session_shutdown", async () => {
		if (activeRecording) {
			try {
				await stopRecording();
			} catch {
				/* ignore */
			}
		}
	});
}
