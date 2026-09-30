// Moteur "Now Playing" : interroge Apple Music et Plex, choisit la source active,
// fusionne l'état (temps, volume, aléatoire, répétition, note, qualité) et route les commandes.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { music, readMusic, readMusicArtworkLocal, readPlaylistArtwork, searchItunesArtwork, type MusicSnapshot } from "./music.js";
import {
	albumTrackCount,
	listPlexPlaylists,
	playerCommand,
	playPlexPlaylist,
	playQueueInfo,
	pollTimeline,
	probePlayer,
	rateItem,
	readPlexArtwork,
	readPlexSessions,
	type PlayerTimeline,
	type PlexConfig,
	type PlexServerChoice,
	type PlexSession,
	type QueueInfo,
} from "./plex.js";
import { appName, getSystemVolume, NowPlayingStream, setSystemVolume, type NPState } from "./nowplaying.js";
import { launchRadio, radioCmd, readRadio, type RadioState } from "./radio.js";
import { readSpotify, spotify, type SpotifySnapshot } from "./spotify.js";
import { accentFrom, decode } from "./render.js";

export type Img = Awaited<ReturnType<typeof decode>>;
export type SourceId = "music" | "spotify" | "plex" | "radio" | "nowplaying";
const SOURCES: SourceId[] = ["music", "spotify", "plex", "radio", "nowplaying"];

/** Apps déjà gérées par une source dédiée : ignorées par la source « À l'écoute » (pas de doublon). */
const NP_EXCLUDED = new Set(["com.apple.Music", "com.apple.iTunes", "com.spotify.client", "tv.plex.plexamp", "fr.cariboulabs.cariradio"]);

export const SOURCE_LABEL: Record<SourceId, string> = {
	music: "Apple Music",
	spotify: "Spotify",
	plex: "Plex",
	radio: "CariRadio",
	nowplaying: "À l'écoute",
};
export type Repeat = "off" | "one" | "all";

export type GlobalSettings = {
	clientId?: string;
	musicEnabled?: boolean;
	plexEnabled?: boolean;
	radioEnabled?: boolean;
	spotifyEnabled?: boolean;
	nowPlayingEnabled?: boolean;
	plexUrl?: string;
	plexToken?: string;
	plexUserToken?: string;
	plexPlayer?: string;
	plexUser?: string;
	plexPlayerUrl?: string;
	plexServers?: PlexServerChoice[];
	priority?: "recent" | SourceId;
	gapPct?: number;
	coverProgress?: boolean;
	itunesCountry?: string;
};

export interface NowState {
	src: SourceId;
	state: "playing" | "paused";
	trackId: string;
	artKey: string;
	title: string;
	artist: string;
	album: string;
	posMs: number;
	posAt: number;
	durMs: number;
	volume: number | null;
	shuffle: boolean | null;
	repeat: Repeat | null;
	rating: number | null; // 0–10 (demi-étoiles)
	favorite: boolean | null; // Apple Music uniquement
	codec: string;
	quality: string;
	position: string;
	player?: string;
	playerId?: string;
}

const ART_CACHE_MAX = 40;
const DEFAULT_ACCENT = "#FF9F0A";
const LOSSLESS = /^(flac|alac|wav|aiff|pcm|ape|wv|dsd)/i;

const khz = (hz: number) => {
	const k = hz / 1000;
	return Number.isInteger(k) ? `${k}` : k.toFixed(1);
};

type Override<T> = { v: T; until: number; track: string };

export class NowPlaying {
	global: GlobalSettings = {};
	current: NowState | null = null;
	idleArt: Img | null = null;
	plexError = "";
	musicError = "";
	log: (msg: string) => void = () => {};

	private music: MusicSnapshot | null = null;
	private musicAt = 0;
	private plex: PlexSession | null = null;
	radio: RadioState | null = null;
	private radioAt = 0;
	private spot: SpotifySnapshot | null = null;
	private spotAt = 0;
	spotifyError = "";
	np: NowPlayingStream;
	private npName = "";
	private sysVolume: number | null = null;
	private started = false;
	private plexPos = { offset: -1, at: 0 };
	private timeline: { base: string; data: PlayerTimeline; at: number } | null = null;
	private players = new Map<string, { base: string | null; at: number }>();
	private lastPlexPlayer: { id: string; base: string | null } | null = null;
	private queue = new Map<string, QueueInfo | null>();
	private leafCounts = new Map<string, number>();
	private lastStart: Record<SourceId, number> = { music: 0, spotify: 0, plex: 0, radio: 0, nowplaying: 0 };
	private prevId: Record<SourceId, string> = { music: "", spotify: "", plex: "", radio: "", nowplaying: "" };
	private art = new Map<string, Img | null>();
	private accents = new Map<string, string>();
	private loading = new Set<string>();
	private listeners = new Set<() => void>();
	private tickers = new Set<() => void>();
	private busy = { music: false, plex: false, timeline: false, radio: false, spotify: false, sysvol: false };
	private lastKey = "";
	private ov: { volume?: Override<number>; shuffle?: Override<boolean>; repeat?: Override<Repeat>; rating?: Override<number>; favorite?: Override<boolean>; state?: Override<"playing" | "paused">; pos?: Override<number> } = {};
	private preMute: number | null = null;
	private fadeTimer: NodeJS.Timeout | null = null;

