/**
 * Speech-to-Text extension for pi.
 *
 * Registers native `transcribe` and `listen` tools, `/listen` and `/wake`
 * commands, and shortcuts:
 *   ctrl+b        start/stop mic recording, then insert the transcript
 *   ctrl+shift+l  record 5s and insert the transcript
 *   ctrl+shift+w  toggle hands-free wake-word listening
 *
 * While recording, a live audio-level graph is shown above the editor.
 *
 * Local transcription goes straight to the warm faster-whisper daemon over a
 * unix socket (model stays in memory, like Hermes), so no python/ffmpeg process
 * is spawned per request. The `speech-to-text` skill script owns daemon startup
 * and the cloud (openai/groq) fallback. The optional wake word runs a separate
 * sherpa-onnx keyword-spotter daemon (`wake_daemon.py`) that owns the mic and
 * streams levels/events over another unix socket.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { access, unlink, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import { Key, truncateToWidth } from "@earendil-works/pi-tui";
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

// --- microphone recording (raw PCM + live level) -----------------------
// The recorder writes headerless 16 kHz mono s16 PCM to stdout so the
// extension can compute a live RMS level (the "volume graph") and prepend a
// WAV header when the take is finished.
const RECORDER_RAW_CMD =
	'if command -v arecord >/dev/null 2>&1; then exec arecord -q -t raw -f S16_LE -r 16000 -c 1 --period-size 1600 -; ' +
	'else exec pw-record --rate 16000 --channels 1 --format s16 --container raw -; fi';

const SAMPLE_RATE = 16000;

interface Recording {
	child: ChildProcess;
	file: string;
	pcm: Buffer[];
	bytes: number;
	rms: number;
	startedAt: number;
}

let activeRecording: Recording | null = null;

// Live level meter shared by every recording path and the wake-word daemon.
const LEVEL_GLYPHS = [" ", "▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];
const METER_COLUMNS = 24;
const meter = {
	active: false,
	label: "REC",
	rms: 0,
	elapsed: 0,
	history: [] as number[],
	tick: null as (() => void) | null,
};

function setLevel(rms: number, elapsed?: number): void {
	meter.rms = rms;
	if (elapsed !== undefined) meter.elapsed = elapsed;
	meter.history.push(rms);
	if (meter.history.length > METER_COLUMNS) meter.history.splice(0, meter.history.length - METER_COLUMNS);
	meter.tick?.();
}

function pcmRms(chunk: Buffer): number {
	const samples = Math.floor(chunk.length / 2);
	if (samples <= 0) return 0;
	let sum = 0;
	for (let i = 0; i < samples; i++) {
		const s = chunk.readInt16LE(i * 2);
		sum += s * s;
	}
	return Math.sqrt(sum / samples);
}

/** Drop a RIFF/WAVE header if a recorder emitted one despite raw mode. */
function stripWavHeader(pcm: Buffer): Buffer {
	if (pcm.length < 12 || pcm.toString("ascii", 0, 4) !== "RIFF") return pcm;
	const dataIdx = pcm.indexOf(Buffer.from("data"));
	if (dataIdx < 0 || dataIdx + 8 > pcm.length) return pcm;
	return pcm.subarray(dataIdx + 8);
}

function wavFromPcm(pcm: Buffer): Buffer {
	const blockAlign = 2; // mono, 16-bit
	const header = Buffer.alloc(44);
	header.write("RIFF", 0, "ascii");
	header.writeUInt32LE(36 + pcm.length, 4);
	header.write("WAVE", 8, "ascii");
	header.write("fmt ", 12, "ascii");
	header.writeUInt32LE(16, 16);
	header.writeUInt16LE(1, 20); // PCM
	header.writeUInt16LE(1, 22); // channels
	header.writeUInt32LE(SAMPLE_RATE, 24);
	header.writeUInt32LE(SAMPLE_RATE * blockAlign, 28);
	header.writeUInt16LE(blockAlign, 32);
	header.writeUInt16LE(16, 34); // bits per sample
	header.write("data", 36, "ascii");
	header.writeUInt32LE(pcm.length, 40);
	return Buffer.concat([header, pcm]);
}

