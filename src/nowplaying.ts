// Source universelle « À l'écoute macOS » (MediaRemote) : Deezer, TIDAL, Qobuz (lecteur web ou pont),
// lecteurs web (Safari/Chrome), et toute app qui publie sa lecture dans le Centre de contrôle.
//
// Depuis macOS 15.4, MediaRemote est réservé aux binaires Apple : on passe par mediaremote-adapter
// (https://github.com/ungive/mediaremote-adapter, BSD-3), chargé par /usr/bin/perl (binaire Apple autorisé).
// Deux moteurs possibles :
//   1. adaptateur embarqué : <plugin>/mediaremote/MediaRemoteAdapter.framework (compilé par build.command)
//   2. repli : outil Homebrew « media-control » (brew install media-control), même format JSON
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

export interface NPState {
	bundleId: string;
	playing: boolean;
	title: string;
	artist: string;
	album: string;
	durationMs: number;
	elapsedMs: number; // au moment timestampMs
	timestampMs: number;
	playbackRate: number;
	shuffleMode: number | null; // 1 off, 2 albums, 3 pistes
	repeatMode: number | null; // 1 off, 2 un, 3 tout
	trackNumber: number;
	totalTrackCount: number;
	queueIndex: number | null;
	totalQueueCount: number | null;
	artwork: Buffer | null;
	artworkKey: string;
}

type Backend =
	| { kind: "adapter"; perl: string; script: string; framework: string }
	| { kind: "media-control"; bin: string };

const pluginPath = (rel: string) => fileURLToPath(new URL(`../${rel}`, import.meta.url));

export function findBackend(): Backend | null {
	const framework = pluginPath("mediaremote/MediaRemoteAdapter.framework");
	const script = pluginPath("mediaremote/mediaremote-adapter.pl");
	if (existsSync(`${framework}/MediaRemoteAdapter`) && existsSync(script)) return { kind: "adapter", perl: "/usr/bin/perl", script, framework };
	for (const bin of ["/opt/homebrew/bin/media-control", "/usr/local/bin/media-control"]) if (existsSync(bin)) return { kind: "media-control", bin };
	return null;
}

export const backendLabel = (b: Backend | null) =>
	!b ? "indisponible" : b.kind === "adapter" ? "adaptateur embarqué" : `media-control (${b.bin})`;

type Raw = Record<string, unknown>;

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Flux continu (processus perl ou media-control), relancé automatiquement. */
export class NowPlayingStream {
	state: NPState | null = null;
	error = "";
	backend: Backend | null = null;
	private raw: Raw = {};
	private proc: ChildProcess | null = null;
	private buf = "";
	private restarts = 0;
	private timer: NodeJS.Timeout | null = null;
	private running = false;

	constructor(
		private onChange: () => void,
		private log: (m: string) => void,
	) {}

	start(): void {
		if (this.running) return;
		this.running = true;
		this.spawn();
	}

	stop(): void {
		this.running = false;
		if (this.timer) clearTimeout(this.timer);
		this.proc?.kill();
		this.proc = null;
		this.raw = {};
		this.state = null;
	}

	private spawn(): void {
		this.backend = findBackend();
		const b = this.backend;
		if (!b) {
			this.error = "moteur « À l'écoute » absent (build.command ou brew install media-control)";
			this.retry(60_000);
			return;
		}
		const args =
			b.kind === "adapter" ? [b.script, b.framework, "stream", "--micros", "--debounce=100"] : ["stream", "--micros", "--debounce=100"];
		const p = spawn(b.kind === "adapter" ? b.perl : b.bin, args, { stdio: ["ignore", "pipe", "pipe"] });
		this.proc = p;
		this.buf = "";
		let stderr = "";
		p.stdout!.setEncoding("utf8");
		p.stdout!.on("data", (chunk: string) => {
			this.buf += chunk;
			let i: number;
			while ((i = this.buf.indexOf("\n")) >= 0) {
				const line = this.buf.slice(0, i).trim();
				this.buf = this.buf.slice(i + 1);
				if (line) this.handle(line);
			}
		});
		p.stderr!.on("data", (d) => (stderr += String(d)).slice(-2000));
		p.on("error", (e) => {
			this.error = e.message;
		});
		p.on("exit", (code) => {
			if (this.proc !== p) return;
			this.proc = null;
			if (!this.running) return;
			this.error = `moteur arrêté (code ${code})${stderr ? ` : ${stderr.trim().split("\n").pop()}` : ""}`;
			this.log(`À l'écoute : ${this.error}`);
			this.raw = {};
			this.state = null;
			this.onChange();
			this.retry(Math.min(60_000, 2000 * 2 ** this.restarts++));
		});
	}