	constructor(private isActive: () => boolean) {
		this.np = new NowPlayingStream(
			() => {
				const b = this.np.state?.bundleId ?? "";
				if (b && !this.npName.startsWith(`${b}|`)) void appName(b).then((n) => ((this.npName = `${b}|${n}`), this.recompute(true)));
				this.recompute();
			},
			(m) => this.log(m),
		);
	}

	onChange(fn: () => void): void {
		this.listeners.add(fn);
	}
	onTick(fn: () => void): void {
		this.tickers.add(fn);
	}
	private emit(): void {
		for (const fn of this.listeners) fn();
	}

	async init(): Promise<void> {
		try {
			this.idleArt = await decode(await readFile(fileURLToPath(new URL("../imgs/idle.png", import.meta.url))));
		} catch {
			this.idleArt = null;
		}
		setInterval(() => void this.pollMusic(), 1000);
		setInterval(() => void this.pollPlex(), 2000);
		setInterval(() => void this.pollTimeline(), 1000);
		setInterval(() => void this.pollRadio(), 1000);
		setInterval(() => void this.pollSpotify(), 1000);
		setInterval(() => void this.pollSystemVolume(), 2000);
		setInterval(() => {
			if (this.isActive()) for (const fn of this.tickers) fn();
		}, 250);
		void this.pollMusic();
		void this.pollPlex();
		void this.pollRadio();
		void this.pollSpotify();
		this.started = true;
		this.syncNowPlaying();
	}

	/** Démarre / arrête le flux « À l'écoute » selon le réglage. */
	private syncNowPlaying(): void {
		if (this.global.nowPlayingEnabled === false) this.np.stop();
		else this.np.start();
	}

	setGlobal(g: GlobalSettings): void {
		this.global = g;
		this.players.clear();
		if (this.started) this.syncNowPlaying();
		void this.pollPlex();
		void this.pollMusic();
		this.emit();
	}

	get plexConfig(): PlexConfig | null {
		const g = this.global;
		if (g.plexEnabled === false || !g.plexUrl || !g.plexToken || !g.clientId) return null;
		return {
			url: g.plexUrl,
			token: g.plexToken,
			userToken: g.plexUserToken,
			clientId: g.clientId,
			playerFilter: g.plexPlayer,
			userFilter: g.plexUser,
			playerUrl: g.plexPlayerUrl,
		};
	}

	/** undefined = en cours de chargement ; null = introuvable. */
	artFor(cur: NowState): Img | null | undefined {
		return this.art.get(cur.artKey);
	}
	get accent(): string {
		return (this.current && this.accents.get(this.current.artKey)) || DEFAULT_ACCENT;
	}

	/** Position courante interpolée (ms). */
	positionMs(): number {
		const c = this.current;
		if (!c) return 0;
		const p = c.state === "playing" ? c.posMs + (Date.now() - c.posAt) : c.posMs;
		return Math.max(0, c.durMs > 0 ? Math.min(p, c.durMs) : p);
	}

	// ------------------------------------------------------------ interrogation

	private async pollMusic(): Promise<void> {
		if (this.busy.music || !this.isActive()) return;
		this.busy.music = true;
		try {
			this.music = this.global.musicEnabled === false ? null : await readMusic();
			this.musicAt = Date.now();
			if (this.musicError) this.log("Apple Music : rétabli");
			this.musicError = "";
		} catch (e) {
			this.music = null;
			const msg = e instanceof Error ? e.message : String(e);
			if (msg !== this.musicError) {
				this.log(`Apple Music : ${msg}`);
				this.musicError = msg;
				this.emit();
			}
		} finally {
			this.busy.music = false;
		}
		this.recompute();
	}

	private async pollPlex(): Promise<void> {
		if (this.busy.plex || !this.isActive()) return;
		const cfg = this.plexConfig;
		if (!cfg) {
			this.plex = null;
			this.plexError = "";
			this.recompute();
			return;
		}
		this.busy.plex = true;
		try {
			const sessions = await readPlexSessions(cfg);
			const s = sessions.find((x) => x.state === "playing") ?? sessions[0] ?? null;
			if (s && (!this.plex || this.plex.ratingKey !== s.ratingKey || s.viewOffset !== this.plexPos.offset)) {
				this.plexPos = { offset: s.viewOffset, at: Date.now() };
			}
			this.plex = s;
			this.plexError = "";
			if (s) {
				void this.resolvePlayer(s.playerId, s.playerAddress);
				void this.loadLeafCount(cfg, s.parentRatingKey);
			}
		} catch (e) {
			this.plex = null;
			this.plexError = e instanceof Error ? e.message : String(e);
		} finally {
			this.busy.plex = false;
		}
		this.recompute();
	}

	private async pollRadio(): Promise<void> {
		if (this.busy.radio || !this.isActive()) return;
		this.busy.radio = true;
		try {
			this.radio = this.global.radioEnabled === false ? null : await readRadio();
			this.radioAt = Date.now();
		} finally {
			this.busy.radio = false;
		}
		this.recompute();
	}

	private async pollSpotify(): Promise<void> {
		if (this.busy.spotify || !this.isActive()) return;
		this.busy.spotify = true;
		try {
			this.spot = this.global.spotifyEnabled === false ? null : await readSpotify();
			this.spotAt = Date.now();
			this.spotifyError = "";
		} catch (e) {
			this.spot = null;
			const msg = e instanceof Error ? e.message : String(e);
			if (msg !== this.spotifyError) this.log(`Spotify : ${msg}`);
			this.spotifyError = msg;
		} finally {
			this.busy.spotify = false;
		}
		this.recompute();
	}

