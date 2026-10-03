/**
 * Text-to-Speech extension for pi.
 *
 * Registers a native `speak` tool (always visible to the model) plus a `/say`
 * slash command. Synthesis and playback are delegated to the bundled
 * `text-to-speech` skill script, so there is a single source of truth.
 *
 * Languages: Italian (it), English (en), Chinese (zh), or auto-detect.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import { Key } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

type Lang = "it" | "en" | "zh";

interface SpeakDetails {
	audioPath: string;
	lang: string;
	voice?: string;
	played: boolean;
}

function agentDir(): string {
	return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

// Package root (this file lives in <pkg>/extensions/).
const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

async function resolveScript(): Promise<string> {
	const candidates = [
		process.env.NEXUS_H2A_HOME && join(process.env.NEXUS_H2A_HOME, "skills", "text-to-speech", "scripts", "say.sh"),
		join(PKG_ROOT, "skills", "text-to-speech", "scripts", "say.sh"),
		join(agentDir(), "skills", "text-to-speech", "scripts", "say.sh"),
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
		`text-to-speech: say.sh not found (looked in ${candidates.join(", ")}). Set NEXUS_H2A_HOME to the package root.`,
	);
}

// Currently playing audio process (bash wrapper owning ffplay in its process group).
let activePlayback: ChildProcess | null = null;

/** Stop the active playback (whole process group). Returns true if something was stopped. */
function stopPlayback(target?: ChildProcess): boolean {
	const child = target ?? activePlayback;
	if (!child) return false;
	const pid = child.pid;
	try {
		if (pid) process.kill(-pid, "SIGTERM");
		else child.kill("SIGTERM");
	} catch {
		try {
			child.kill("SIGTERM");
		} catch {
			/* already gone */
		}
	}
	if (activePlayback === child) activePlayback = null;
	return true;
}

function run(
	command: string,
	args: string[],
	signal?: AbortSignal,
	track = true,
): Promise<{ stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		// detached => own process group, so stopping playback also kills ffplay
		const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], detached: true });
		if (track) activePlayback = child;
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (d) => (stdout += d.toString()));
		child.stderr.on("data", (d) => (stderr += d.toString()));
		child.on("error", (err) => {
			if (activePlayback === child) activePlayback = null;
			reject(new Error(`text-to-speech: ${err.message}`));
		});
		child.on("close", (code, sig) => {
			if (activePlayback === child) activePlayback = null;
			// A stop key sends SIGTERM: treat it as a normal end, not a failure.
			if (code === 0 || sig === "SIGTERM") resolve({ stdout, stderr });
			else reject(new Error(stderr.trim() || `text-to-speech: exit code ${code}`));
		});
		const onAbort = () => stopPlayback(child);
		if (signal) {
			if (signal.aborted) onAbort();
			else signal.addEventListener("abort", onAbort, { once: true });
		}
	});
}

function buildArgs(params: {
	text: string;
	lang?: string;
	voice?: string;
	rate?: string;
	play?: boolean;
}): string[] {
	const args: string[] = [];
	if (params.lang && params.lang !== "auto") args.push("-l", params.lang);
	if (params.voice) args.push("-v", params.voice);
	if (params.rate) args.push("-r", params.rate);
	if (params.play === false) args.push("-n");
	args.push(params.text);
	return args;
}

function extractMessageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.filter((part): part is { type: string; text?: string } => !!part && typeof part === "object")
			.filter((part) => part.type === "text")
			.map((part) => part.text ?? "")
			.join("\n");
	}
	return "";
}

function lastAssistantText(ctx: ExtensionContext): string {
	const branch = ctx.sessionManager.getBranch();
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i] as { type?: string; message?: { role?: string; content?: unknown } };
		if (entry.type === "message" && entry.message?.role === "assistant") {
			const text = extractMessageText(entry.message.content);
			if (text.trim()) return text;
		}
	}
	return "";
}