function beginCapture(): Recording {
	const file = join(tmpdir(), `pi-listen-${Date.now()}.wav`);
	const child = spawn("bash", ["-c", RECORDER_RAW_CMD], {
		stdio: ["ignore", "pipe", "pipe"],
		detached: true,
	});
	const rec: Recording = { child, file, pcm: [], bytes: 0, rms: 0, startedAt: Date.now() };
	child.stdout?.on("data", (chunk: Buffer) => {
		rec.pcm.push(chunk);
		rec.bytes += chunk.length;
		rec.rms = pcmRms(chunk);
		setLevel(rec.rms, (Date.now() - rec.startedAt) / 1000);
	});
	child.on("error", () => {
		if (activeRecording?.child === child) activeRecording = null;
	});
	child.on("close", () => {
		if (activeRecording?.child === child) activeRecording = null;
	});
	return rec;
}

function killRecorder(rec: Recording): Promise<void> {
	const { child } = rec;
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
	return finished;
}

async function finishCapture(rec: Recording): Promise<string> {
	await killRecorder(rec);
	const pcm = stripWavHeader(Buffer.concat(rec.pcm));
	await writeFile(rec.file, wavFromPcm(pcm));
	return rec.file;
}

function startRecording(): string {
	const rec = beginCapture();
	activeRecording = rec;
	return rec.file;
}

function stopRecording(): Promise<string | null> {
	const rec = activeRecording;
	if (!rec) return Promise.resolve(null);
	activeRecording = null;
	return finishCapture(rec);
}

function recordFixed(seconds: number): Promise<string> {
	const rec = beginCapture();
	return new Promise<string>((resolve, reject) => {
		let done = false;
		let timer: ReturnType<typeof setTimeout>;
		const finish = (err?: Error) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			if (err) reject(err);
			else finishCapture(rec).then(resolve, reject);
		};
		timer = setTimeout(() => finish(), Math.max(250, seconds * 1000));
		rec.child.on("error", (e) => finish(new Error(`speech-to-text: ${e.message}`)));
		rec.child.on("close", (code) => {
			if (rec.bytes === 0) finish(new Error(`speech-to-text: recorder exit ${code}`));
			else finish();
		});
	});
}

// --- live level meter UI ------------------------------------------------
function showMeter(ctx: ExtensionContext, label = "REC"): void {
	meter.active = true;
	meter.label = label;
	meter.rms = 0;
	meter.elapsed = 0;
	meter.history = [];
	if (ctx.mode !== "tui") return;
	ctx.ui.setWidget(
		"stt-meter",
		(tui, theme) => {
			meter.tick = () => tui.requestRender();
			return {
				render(width: number): string[] {
					const colorFor = (v: number) => (v > 6000 ? "error" : v > 3200 ? "warning" : "success");
					const glyph = (v: number) => LEVEL_GLYPHS[Math.max(1, Math.min(8, Math.ceil((Math.min(v, 8000) / 8000) * 8)))];
					const bars = meter.history.map((v) => theme.fg(colorFor(v), glyph(v) ?? "▁"));
					const pad = " ".repeat(Math.max(0, METER_COLUMNS - bars.length));
					const dot = theme.fg("error", "●");
					const label = theme.fg("accent", meter.label);
					const time = theme.fg("dim", `${meter.elapsed.toFixed(1)}s`);
					return [truncateToWidth(` ${dot} ${label} ${time}  ${pad}${bars.join("")}`, width)];
				},
				invalidate() {},
				dispose() {
					meter.tick = null;
				},
			};
		},
		{ placement: "aboveEditor" },
	);
}

function hideMeter(ctx: ExtensionContext): void {
	meter.active = false;
	meter.tick = null;
	if (ctx.mode === "tui") ctx.ui.setWidget("stt-meter", undefined);
}

// --- wake-word daemon client -------------------------------------------
// The daemon owns the mic and only arms it on an explicit {cmd:"resume"};
// a bare connect (wakePing) is a harmless liveness probe.
interface WakeEvent {
	event: string;
	state?: string;
	rms?: number;
	elapsed?: number;
	audio?: string;
	duration?: number;
	reason?: string;
	start?: string;
	stop?: string;
	message?: string;
}

const WAKE_START_DEFAULT = process.env.WAKE_START_PHRASE || "hey hermes";
const WAKE_STOP_DEFAULT = process.env.WAKE_STOP_PHRASE || "stop recording";

let wakeClient: WakeClient | null = null;
let wakeEnabled = false;
let wakeRecording = false;
let toggleWakePaused = false;
let wakeStartPhrase = WAKE_START_DEFAULT;
let wakeStopPhrase = WAKE_STOP_DEFAULT;

function wakeSocketPath(): string {
	if (process.env.WAKE_SOCKET) return process.env.WAKE_SOCKET;
	const runtime = process.env.XDG_RUNTIME_DIR || tmpdir();
	const uid = typeof process.getuid === "function" ? process.getuid() : 0;
	return join(runtime, `pi-wake-${uid}.sock`);
}