	/** Volume du Mac : suivi seulement quand la source « À l'écoute » est affichée. */
	private async pollSystemVolume(): Promise<void> {
		if (this.busy.sysvol || !this.isActive() || this.current?.src !== "nowplaying") return;
		this.busy.sysvol = true;
		try {
			const v = await getSystemVolume();
			if (v !== this.sysVolume) {
				this.sysVolume = v;
				this.recompute();
			}
		} finally {
			this.busy.sysvol = false;
		}
	}

	/** CariRadio est-elle lancée ? */
	get radioRunning(): boolean {
		return !!this.radio;
	}

	private async resolvePlayer(playerId: string, address: string): Promise<string | null> {
		const cfg = this.plexConfig;
		if (!cfg || !playerId) return null;
		const cached = this.players.get(playerId);
		if (cached && (cached.base || Date.now() - cached.at < 30_000)) return cached.base;
		this.players.set(playerId, { base: cached?.base ?? null, at: Date.now() });
		const candidates = [cfg.playerUrl, address ? `http://${address}:32500` : "", "http://127.0.0.1:32500"].filter((x): x is string => !!x);
		for (const c of [...new Set(candidates)]) {
			if (await probePlayer(c, cfg, playerId)) {
				this.players.set(playerId, { base: c, at: Date.now() });
				this.log(`Plex : lecteur ${playerId.slice(0, 8)} joignable en direct sur ${c}`);
				return c;
			}
		}
		this.players.set(playerId, { base: null, at: Date.now() });
		this.log(`Plex : lecteur ${playerId.slice(0, 8)} non joignable en direct (${candidates.join(", ")}) — relais serveur`);
		return null;
	}

	private async pollTimeline(): Promise<void> {
		const cfg = this.plexConfig;
		const s = this.plex;
		if (!cfg || !s || this.busy.timeline || !this.isActive()) return;
		const base = this.players.get(s.playerId)?.base;
		if (!base) return;
		this.busy.timeline = true;
		try {
			const t = await pollTimeline(base, cfg, s.playerId);
			if (t && t.state !== "stopped") {
				this.timeline = { base, data: t, at: Date.now() };
				const qk = `${t.playQueueID}|${t.playQueueItemID}`;
				if (t.playQueueID && !this.queue.has(qk)) {
					this.queue.set(qk, null);
					void playQueueInfo(cfg, t.playQueueID, t.playQueueItemID).then((q) => {
						this.queue.set(qk, q);
						this.recompute(true);
					});
				}
			} else this.timeline = null;
		} catch {
			this.timeline = null;
			this.players.set(s.playerId, { base: null, at: Date.now() });
		} finally {
			this.busy.timeline = false;
		}
		this.recompute();
	}

	private async loadLeafCount(cfg: PlexConfig, parentKey: string): Promise<void> {
		if (!parentKey || this.leafCounts.has(parentKey)) return;
		this.leafCounts.set(parentKey, 0);
		const n = await albumTrackCount(cfg, parentKey);
		this.leafCounts.set(parentKey, n);
		this.recompute(true);
	}

	// ------------------------------------------------------------ fusion

	private fromMusic(m: MusicSnapshot): NowState {
		const trackId = m.persistentId || `${m.artist}|${m.album}|${m.title}`;
		const k = m.kind;
		const codec = /lossless|alac/i.test(k)
			? "ALAC"
			: /aac/i.test(k)
				? "AAC"
				: /mpeg|mp3/i.test(k)
					? "MP3"
					: /wav/i.test(k)
						? "WAV"
						: /aiff/i.test(k)
							? "AIFF"
							: /flac/i.test(k)
								? "FLAC"
								: k
									? k.split(/\s+/)[0].toUpperCase().slice(0, 6)
									: "STREAM";
		const quality =
			codec === "ALAC" || codec === "WAV" || codec === "AIFF" || codec === "FLAC"
				? m.sampleRate
					? `${khz(m.sampleRate)} kHz`
					: m.bitRate
						? `${m.bitRate} kbps`
						: ""
				: m.bitRate
					? `${m.bitRate} kbps`
					: "";
		const position =
			m.playlistIsUser && m.playlistCount > 0 && m.playlistIndex > 0
				? `${m.playlistIndex}/${m.playlistCount}`
				: m.trackNumber > 0
					? m.trackCount > 0
						? `${m.trackNumber}/${m.trackCount}`
						: `${m.trackNumber}`
					: "";
		return {
			src: "music",
			state: m.state,
			trackId,
			artKey: `music:${m.album ? `${m.artist}|${m.album}` : trackId}`,
			title: m.title,
			artist: m.artist,
			album: m.album,
			posMs: m.positionMs,
			posAt: this.musicAt,
			durMs: m.durationMs,
			volume: m.volume,
			shuffle: m.shuffle,
			repeat: m.repeat,
			rating: m.rating === null ? null : Math.round(m.rating / 10),
			favorite: m.favorite,
			codec,
			quality,
			position,
		};
	}