	private retry(ms: number): void {
		if (this.timer) clearTimeout(this.timer);
		this.timer = setTimeout(() => this.running && this.spawn(), ms);
	}

	private handle(line: string): void {
		let msg: { type?: string; diff?: boolean; payload?: Raw };
		try {
			msg = JSON.parse(line);
		} catch {
			return;
		}
		if (msg.type !== "data") return;
		this.restarts = 0;
		this.error = "";
		const payload = msg.payload ?? {};
		if (msg.diff) {
			for (const [k, v] of Object.entries(payload)) {
				if (v === null) delete this.raw[k];
				else this.raw[k] = v;
			}
		} else {
			// Nouveau média : on garde la pochette précédente si l'app ne l'a pas encore renvoyée
			const prevArt = this.raw.artworkData;
			this.raw = { ...payload };
			if (!this.raw.artworkData && prevArt && payload.title === undefined) this.raw.artworkData = prevArt;
		}
		this.state = this.toState(this.raw);
		this.onChange();
	}

	private lastArtData = "";
	private lastArt: Buffer | null = null;

	private toState(r: Raw): NPState | null {
		if (!r.title && !r.bundleIdentifier) return null;
		const micros = (k: string, secKey: string) => {
			const m = num(r[k]);
			if (m !== null) return m / 1000;
			const s = num(r[secKey]);
			return s !== null ? s * 1000 : 0;
		};
		let ts = num(r.timestampEpochMicros);
		let timestampMs = ts !== null ? ts / 1000 : typeof r.timestamp === "string" ? Date.parse(r.timestamp) : Date.now();
		if (!Number.isFinite(timestampMs)) timestampMs = Date.now();
		const artData = typeof r.artworkData === "string" ? r.artworkData : "";
		if (artData !== this.lastArtData) {
			this.lastArtData = artData;
			this.lastArt = artData ? Buffer.from(artData, "base64") : null;
		}
		return {
			bundleId: String(r.bundleIdentifier ?? r.parentApplicationBundleIdentifier ?? ""),
			playing: !!r.playing,
			title: String(r.title ?? ""),
			artist: String(r.artist ?? ""),
			album: String(r.album ?? ""),
			durationMs: micros("durationMicros", "duration"),
			elapsedMs: micros("elapsedTimeMicros", "elapsedTime"),
			timestampMs,
			playbackRate: num(r.playbackRate) ?? (r.playing ? 1 : 0),
			shuffleMode: num(r.shuffleMode),
			repeatMode: num(r.repeatMode),
			trackNumber: num(r.trackNumber) ?? 0,
			totalTrackCount: num(r.totalTrackCount) ?? 0,
			queueIndex: num(r.queueIndex),
			totalQueueCount: num(r.totalQueueCount),
			artwork: this.lastArt,
			artworkKey: artData ? `${artData.length}:${artData.slice(-64)}` : "",
		};
	}

	// ------------------------------------------------------------ commandes

	private exec(args: string[]): Promise<boolean> {
		const b = this.backend ?? findBackend();
		if (!b) return Promise.resolve(false);
		const [cmd, full] = b.kind === "adapter" ? [b.perl, [b.script, b.framework, ...args]] : [b.bin, args];
		return new Promise((resolve) => execFile(cmd, full, { timeout: 5000 }, (err) => resolve(!err)));
	}