function wakePing(path: string, timeoutMs = 500): Promise<boolean> {
	return new Promise((resolve) => {
		const sock = connect(path);
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

async function resolveWakePython(): Promise<string> {
	const candidates = [
		process.env.WAKE_PYTHON,
		process.env.STT_PYTHON,
		join(homedir(), ".hermes", "hermes-agent", "venv", "bin", "python"),
		"python3",
	].filter((p): p is string => Boolean(p));
	for (const python of candidates) {
		try {
			await run(python, ["-c", "import sherpa_onnx, sounddevice, numpy"]);
			return python;
		} catch {
			/* try next */
		}
	}
	throw new Error(
		"no python with sherpa_onnx + sounddevice found (install them or set WAKE_PYTHON to the Hermes venv python)",
	);
}

async function resolveWakeScript(): Promise<string> {
	const candidates = [
		process.env.NEXUS_H2A_HOME && join(process.env.NEXUS_H2A_HOME, "skills", "speech-to-text", "scripts", "wake_daemon.py"),
		join(PKG_ROOT, "skills", "speech-to-text", "scripts", "wake_daemon.py"),
		join(agentDir(), "skills", "speech-to-text", "scripts", "wake_daemon.py"),
	].filter((p): p is string => Boolean(p));
	for (const script of candidates) {
		try {
			await access(script);
			return script;
		} catch {
			/* try next */
		}
	}
	throw new Error("wake_daemon.py not found (looked in the package and agent skill dirs)");
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function ensureWakeDaemon(): Promise<string> {
	const sock = wakeSocketPath();
	if (await wakePing(sock)) return sock;
	const python = await resolveWakePython();
	const script = await resolveWakeScript();
	const args = [script, "--socket", sock];
	if (process.env.WAKE_START_PHRASE) args.push("--start-phrase", process.env.WAKE_START_PHRASE);
	if (process.env.WAKE_STOP_PHRASE) args.push("--stop-phrase", process.env.WAKE_STOP_PHRASE);
	if (process.env.WAKE_SENSITIVITY) args.push("--sensitivity", process.env.WAKE_SENSITIVITY);
	if (process.env.WAKE_MODEL_DIR) args.push("--model-dir", process.env.WAKE_MODEL_DIR);
	if (process.env.WAKE_INPUT_DEVICE) args.push("--input-device", process.env.WAKE_INPUT_DEVICE);
	const child = spawn(python, args, { stdio: ["ignore", "ignore", "ignore"], detached: true });
	child.unref();
	for (let i = 0; i < 120; i++) {
		if (await wakePing(sock, 300)) return sock;
		await sleep(250);
	}
	throw new Error("wake daemon did not start (check the microphone and the sherpa KWS model)");
}

class WakeClient {
	private sock: ReturnType<typeof connect> | null = null;
	private buffer = "";
	onEvent: (event: WakeEvent) => void = () => {};
	onClose: () => void = () => {};
	ready = false;

	connect(path: string, timeoutMs = 3000): Promise<void> {
		return new Promise((resolve, reject) => {
			const sock = connect(path);
			sock.setEncoding("utf-8");
			let settled = false;
			const timer = setTimeout(() => {
				if (settled) return;
				settled = true;
				sock.destroy();
				reject(new Error("wake daemon connect timeout"));
			}, timeoutMs);
			sock.once("connect", () => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				this.sock = sock;
				this.ready = true;
				resolve();
			});
			sock.on("data", (chunk: string) => this.consume(chunk));
			sock.once("error", (err) => {
				if (!settled) {
					settled = true;
					clearTimeout(timer);
					reject(err);
				}
			});
			sock.once("close", () => {
				this.sock = null;
				this.ready = false;
				this.onClose();
			});
		});
	}

	private consume(chunk: string): void {
		this.buffer += chunk;
		let nl = this.buffer.indexOf("\n");
		while (nl >= 0) {
			const line = this.buffer.slice(0, nl).trim();
			this.buffer = this.buffer.slice(nl + 1);
			if (line) {
				try {
					this.onEvent(JSON.parse(line) as WakeEvent);
				} catch {
					/* ignore malformed line */
				}
			}
			nl = this.buffer.indexOf("\n");
		}
	}

	send(cmd: Record<string, unknown>): void {
		if (!this.sock) return;
		try {
			this.sock.write(`${JSON.stringify(cmd)}\n`);
		} catch {
			/* ignore */
		}
	}

	close(): void {
		const sock = this.sock;
		this.sock = null;
		this.ready = false;
		if (sock) {
			try {
				sock.end();
			} catch {
				/* ignore */
			}
		}
	}
}

function wakeResumedAfterRecording(paused: boolean): void {
	if (paused) wakeClient?.send({ cmd: "resume" });
}

/** Pause the always-on listener so an explicit recording can take the mic. */
async function pauseWakeForRecording(): Promise<boolean> {
	if (wakeClient?.ready && !wakeRecording) {
		wakeClient.send({ cmd: "pause" });
		await sleep(250); // let the daemon close its input stream
		return true;
	}
	return false;
}

async function enableWake(ctx: ExtensionContext): Promise<void> {
	if (wakeEnabled && wakeClient?.ready) {
		ctx.ui.notify(`Wake word già attivo: dì "${wakeStartPhrase}" per registrare.`, "info");
		return;
	}
	try {
		const sock = await ensureWakeDaemon();
		const client = new WakeClient();
		client.onEvent = (event) => handleWakeEvent(ctx, event);
		client.onClose = () => {
			if (wakeClient === client) {
				wakeClient = null;
				wakeEnabled = false;
				ctx.ui.setStatus("stt-wake", undefined);
			}
		};
		await client.connect(sock);
		wakeClient = client;
		wakeEnabled = true;
		client.send({ cmd: "resume" }); // arm the mic now that events are wired up
		ctx.ui.setStatus("stt-wake", ctx.ui.theme.fg("dim", "🎙 wake"));
	} catch (err) {
		ctx.ui.notify(`Wake word: ${(err as Error).message}`, "error");
	}
}

function disableWake(ctx: ExtensionContext): void {
	wakeClient?.send({ cmd: "quit" });
	wakeClient?.close();
	wakeClient = null;
	wakeEnabled = false;
	wakeRecording = false;
	hideMeter(ctx);
	ctx.ui.setStatus("stt-wake", undefined);
}

function handleWakeEvent(ctx: ExtensionContext, event: WakeEvent): void {
	switch (event.event) {
		case "ready":
			wakeStartPhrase = event.start || WAKE_START_DEFAULT;
			wakeStopPhrase = event.stop || WAKE_STOP_DEFAULT;
			ctx.ui.notify(
				`Wake word attivo: dì "${wakeStartPhrase}" per registrare, "${wakeStopPhrase}" per fermare.`,
				"info",
			);
			break;
		case "start":
			wakeRecording = true;
			showMeter(ctx, "REC (wake)");
			ctx.ui.notify(`🎤 Registrazione… dì "${wakeStopPhrase}" o premi ctrl+b per fermare`, "info");
			break;
		case "level":
			setLevel(event.rms ?? 0, event.elapsed ?? 0);
			break;
		case "stop":
			wakeRecording = false;
			hideMeter(ctx);
			if (event.audio) void transcribeWakeAudio(ctx, event.audio);
			else ctx.ui.notify("Nessun audio registrato", "warning");
			break;
		case "error":
			ctx.ui.notify(`Wake word: ${event.message}`, "error");
			break;
		default:
			break;
	}
}

async function transcribeWakeAudio(ctx: ExtensionContext, audio: string): Promise<void> {
	try {
		ctx.ui.notify("Trascrivo…", "info");
		const response = await transcribeAudio(audio, {});
		const transcript = (response.text || "").trim();
		if (!transcript) {
			ctx.ui.notify("Nessun parlato rilevato", "warning");
			return;
		}
		insertTranscript(ctx, transcript);
		ctx.ui.notify("Trascrizione inserita", "info");
	} catch (err) {
		ctx.ui.notify(`Wake STT: ${(err as Error).message}`, "error");
	} finally {
		void unlink(audio).catch(() => {});
	}
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
	pi.on("session_start", async (_event, ctx) => {
		try {
			const script = await resolveScript();
			const child = spawn("bash", [script, "--warmup"], { stdio: "ignore", detached: true });
			child.unref();
		} catch {
			/* skill not installed */
		}
		if (/^(1|true|yes|on)$/i.test(process.env.WAKE_ENABLED || "")) {
			await enableWake(ctx);
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
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const seconds = params.seconds && params.seconds > 0 ? params.seconds : 5;
			const wakePaused = await pauseWakeForRecording();
			showMeter(ctx, "REC");
			let file: string | null = null;
			try {
				file = await recordFixed(seconds);
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
				hideMeter(ctx);
				wakeResumedAfterRecording(wakePaused);
				if (file) void unlink(file).catch(() => {});
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
				const wakePaused = await pauseWakeForRecording();
				showMeter(ctx, "REC");
				let file: string | null = null;
				try {
					file = await recordFixed(seconds);
					const response = await transcribeAudio(file, { lang });
					const transcript = (response.text || "").trim();
					ctx.ui.notify(transcript ? `Transcript: ${transcript}` : "No speech detected", transcript ? "info" : "warning");
				} finally {
					hideMeter(ctx);
					wakeResumedAfterRecording(wakePaused);
					if (file) void unlink(file).catch(() => {});
				}
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
				const wakePaused = await pauseWakeForRecording();
				showMeter(ctx, "REC");
				let file: string | null = null;
				try {
					file = await recordFixed(5);
					const response = await transcribeAudio(file, {});
					const transcript = (response.text || "").trim();
					if (!transcript) {
						ctx.ui.notify("No speech detected", "warning");
						return;
					}
					insertTranscript(ctx, transcript);
					ctx.ui.notify("Transcript inserted into the editor", "info");
				} finally {
					hideMeter(ctx);
					wakeResumedAfterRecording(wakePaused);
					if (file) void unlink(file).catch(() => {});
				}
			} catch (err) {
				ctx.ui.notify(`Listen failed: ${(err as Error).message}`, "error");
			}
		},
	});

	// ctrl+b — toggle recording: start, then stop + insert transcript.
	// While a wake-word take is running it stops that instead.
	pi.registerShortcut(Key.ctrl("b"), {
		description: "Start/stop mic recording and insert transcript",
		handler: async (ctx: ExtensionContext) => {
			if (wakeRecording && wakeClient) {
				ctx.ui.notify("Fermo la registrazione…", "info");
				wakeClient.send({ cmd: "stop" });
				return;
			}
			if (activeRecording) {
				ctx.ui.notify("Processing recording…", "info");
				hideMeter(ctx);
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
				} finally {
					wakeResumedAfterRecording(toggleWakePaused);
					toggleWakePaused = false;
				}
				return;
			}
			try {
				toggleWakePaused = await pauseWakeForRecording();
				startRecording();
				showMeter(ctx, "REC");
				ctx.ui.notify(
					toggleWakePaused
						? "Recording… press ctrl+b again to stop (wake listener paused)"
						: "Recording… press ctrl+b again to stop",
					"info",
				);
			} catch (err) {
				ctx.ui.notify(`Could not start recording: ${(err as Error).message}`, "error");
			}
		},
	});

	// ctrl+shift+w — toggle hands-free wake-word listening.
	pi.registerShortcut(Key.ctrlShift("w"), {
		description: "Toggle wake-word listening (start/stop dictation by voice)",
		handler: async (ctx: ExtensionContext) => {
			if (wakeEnabled) {
				disableWake(ctx);
				ctx.ui.notify("Wake word disattivato", "info");
			} else {
				await enableWake(ctx);
			}
		},
	});

	pi.registerCommand("wake", {
		description: "Wake word: /wake on|off|start|stop|status — start/stop dictation hands-free",
		handler: async (args, ctx) => {
			const action = (args || "").trim().toLowerCase();
			if (action === "off") {
				disableWake(ctx);
				ctx.ui.notify("Wake word disattivato", "info");
				return;
			}
			if (action === "start") {
				if (!wakeClient?.ready) await enableWake(ctx);
				wakeClient?.send({ cmd: "record" });
				return;
			}
			if (action === "stop") {
				wakeClient?.send({ cmd: "stop" });
				return;
			}
			if (action === "status") {
				ctx.ui.notify(
					`Wake word: ${wakeEnabled ? "on" : "off"}${wakeRecording ? " (registrazione in corso)" : ""}` +
						(wakeEnabled ? ` — "${wakeStartPhrase}" / "${wakeStopPhrase}"` : ""),
					"info",
				);
				return;
			}
			if (!action || action === "on") {
				await enableWake(ctx);
				return;
			}
			ctx.ui.notify("Uso: /wake on|off|start|stop|status", "warning");
		},
	});

	// Clean up an in-flight recording and the wake daemon on reload/shutdown.
	pi.on("session_shutdown", async (_event, ctx) => {
		if (wakeEnabled) {
			try {
				disableWake(ctx);
			} catch {
				/* ignore */
			}
		}
		if (activeRecording) {
			try {
				await stopRecording();
			} catch {
				/* ignore */
			}
		}
	});
}