	private fromPlex(p: PlexSession): NowState {
		const tl = this.timeline && Date.now() - this.timeline.at < 3000 && (!this.timeline.data.ratingKey || this.timeline.data.ratingKey === p.ratingKey) ? this.timeline : null;
		const codec = (p.codec || "").toUpperCase() || "—";
		const quality = LOSSLESS.test(p.codec)
			? p.bitDepth && p.samplingRate
				? `${p.bitDepth}/${khz(p.samplingRate)}`
				: p.samplingRate
					? `${khz(p.samplingRate)} kHz`
					: p.bitrate
						? `${p.bitrate} kbps`
						: ""
			: p.bitrate
				? `${p.bitrate} kbps`
				: "";
		const q = tl ? this.queue.get(`${tl.data.playQueueID}|${tl.data.playQueueItemID}`) : null;
		const leaf = this.leafCounts.get(p.parentRatingKey) ?? 0;
		const position = q?.fromPlaylist && q.total > 0 ? `${q.position}/${q.total}` : p.index > 0 ? (leaf > 0 ? `${p.index}/${leaf}` : `${p.index}`) : "";
		const state = tl ? (tl.data.state === "paused" ? "paused" : "playing") : p.state === "paused" ? "paused" : "playing";
		return {
			src: "plex",
			state,
			trackId: `${p.playerId}|${p.ratingKey}`,
			artKey: `plex:${p.thumb || p.ratingKey}`,
			title: p.title,
			artist: p.artist,
			album: p.album,
			posMs: tl ? tl.data.time : this.plexPos.offset,
			posAt: tl ? tl.at : this.plexPos.at,
			durMs: tl?.data.duration || p.duration,
			volume: tl?.data.volume ?? null,
			shuffle: tl?.data.shuffle ?? null,
			repeat: tl?.data.repeat ?? null,
			rating: p.userRating,
			favorite: null,
			codec,
			quality,
			position,
			player: p.playerTitle,
			playerId: p.playerId,
		};
	}

	private fromRadio(r: RadioState): NowState | null {
		if (r.status === "idle") return null; // appli ouverte mais jamais lancée : pas une source active
		const t = r.track;
		const start = t?.startedAt ?? 0;
		const dur = t && t.endAt > t.startedAt ? t.endAt - t.startedAt : (t?.duration ?? 0) * 1000;
		return {
			src: "radio",
			state: r.status === "paused" ? "paused" : "playing",
			trackId: `radio:${start}|${t?.title ?? ""}`,
			// pochette du morceau, sinon logo de la station (CariRadio ≥ 1.1.2 : champ artwork)
			artKey: `radio:${r.artwork || t?.cover || t?.title || r.station.name}`,
			title: t?.title || r.station.name,
			artist: t?.artist || r.station.subtitle,
			album: t?.album || `${r.station.name} ${r.station.subtitle}`.trim(),
			posMs: start ? Math.max(0, this.radioAt - start) : 0,
			posAt: this.radioAt,
			durMs: dur,
			volume: r.volume,
			shuffle: null,
			repeat: null,
			rating: null,
			favorite: t && typeof t.liked === "boolean" ? t.liked : null, // « J'aime » de CariRadio ≥ 1.3
			codec: "RADIO",
			quality: r.station.subtitle || "",
			position: r.status === "paused" ? "PAUSE" : "DIRECT",
			player: r.station.name,
		};
	}

	private fromSpotify(m: SpotifySnapshot): NowState {
		const trackId = m.id || `${m.artist}|${m.album}|${m.title}`;
		return {
			src: "spotify",
			state: m.state,
			trackId,
			artKey: `spotify:${m.artworkUrl || trackId}`,
			title: m.title,
			artist: m.artist,
			album: m.album,
			posMs: m.positionMs,
			posAt: this.spotAt,
			durMs: m.durationMs,
			volume: m.volume,
			shuffle: m.shuffle,
			repeat: m.repeat ? "all" : "off",
			rating: null,
			favorite: null,
			codec: "SPOTIFY",
			quality: "",
			position: m.trackNumber > 0 ? `${m.trackNumber}` : "",
			player: "Spotify",
		};
	}

	private fromNowPlaying(n: NPState): NowState | null {
		if (!n.bundleId || NP_EXCLUDED.has(n.bundleId) || !n.title) return null;
		const name = this.npName.startsWith(`${n.bundleId}|`) ? this.npName.split("|")[1] : n.bundleId.split(".").pop()!;
		const playing = n.playing && n.playbackRate !== 0;
		const q =
			n.totalQueueCount && n.queueIndex !== null
				? `${n.queueIndex + 1}/${n.totalQueueCount}`
				: n.trackNumber > 0
					? n.totalTrackCount > 0
						? `${n.trackNumber}/${n.totalTrackCount}`
						: `${n.trackNumber}`
					: "";
		return {
			src: "nowplaying",
			state: playing ? "playing" : "paused",
			trackId: `np:${n.bundleId}|${n.artist}|${n.album}|${n.title}`,
			artKey: `np:${n.bundleId}|${n.artworkKey || `${n.artist}|${n.album}|${n.title}`}`,
			title: n.title,
			artist: n.artist,
			album: n.album,
			posMs: n.elapsedMs,
			posAt: n.timestampMs,
			durMs: n.durationMs,
			volume: this.sysVolume, // pas de volume propre : volume du Mac
			shuffle: n.shuffleMode === null ? null : n.shuffleMode !== 1,
			repeat: n.repeatMode === null ? null : n.repeatMode === 2 ? "one" : n.repeatMode === 3 ? "all" : "off",
			rating: null,
			favorite: null,
			codec: name.toUpperCase().slice(0, 10),
			quality: "",
			position: q,
			player: name,
		};
	}