/** Strip Markdown so edge-tts does not read punctuation, code or URLs aloud. */
function toSpeechText(markdown: string): string {
	return markdown
		.replace(/```[\s\S]*?```/g, " ")
		.replace(/`([^`]*)`/g, "$1")
		.replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
		.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/^\s{0,3}#{1,6}\s+/gm, "")
		.replace(/\|/g, " ")
		.replace(/[*_>~#]/g, "")
		.replace(/\s+/g, " ")
		.trim();
}

const SPEAK_DESCRIPTION =
	"Convert text to speech and play it aloud. Supports Italian (it), English (en), and Chinese (zh), with automatic language detection. " +
	"Use when the user asks to read something out loud, pronounce text, or produce a spoken audio file (\"dimmi a voce\", \"leggi ad alta voce\", " +
	"\"pronuncia\", \"text to speech\", \"TTS\"). Strip Markdown, code blocks, and URLs from the text before speaking. " +
	"Set play=false to only generate an .mp3 and return its path.";

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "speak",
		label: "Text to speech",
		description: SPEAK_DESCRIPTION,
		parameters: Type.Object({
			text: Type.String({ description: "Plain text to speak." }),
			lang: Type.Optional(
				Type.Union(
					[Type.Literal("it"), Type.Literal("en"), Type.Literal("zh"), Type.Literal("auto")],
					{ description: "Language; default auto-detect." },
				),
			),
			voice: Type.Optional(
				Type.String({ description: "Full edge-tts voice name, e.g. it-IT-DiegoNeural. Overrides lang default." }),
			),
			rate: Type.Optional(Type.String({ description: "Speaking rate, e.g. +10% or -15%. Default +0%." })),
			play: Type.Optional(Type.Boolean({ description: "Play the audio (default true). false = only save the file." })),
		}),

		async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
			if (!params.text || !params.text.trim()) {
				throw new Error("text-to-speech: 'text' must not be empty");
			}
			const script = await resolveScript();
			const played = params.play !== false;
			if (played) stopPlayback();
			const { stdout } = await run("bash", [script, ...buildArgs(params)], signal);
			const lines = stdout.trim().split("\n");
			const audioPath = (lines[lines.length - 1] || "").trim();
			const details: SpeakDetails = {
				audioPath,
				lang: params.lang && params.lang !== "auto" ? params.lang : "auto",
				voice: params.voice,
				played,
			};
			const label = played ? "Played" : "Saved";
			const voiceInfo = params.voice ? `, voice=${params.voice}` : "";
			return {
				content: [
					{
						type: "text",
						text: `${label} speech (lang=${details.lang}${voiceInfo}). Audio file: ${audioPath}`,
					},
				],
				details,
			};
		},
	});

	pi.registerCommand("say", {
		description: "Speak text aloud (it/en/zh). Usage: /say [it|en|zh] <text>",
		handler: async (args, ctx) => {
			const raw = (args || "").trim();
			if (!raw) {
				ctx.ui.notify("Usage: /say [it|en|zh] <text>", "warning");
				return;
			}
			const match = raw.match(/^(it|en|zh)\s+([\s\S]+)$/i);
			const lang = (match?.[1] as Lang | undefined)?.toLowerCase();
			const text = match ? match[2] : raw;
			try {
				const script = await resolveScript();
				stopPlayback();
				const { stdout } = await run("bash", [script, ...buildArgs({ text, lang })]);
				const audioPath = stdout.trim().split("\n").pop() || "";
				ctx.ui.notify(`Speaking (${lang ?? "auto"}): ${audioPath}`, "info");
			} catch (err) {
				ctx.ui.notify(`Say failed: ${(err as Error).message}`, "error");
			}
		},
	});

	// ctrl+shift+r — toggle: read the last assistant message / stop playback
	pi.registerShortcut(Key.ctrlShift("r"), {
		description: "Read last message aloud / stop playback",
		handler: async (ctx) => {
			if (stopPlayback()) {
				ctx.ui.notify("Playback stopped", "info");
				return;
			}
			const text = toSpeechText(lastAssistantText(ctx));
			if (!text) {
				ctx.ui.notify("Nothing to read aloud", "warning");
				return;
			}
			try {
				const script = await resolveScript();
				const { stdout } = await run("bash", [script, ...buildArgs({ text })]);
				const audioPath = stdout.trim().split("\n").pop() || "";
				ctx.ui.notify(`Reading aloud: ${audioPath}`, "info");
			} catch (err) {
				ctx.ui.notify(`Read aloud failed: ${(err as Error).message}`, "error");
			}
		},
	});
}