	/** Commandes MRCommand : 0 play, 1 pause, 2 bascule, 3 stop, 4 suivant, 5 précédent (mêmes ID pour les deux moteurs). */
	send(cmd: "play" | "pause" | "toggle" | "stop" | "next" | "previous"): Promise<boolean> {
		const ids = { play: 0, pause: 1, toggle: 2, stop: 3, next: 4, previous: 5 };
		return this.exec(["send", String(ids[cmd])]);
	}

	/** Position absolue, en microsecondes. */
	seek(ms: number): Promise<boolean> {
		const micros = String(Math.round(ms * 1000));
		return this.exec(this.backend?.kind === "media-control" ? ["seek", "--micros", micros] : ["seek", micros]);
	}

	setShuffle(on: boolean): Promise<boolean> {
		if (this.backend?.kind === "media-control") return this.exec(["shuffle", on ? "tracks" : "off"]);
		return this.exec(["shuffle", on ? "3" : "1"]);
	}

	setRepeat(mode: "off" | "one" | "all"): Promise<boolean> {
		if (this.backend?.kind === "media-control") return this.exec(["repeat", mode === "one" ? "track" : mode === "all" ? "playlist" : "off"]);
		return this.exec(["repeat", mode === "one" ? "2" : mode === "all" ? "3" : "1"]);
	}
}

// ------------------------------------------------------------ nom d'app & volume du Mac

const KNOWN: Record<string, string> = {
	"com.deezer.deezer-desktop": "Deezer",
	"com.deezer.Deezer": "Deezer",
	"com.tidal.desktop": "TIDAL",
	"com.qobuz.QobuzDesktop": "Qobuz",
	"com.qobuz.desktop": "Qobuz",
	"com.apple.Safari": "Safari",
	"com.google.Chrome": "Chrome",
	"org.mozilla.firefox": "Firefox",
	"company.thebrowser.Browser": "Arc",
	"com.microsoft.edgemac": "Edge",
	"com.brave.Browser": "Brave",
	"com.apple.podcasts": "Podcasts",
	"com.amazon.music": "Amazon Music",
	"com.google.android.youtube.music": "YouTube Music",
};
const names = new Map<string, string>();

/** Nom lisible de l'app (table connue, sinon Spotlight, sinon dernier segment de l'identifiant). */
export async function appName(bundleId: string): Promise<string> {
	if (!bundleId) return "App";
	if (KNOWN[bundleId]) return KNOWN[bundleId];
	if (names.has(bundleId)) return names.get(bundleId)!;
	const fallback = bundleId.split(".").pop()!.replace(/^./, (c) => c.toUpperCase());
	names.set(bundleId, fallback);
	await new Promise<void>((resolve) =>
		execFile("/usr/bin/mdfind", [`kMDItemCFBundleIdentifier == '${bundleId.replace(/'/g, "")}'`], { timeout: 3000 }, (err, out) => {
			const p = !err && out.split("\n").find((l) => l.endsWith(".app"));
			if (p) names.set(bundleId, p.split("/").pop()!.replace(/\.app$/, ""));
			resolve();
		}),
	);
	return names.get(bundleId)!;
}

/** Volume de sortie du Mac (0–100) — utilisé pour les sources sans volume propre. */
export function getSystemVolume(): Promise<number | null> {
	return new Promise((resolve) =>
		execFile("/usr/bin/osascript", ["-e", "output volume of (get volume settings)"], { timeout: 3000 }, (err, out) => {
			const v = parseInt(String(out).trim(), 10);
			resolve(err || !Number.isFinite(v) ? null : v);
		}),
	);
}

export function setSystemVolume(v: number): Promise<boolean> {
	return new Promise((resolve) =>
		execFile("/usr/bin/osascript", ["-e", `set volume output volume ${Math.round(Math.max(0, Math.min(100, v)))}`], { timeout: 3000 }, (err) =>
			resolve(!err),
		),
	);
}