	private applyOverrides(c: NowState): NowState {
		const now = Date.now();
		const o = this.ov;
		const live = <T>(x?: Override<T>) => x && x.until > now && x.track === c.trackId;
		if (live(o.volume)) c.volume = o.volume!.v;
		if (live(o.shuffle)) c.shuffle = o.shuffle!.v;
		if (live(o.repeat)) c.repeat = o.repeat!.v;
		if (live(o.rating)) c.rating = o.rating!.v;
		if (live(o.favorite)) c.favorite = o.favorite!.v;
		if (live(o.state)) c.state = o.state!.v;
		if (live(o.pos)) {
			c.posMs = o.pos!.v;
			c.posAt = o.pos!.until - 1500;
		}
		return c;
	}

	private recompute(force = false): void {
		const now = Date.now();
		const cands: NowState[] = [];
		if (this.music) cands.push(this.applyOverrides(this.fromMusic(this.music)));
		if (this.plex) cands.push(this.applyOverrides(this.fromPlex(this.plex)));
		const rc = this.radio ? this.fromRadio(this.radio) : null;
		if (rc) cands.push(this.applyOverrides(rc));
		if (this.spot) cands.push(this.applyOverrides(this.fromSpotify(this.spot)));
		const nc = this.global.nowPlayingEnabled !== false && this.np.state ? this.fromNowPlaying(this.np.state) : null;
		if (nc) cands.push(this.applyOverrides(nc));

		for (const c of cands) {
			const id = `${c.trackId}|${c.state}`;
			if (c.state === "playing" && this.prevId[c.src] !== id) this.lastStart[c.src] = now;
			this.prevId[c.src] = id;
		}
		for (const s of SOURCES) if (!cands.some((c) => c.src === s)) this.prevId[s] = "";

		const prio = this.global.priority ?? "recent";
		const byRecent = (a: NowState, b: NowState) => this.lastStart[b.src] - this.lastStart[a.src];
		const byPrio = (a: NowState, b: NowState) =>
			prio === "recent" ? byRecent(a, b) : (b.src === prio ? 1 : 0) - (a.src === prio ? 1 : 0) || byRecent(a, b);
		const playing = cands.filter((c) => c.state === "playing").sort(byPrio);
		const paused = cands.filter((c) => c.state === "paused").sort(byRecent);
		const cur = playing[0] ?? paused[0] ?? null;

		if (cur?.src === "plex" && cur.playerId) this.lastPlexPlayer = { id: cur.playerId, base: this.players.get(cur.playerId)?.base ?? null };
		if (cur && !this.art.has(cur.artKey)) void this.loadArt(cur);

		this.current = cur;
		const key = cur
			? [cur.src, cur.trackId, cur.state, cur.artKey, cur.title, cur.volume, cur.shuffle, cur.repeat, cur.rating, cur.favorite, cur.quality, cur.position, cur.durMs].join("|")
			: "idle";
		if (force || key !== this.lastKey) {
			this.lastKey = key;
			this.emit();
		}
	}

	private async loadArt(cur: NowState): Promise<void> {
		if (this.loading.has(cur.artKey)) return;
		this.loading.add(cur.artKey);
		let buf: Buffer | null = null;
		try {
			if (cur.src === "music") {
				if ((this.music?.artworkCount ?? 0) > 0) buf = await readMusicArtworkLocal();
				if (!buf) buf = await searchItunesArtwork(cur, this.global.itunesCountry || "FR");
			} else if (cur.src === "spotify") {
				const url = this.spot?.artworkUrl;
				if (url) {
					const res = await fetch(url, { signal: AbortSignal.timeout(6000) }).catch(() => null);
					if (res?.ok) buf = Buffer.from(await res.arrayBuffer());
				}
				if (!buf) buf = await searchItunesArtwork(cur, this.global.itunesCountry || "FR");
			} else if (cur.src === "nowplaying") {
				buf = this.np.state?.artwork ?? null;
				if (!buf) buf = await searchItunesArtwork(cur, this.global.itunesCountry || "FR");
			} else if (cur.src === "radio") {
				// pochette du morceau, ou logo de la station quand le morceau n'en a pas
				const r = this.radio;
				const url = r?.artwork || r?.track?.cover;
				if (url) {
					const res = await fetch(url, { signal: AbortSignal.timeout(6000) }).catch(() => null);
					if (res?.ok) buf = Buffer.from(await res.arrayBuffer());
					// logo dans un format que jimp ne lit pas (ICO, SVG, WebP) : on tente quand même la pochette iTunes
					if (buf) await decode(buf).catch(() => (buf = null));
				}
				if (!buf && r?.track?.title) buf = await searchItunesArtwork({ artist: cur.artist, album: "", title: cur.title }, this.global.itunesCountry || "FR");
			} else {
				const cfg = this.plexConfig;
				if (cfg && this.plex) buf = await readPlexArtwork(cfg, this.plex.thumb);
			}
		} catch {
			buf = null;
		}
		let img: Img | null = null;
		if (buf) {
			try {
				img = await decode(buf);
				this.accents.set(cur.artKey, accentFrom(img));
			} catch {
				img = null;
			}
		}
		if (!img) this.log(`Pochette introuvable (${cur.src}) : ${cur.artist} — ${cur.album || cur.title}`);
		this.art.set(cur.artKey, img);
		if (this.art.size > ART_CACHE_MAX) {
			const k = this.art.keys().next().value as string;
			this.art.delete(k);
			this.accents.delete(k);
		}
		this.loading.delete(cur.artKey);
		this.emit();
	}

	// ------------------------------------------------------------ commandes

	private setOv<K extends keyof NowPlaying["ov"]>(k: K, v: NonNullable<NowPlaying["ov"][K]>["v"], ms = 3000): void {
		if (!this.current) return;
		(this.ov as Record<string, Override<unknown>>)[k] = { v, until: Date.now() + ms, track: this.current.trackId };
		this.recompute(true);
	}

	private async plexCmd(path: string, params: Record<string, string | number> = {}): Promise<boolean> {
		const cfg = this.plexConfig;
		const c = this.current;
		if (!cfg || !c?.playerId) return false;
		const base = this.players.get(c.playerId)?.base ?? (await this.resolvePlayer(c.playerId, this.plex?.playerAddress ?? ""));
		const ok = await playerCommand(cfg, c.playerId, base, path, params);
		if (!ok) this.log(`Plex : commande ${path} refusée par le lecteur`);
		setTimeout(() => {
			void this.pollTimeline();
			void this.pollPlex();
		}, 350);
		return ok;
	}

	private refreshSoon(): void {
		setTimeout(() => void this.pollMusic(), 150);
	}

	private async musicCmd(fn: () => Promise<unknown>): Promise<boolean> {
		try {
			await fn();
			this.refreshSoon();
			return true;
		} catch (e) {
			this.log(`Apple Music : ${e instanceof Error ? e.message : e}`);
			return false;
		}
	}

	private async radioCommand(path: string): Promise<boolean> {
		const ok = await radioCmd(path);
		setTimeout(() => void this.pollRadio(), 250);
		return ok;
	}

	/** Touche Radio : lance CariRadio si besoin, sinon lecture/pause. */
	async radioToggle(): Promise<boolean> {
		if (!this.radio) {
			const ok = await launchRadio(true);
			setTimeout(() => void this.pollRadio(), 1500);
			return ok;
		}
		return this.radioCommand("/toggle");
	}

	async radioShow(): Promise<boolean> {
		return this.radio ? this.radioCommand("/show") : launchRadio(false);
	}

	private async spotCmd(fn: () => Promise<unknown>): Promise<boolean> {
		try {
			await fn();
			setTimeout(() => void this.pollSpotify(), 150);
			return true;
		} catch (e) {
			this.log(`Spotify : ${e instanceof Error ? e.message : e}`);
			return false;
		}
	}

	async playPause(): Promise<boolean> {
		const c = this.current;
		if (c?.src === "spotify") {
			this.setOv("state", c.state === "playing" ? "paused" : "playing", 1500);
			return this.spotCmd(spotify.playPause);
		}
		if (c?.src === "nowplaying") {
			this.setOv("state", c.state === "playing" ? "paused" : "playing", 1500);
			return this.np.send("toggle");
		}
		if (c?.src === "radio") {
			this.setOv("state", c.state === "playing" ? "paused" : "playing", 1500);
			return this.radioCommand("/toggle");
		}
		if (c?.src === "plex") {
			const next = c.state === "playing" ? "paused" : "playing";
			this.setOv("state", next, 2500);
			return this.plexCmd(next === "paused" ? "/player/playback/pause" : "/player/playback/play");
		}
		if (this.global.musicEnabled === false) return false;
		if (c) this.setOv("state", c.state === "playing" ? "paused" : "playing", 1500);
		return this.musicCmd(music.playPause);
	}

	async stop(): Promise<boolean> {
		const c = this.current;
		if (!c) return false;
		if (c.src === "radio") return this.radioCommand("/pause");
		if (c.src === "spotify") return this.spotCmd(spotify.stop);
		if (c.src === "nowplaying") return this.np.send("pause");
		return c.src === "plex" ? this.plexCmd("/player/playback/stop") : this.musicCmd(music.stop);
	}

	async next(): Promise<boolean> {
		const c = this.current;
		if (!c) return false;
		if (c.src === "radio") return this.radioCommand("/station/next"); // radio : favori suivant de CariRadio
		if (c.src === "spotify") return this.spotCmd(spotify.next);
		if (c.src === "nowplaying") return this.np.send("next");
		return c.src === "plex" ? this.plexCmd("/player/playback/skipNext") : this.musicCmd(music.next);
	}

	/** Précédent : revient au début si > 3 s, sinon piste précédente. */
	async previous(): Promise<boolean> {
		const c = this.current;
		if (!c) return false;
		if (c.src === "radio") return this.radioCommand("/station/prev"); // radio : favori précédent de CariRadio
		if (this.positionMs() > 3000) return this.seekTo(0);
		if (c.src === "spotify") return this.spotCmd(spotify.previous);
		if (c.src === "nowplaying") return this.np.send("previous");
		return c.src === "plex" ? this.plexCmd("/player/playback/skipPrevious") : this.musicCmd(music.previous);
	}

	async seekTo(ms: number): Promise<boolean> {
		const c = this.current;
		if (!c) return false;
		if (c.src === "radio") return false; // direct : pas de recherche
		const target = Math.max(0, c.durMs > 0 ? Math.min(ms, c.durMs - 1000) : ms);
		this.setOv("pos", target, 1500);
		if (c.src === "spotify") return this.spotCmd(() => spotify.seek(target / 1000));
		if (c.src === "nowplaying") return this.np.seek(target);
		return c.src === "plex" ? this.plexCmd("/player/playback/seekTo", { offset: Math.round(target) }) : this.musicCmd(() => music.seek(target / 1000));
	}

	async seekBy(deltaMs: number): Promise<boolean> {
		return this.seekTo(this.positionMs() + deltaMs);
	}

	async setVolume(v: number): Promise<boolean> {
		const c = this.current;
		if (!c) return false;
		const vol = Math.round(Math.max(0, Math.min(100, v)));
		this.setOv("volume", vol);
		if (c.src === "radio") return this.radioCommand(`/volume?value=${vol}`);
		if (c.src === "spotify") return this.spotCmd(() => spotify.setVolume(vol));
		if (c.src === "nowplaying") {
			this.sysVolume = vol;
			return setSystemVolume(vol);
		}
		return c.src === "plex" ? this.plexCmd("/player/playback/setParameters", { volume: vol }) : this.musicCmd(() => music.setVolume(vol));
	}

	async volumeStep(delta: number): Promise<boolean> {
		const c = this.current;
		if (!c || c.volume === null) return false;
		if (this.preMute !== null && delta > 0) this.preMute = null; // monter le volume annule la sourdine
		return this.setVolume(c.volume + delta);
	}

	get muted(): boolean {
		return this.preMute !== null;
	}

	/** Maintien Volume − : sourdine + pause (fondu optionnel) ; second maintien : rétablit et relance. */
	async toggleMute(fadeSec = 0): Promise<boolean> {
		const c = this.current;
		if (!c) return false;
		if (this.fadeTimer) {
			clearInterval(this.fadeTimer);
			this.fadeTimer = null;
		}
		if (this.preMute !== null) {
			const restore = this.preMute;
			this.preMute = null;
			await this.setVolume(restore);
			if (c.state === "paused") await this.playPause();
			this.emit();
			return true;
		}
		if (c.volume === null) return this.playPause();
		this.preMute = c.volume || 50;
		const finish = async () => {
			await this.setVolume(0);
			if (this.current?.state === "playing") await this.playPause();
			this.emit();
		};
		if (fadeSec <= 0) {
			await finish();
			return true;
		}
		const start = c.volume;
		const steps = Math.max(1, Math.round(fadeSec * 5));
		let i = 0;
		this.fadeTimer = setInterval(() => {
			i++;
			if (i >= steps) {
				clearInterval(this.fadeTimer!);
				this.fadeTimer = null;
				void finish();
			} else void this.setVolume(start * (1 - i / steps));
		}, 200);
		this.emit();
		return true;
	}

	async toggleShuffle(): Promise<boolean> {
		const c = this.current;
		if (!c) return false;
		if (c.shuffle === null) return false;
		const on = !c.shuffle;
		this.setOv("shuffle", on);
		if (c.src === "spotify") return this.spotCmd(() => spotify.setShuffle(on));
		if (c.src === "nowplaying") return this.np.setShuffle(on);
		return c.src === "plex" ? this.plexCmd("/player/playback/setParameters", { shuffle: on ? 1 : 0 }) : this.musicCmd(() => music.setShuffle(on));
	}

	async cycleRepeat(): Promise<boolean> {
		const c = this.current;
		if (!c) return false;
		if (c.repeat === null) return false;
		// Spotify (AppleScript) ne connaît que « répéter » oui/non
		const next: Repeat =
			c.src === "spotify" ? (c.repeat === "off" ? "all" : "off") : c.repeat === "off" || c.repeat === null ? "all" : c.repeat === "all" ? "one" : "off";
		this.setOv("repeat", next);
		if (c.src === "spotify") return this.spotCmd(() => spotify.setRepeat(next !== "off"));
		if (c.src === "nowplaying") return this.np.setRepeat(next);
		return c.src === "plex"
			? this.plexCmd("/player/playback/setParameters", { repeat: next === "one" ? 1 : next === "all" ? 2 : 0 })
			: this.musicCmd(() => music.setRepeat(next));
	}

	private rateTimer: NodeJS.Timeout | null = null;
	/** Note 0–10 ; envoi différé (anti-rebond) pour permettre plusieurs appuis rapides. */
	setRating(r: number): void {
		const c = this.current;
		if (!c) return;
		const v = Math.max(0, Math.min(10, r));
		this.setOv("rating", v, 8000);
		if (this.rateTimer) clearTimeout(this.rateTimer);
		const src = c.src;
		const ratingKey = this.plex?.ratingKey ?? "";
		this.rateTimer = setTimeout(() => {
			if (src === "plex") {
				const cfg = this.plexConfig;
				if (cfg && ratingKey) void rateItem(cfg, ratingKey, v === 0 ? -1 : v);
			} else void this.musicCmd(() => music.setRating(v * 10));
		}, 700);
	}

	async toggleFavorite(): Promise<boolean> {
		const c = this.current;
		if (!c || c.favorite === null) return false;
		const on = !c.favorite;
		if (c.src === "radio") {
			this.setOv("favorite", on, 2500);
			return this.radioCommand("/like/toggle"); // « J'aime » de CariRadio
		}
		if (c.src !== "music") return false;
		this.setOv("favorite", on, 4000);
		return this.musicCmd(() => music.setFavorite(on));
	}

	/** Touche Station : lance une station de CariRadio (en ouvrant l'app si besoin). */
	async radioStation(id: string): Promise<boolean> {
		if (!id) return false;
		if (!this.radio) {
			if (!(await launchRadio(false))) return false;
			// l'API locale répond quelques instants après le lancement
			for (let i = 0; i < 20 && !(await readRadio()); i++) await new Promise((r) => setTimeout(r, 300));
		}
		return this.radioCommand(`/station?id=${encodeURIComponent(id)}`);
	}

	private logos = new Map<string, Promise<Img | null>>();
	/** Logo d'une station (mis en cache ; null si introuvable ou format illisible). */
	stationLogo(url: string): Promise<Img | null> {
		if (!url) return Promise.resolve(null);
		let p = this.logos.get(url);
		if (!p) {
			p = (async () => {
				try {
					const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
					return res.ok ? await decode(Buffer.from(await res.arrayBuffer())) : null;
				} catch {
					return null;
				}
			})();
			this.logos.set(url, p);
			if (this.logos.size > 60) this.logos.delete(this.logos.keys().next().value as string);
		}
		return p;
	}

	// ------------------------------------------------------------ playlists

	async listPlaylists(src: SourceId): Promise<{ id: string; title: string }[]> {
		if (src === "music") return (await music.listPlaylists()).map((n) => ({ id: n, title: n }));
		const cfg = this.plexConfig;
		if (!cfg) throw new Error("Plex n'est pas configuré");
		return (await listPlexPlaylists(cfg)).map((p) => ({ id: p.id, title: p.title }));
	}

	private plArt = new Map<string, Img | null>();
	async playlistArt(src: SourceId, id: string): Promise<Img | null> {
		const k = `${src}:${id}`;
		if (this.plArt.get(k)) return this.plArt.get(k)!;
		let buf: Buffer | null = null;
		try {
			if (src === "music") buf = await readPlaylistArtwork(id);
			else {
				const cfg = this.plexConfig;
				if (cfg) {
					const pl = (await listPlexPlaylists(cfg)).find((p) => p.id === id);
					if (pl?.thumb) buf = await readPlexArtwork(cfg, pl.thumb);
				}
			}
		} catch {
			buf = null;
		}
		const img = buf ? await decode(buf).catch(() => null) : null;
		if (img) this.plArt.set(k, img); // échec non mémorisé : nouvel essai plus tard
		return img;
	}

	async playPlaylist(src: SourceId, id: string, shuffle: boolean): Promise<boolean> {
		if (src === "spotify") return this.spotCmd(() => spotify.playUri(id, shuffle));
		if (src === "music") return this.musicCmd(() => music.playPlaylist(id, shuffle));
		const cfg = this.plexConfig;
		if (!cfg) return false;
		let target = this.plex ? { id: this.plex.playerId, base: this.players.get(this.plex.playerId)?.base ?? null } : this.lastPlexPlayer;
		if (!target && cfg.playerUrl) {
			// aucun lecteur vu : on interroge l'URL configurée pour connaître son identifiant
			try {
				const res = await fetch(`${cfg.playerUrl.replace(/\/+$/, "")}/resources`, { signal: AbortSignal.timeout(2000) });
				const m = (await res.text()).match(/machineIdentifier"?\s*[:=]\s*"([^"]+)"/);
				if (m) target = { id: m[1], base: cfg.playerUrl };
			} catch {
				/* rien */
			}
		}
		if (!target) {
			this.log("Plex : aucun lecteur connu pour lancer la playlist (lancez une lecture une fois, ou renseignez l'URL du lecteur)");
			return false;
		}
		const ok = await playPlexPlaylist(cfg, target.id, target.base, id, shuffle);
		setTimeout(() => void this.pollPlex(), 800);
		return ok;
	}

	// ------------------------------------------------------------ diagnostic

	statusText(): string {
		const c = this.current;
		const notes =
			(this.plexError ? ` · Plex : ${this.plexError}` : "") +
			(this.musicError ? ` · Apple Music : ${this.musicError}` : "") +
			(this.spotifyError ? ` · Spotify : ${this.spotifyError}` : "") +
			(this.global.nowPlayingEnabled !== false && this.np.error ? ` · À l'écoute : ${this.np.error}` : "");
		if (!c) return `Aucune lecture en cours${notes}`;
		const src =
			c.src === "radio" || c.src === "plex" || c.src === "nowplaying"
				? `${SOURCE_LABEL[c.src]}${c.player ? ` (${c.player})` : ""}`
				: SOURCE_LABEL[c.src];
		const st = c.state === "playing" ? "▶︎" : "❚❚";
		const a = this.art.get(c.artKey);
		const artNote = a === undefined ? " · pochette en chargement" : a === null ? " · pochette introuvable" : "";
		const ctrl =
			c.src === "plex"
				? this.players.get(c.playerId ?? "")?.base
					? ` · pilotage direct ${this.players.get(c.playerId ?? "")!.base}`
					: " · pilotage via le serveur (lecteur non joignable en direct)"
				: "";
		return `${st} ${src} — ${c.title}${c.artist ? ` · ${c.artist}` : ""}${artNote}${ctrl}${notes}`;
	}
}
