// Source Plex.
// - Serveur : /status/sessions (toutes les lectures, tous appareils), notes, playlists, files de lecture.
// - Lecteur : API "companion" de Plexamp (port 32500) pour les commandes, le volume, le temps précis.
//   Repli : relais par le serveur (X-Plex-Target-Client-Identifier).

export interface PlexConfig {
	url: string;
	token: string;
	userToken?: string;
	clientId: string;
	playerFilter?: string;
	userFilter?: string;
	playerUrl?: string;
}

export interface PlexSession {
	state: "playing" | "paused" | "stopped";
	title: string;
	artist: string;
	album: string;
	ratingKey: string;
	parentRatingKey: string;
	thumb: string;
	viewOffset: number;
	duration: number;
	userRating: number | null;
	index: number;
	codec: string;
	bitrate: number;
	bitDepth: number;
	samplingRate: number;
	playerId: string;
	playerTitle: string;
	playerAddress: string;
	user: string;
}

export interface PlayerTimeline {
	state: "playing" | "paused" | "stopped";
	time: number;
	duration: number;
	volume: number | null;
	shuffle: boolean | null;
	repeat: "off" | "one" | "all" | null;
	ratingKey: string;
	playQueueID: string;
	playQueueItemID: string;
}

const PRODUCT = "CariMusicDeck";
export const PLEX_VERSION = "1.4.0";

export function plexHeaders(clientId: string, token?: string): Record<string, string> {
	const h: Record<string, string> = {
		Accept: "application/json",
		"X-Plex-Product": PRODUCT,
		"X-Plex-Version": PLEX_VERSION,
		"X-Plex-Client-Identifier": clientId,
		"X-Plex-Platform": "macOS",
		"X-Plex-Device-Name": "Stream Deck (CariMusicDeck)",
		"X-Plex-Provides": "controller",
	};
	if (token) h["X-Plex-Token"] = token;
	return h;
}

export const trimUrl = (u: string) => u.trim().replace(/\/+$/, "");

type Meta = Record<string, any>;

// ---------------------------------------------------------------- serveur

async function serverGet(cfg: PlexConfig, path: string, timeout = 4000): Promise<any> {
	const res = await fetch(`${trimUrl(cfg.url)}${path}`, { headers: plexHeaders(cfg.clientId, cfg.token), signal: AbortSignal.timeout(timeout) });
	if (res.status === 401) throw new Error("Jeton Plex refusé (401)");
	if (!res.ok) throw new Error(`Plex HTTP ${res.status}`);
	return res.json();
}

export async function readPlexSessions(cfg: PlexConfig): Promise<PlexSession[]> {
	const data = (await serverGet(cfg, "/status/sessions")) as { MediaContainer?: { Metadata?: Meta[] } };
	const items = data.MediaContainer?.Metadata ?? [];
	const pf = (cfg.playerFilter ?? "").trim().toLowerCase();
	const uf = (cfg.userFilter ?? "").trim().toLowerCase();
	return items
		.filter((m) => m.type === "track")
		.filter((m) => {
			if (!pf) return true;
			const p = m.Player ?? {};
			return [p.title, p.product, p.device, p.platform].some((v: unknown) => typeof v === "string" && v.toLowerCase().includes(pf));
		})
		.filter((m) => !uf || String(m.User?.title ?? "").toLowerCase().includes(uf))
		.map((m): PlexSession => {
			const s = String(m.Player?.state ?? "");
			const media = (m.Media ?? [])[0] ?? {};
			const part = (media.Part ?? [])[0] ?? {};
			const stream = (part.Stream ?? []).find((x: Meta) => x.streamType === 2) ?? {};
			return {
				state: s === "paused" ? "paused" : s === "stopped" ? "stopped" : "playing",
				title: String(m.title ?? ""),
				artist: String(m.originalTitle || m.grandparentTitle || ""),
				album: String(m.parentTitle ?? ""),
				ratingKey: String(m.ratingKey ?? ""),
				parentRatingKey: String(m.parentRatingKey ?? ""),
				thumb: String(m.parentThumb || m.thumb || m.grandparentThumb || ""),
				viewOffset: Number(m.viewOffset ?? 0),
				duration: Number(m.duration ?? media.duration ?? 0),
				userRating: m.userRating === undefined ? 0 : Number(m.userRating),
				index: Number(m.index ?? 0),
				codec: String(stream.codec || media.audioCodec || ""),
				bitrate: Number(stream.bitrate || media.bitrate || 0),
				bitDepth: Number(stream.bitDepth || 0),
				samplingRate: Number(stream.samplingRate || 0),
				playerId: String(m.Player?.machineIdentifier ?? ""),
				playerTitle: String(m.Player?.title || m.Player?.product || ""),
				playerAddress: String(m.Player?.address ?? ""),
				user: String(m.User?.title ?? ""),
			};
		})
		.filter((s) => s.state !== "stopped");
}

export async function readPlexArtwork(cfg: PlexConfig, thumb: string): Promise<Buffer | null> {
	if (!thumb) return null;
	const base = trimUrl(cfg.url);
	const tk = encodeURIComponent(cfg.token);
	const candidates = [
		`${base}/photo/:/transcode?width=1000&height=1000&minSize=1&upscale=1&url=${encodeURIComponent(thumb)}&X-Plex-Token=${tk}`,
		/^https?:\/\//.test(thumb) ? thumb : `${base}${thumb}${thumb.includes("?") ? "&" : "?"}X-Plex-Token=${tk}`,
	];
	for (const url of candidates) {
		try {
			const res = await fetch(url, { headers: { Accept: "image/*" }, signal: AbortSignal.timeout(6000) });
			if (res.ok) {
				const buf = Buffer.from(await res.arrayBuffer());
				if (buf.length > 100) return buf;
			}
		} catch {
			/* essai suivant */
		}
	}
	return null;
}

/** Note 0–10 (demi-étoiles) ; -1 efface. */
export async function rateItem(cfg: PlexConfig, ratingKey: string, rating: number): Promise<boolean> {
	try {
		const res = await fetch(
			`${trimUrl(cfg.url)}/:/rate?key=${encodeURIComponent(ratingKey)}&identifier=com.plexapp.plugins.library&rating=${rating}`,
			{ method: "PUT", headers: plexHeaders(cfg.clientId, cfg.token), signal: AbortSignal.timeout(4000) },
		);
		return res.ok;
	} catch {
		return false;
	}
}

const leafCache = new Map<string, number>();
export async function albumTrackCount(cfg: PlexConfig, parentRatingKey: string): Promise<number> {
	if (!parentRatingKey) return 0;
	if (leafCache.has(parentRatingKey)) return leafCache.get(parentRatingKey)!;
	try {
		const d = await serverGet(cfg, `/library/metadata/${parentRatingKey}`);
		const n = Number(d.MediaContainer?.Metadata?.[0]?.leafCount ?? 0);
		leafCache.set(parentRatingKey, n);
		return n;
	} catch {
		return 0;
	}
}

export interface QueueInfo {
	position: number;
	total: number;
	fromPlaylist: boolean;
}
export async function playQueueInfo(cfg: PlexConfig, pqid: string, itemId: string): Promise<QueueInfo | null> {
	if (!pqid) return null;
	try {
		const d = await serverGet(cfg, `/playQueues/${pqid}?own=1&window=0&includeBefore=0&includeAfter=0`);
		const mc = d.MediaContainer ?? {};
		const total = Number(mc.playQueueTotalCount ?? mc.size ?? 0);
		const offset = Number(mc.playQueueSelectedItemOffset ?? -1);
		const uri = String(mc.playQueueSourceURI ?? "");
		void itemId;
		return { position: offset + 1, total, fromPlaylist: /\/playlists\//.test(uri) };
	} catch {
		return null;
	}
}

let serverIdCache = "";
export async function serverMachineId(cfg: PlexConfig): Promise<string> {
	if (serverIdCache) return serverIdCache;
	const d = await serverGet(cfg, "/identity");
	serverIdCache = String(d.MediaContainer?.machineIdentifier ?? "");
	return serverIdCache;
}

export interface PlaylistItem {
	id: string;
	title: string;
	thumb: string;
}
export async function listPlexPlaylists(cfg: PlexConfig): Promise<PlaylistItem[]> {
	const d = await serverGet(cfg, "/playlists?playlistType=audio", 8000);
	return ((d.MediaContainer?.Metadata ?? []) as Meta[]).map((p) => ({
		id: String(p.ratingKey),
		title: String(p.title),
		thumb: String(p.composite || p.thumb || ""),
	}));
}

// ---------------------------------------------------------------- lecteur

let commandId = 1;

function playerHeaders(cfg: PlexConfig, playerId: string): Record<string, string> {
	return {
		...plexHeaders(cfg.clientId, cfg.userToken || cfg.token),
		"X-Plex-Target-Client-Identifier": playerId,
	};
}

function qs(params: Record<string, string | number>): string {
	return Object.entries(params)
		.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
		.join("&");
}

/** Vérifie qu'une URL répond comme le lecteur attendu (API /resources de Plexamp). */
export async function probePlayer(base: string, cfg: PlexConfig, playerId: string): Promise<boolean> {
	try {
		const res = await fetch(`${trimUrl(base)}/resources`, { headers: playerHeaders(cfg, playerId), signal: AbortSignal.timeout(1500) });
		if (!res.ok) return false;
		const text = await res.text();
		const m = text.match(/machineIdentifier"?\s*[:=]\s*"([^"]+)"/);
		return !m || !playerId || m[1] === playerId;
	} catch {
		return false;
	}
}

function attrs(tag: string): Record<string, string> {
	const o: Record<string, string> = {};
	for (const m of tag.matchAll(/(\w+)="([^"]*)"/g)) o[m[1]] = m[2].replace(/&amp;/g, "&").replace(/&quot;/g, '"');
	return o;
}

function toTimeline(t: Record<string, any>): PlayerTimeline | null {
	if (!t || !t.state) return null;
	const rep = t.repeat === undefined ? null : Number(t.repeat);
	return {
		state: t.state === "paused" ? "paused" : t.state === "stopped" ? "stopped" : "playing",
		time: Number(t.time ?? 0),
		duration: Number(t.duration ?? 0),
		volume: t.volume === undefined || t.volume === "" ? null : Number(t.volume),
		shuffle: t.shuffle === undefined ? null : String(t.shuffle) === "1" || t.shuffle === true,
		repeat: rep === null ? null : rep === 1 ? "one" : rep === 2 ? "all" : "off",
		ratingKey: String(t.ratingKey ?? ""),
		playQueueID: String(t.playQueueID ?? ""),
		playQueueItemID: String(t.playQueueItemID ?? ""),
	};
}

export async function pollTimeline(base: string, cfg: PlexConfig, playerId: string): Promise<PlayerTimeline | null> {
	const res = await fetch(`${trimUrl(base)}/player/timeline/poll?${qs({ wait: 0, includeMetadata: 0, commandID: commandId++, type: "music" })}`, {
		headers: playerHeaders(cfg, playerId),
		signal: AbortSignal.timeout(2000),
	});
	if (!res.ok) throw new Error(`Lecteur HTTP ${res.status}`);
	const text = await res.text();
	if (text.trim().startsWith("{")) {
		const j = JSON.parse(text);
		const list: Meta[] = j.MediaContainer?.Timeline ?? [];
		return toTimeline(list.find((t) => t.type === "music") ?? {});
	}
	const tag = [...text.matchAll(/<Timeline\b[^>]*>/g)].map((m) => m[0]).find((t) => /type="music"/.test(t));
	return tag ? toTimeline(attrs(tag)) : null;
}

/**
 * Envoie une commande au lecteur : d'abord en direct (base), puis via le relais serveur.
 * path ex. "/player/playback/playPause".
 */
export async function playerCommand(
	cfg: PlexConfig,
	playerId: string,
	base: string | null,
	path: string,
	params: Record<string, string | number> = {},
): Promise<boolean> {
	const query = qs({ ...params, type: "music", commandID: commandId++ });
	const targets = [base ? trimUrl(base) : null, trimUrl(cfg.url)].filter((x): x is string => !!x);
	for (const t of targets) {
		try {
			const res = await fetch(`${t}${path}?${query}`, { headers: playerHeaders(cfg, playerId), signal: AbortSignal.timeout(3000) });
			if (res.ok) return true;
		} catch {
			/* cible suivante */
		}
	}
	return false;
}

export async function playPlexPlaylist(cfg: PlexConfig, playerId: string, base: string | null, playlistId: string, shuffle: boolean): Promise<boolean> {
	const machine = await serverMachineId(cfg);
	const uri = `server://${machine}/com.plexapp.plugins.library/playlists/${playlistId}/items`;
	const res = await fetch(`${trimUrl(cfg.url)}/playQueues?${qs({ type: "audio", shuffle: shuffle ? 1 : 0, repeat: 0, continuous: 0, uri })}`, {
		method: "POST",
		headers: plexHeaders(cfg.clientId, cfg.token),
		signal: AbortSignal.timeout(6000),
	});
	if (!res.ok) return false;
	const d = (await res.json()) as { MediaContainer?: { playQueueID?: number } };
	const pq = d.MediaContainer?.playQueueID;
	if (!pq) return false;
	const u = new URL(trimUrl(cfg.url));
	return playerCommand(cfg, playerId, base, "/player/playback/playMedia", {
		key: `/playQueues/${pq}`,
		containerKey: `/playQueues/${pq}?own=1`,
		machineIdentifier: machine,
		protocol: u.protocol.replace(":", ""),
		address: u.hostname,
		port: u.port || (u.protocol === "https:" ? "443" : "80"),
		token: cfg.token,
		offset: 0,
	});
}

// ---------------------------------------------------------------- connexion plex.tv (PIN)

export interface PlexServerChoice {
	name: string;
	url: string;
	token: string;
	local: boolean;
}

export async function createPin(clientId: string): Promise<{ id: number; code: string; authUrl: string }> {
	const res = await fetch("https://plex.tv/api/v2/pins?strong=true", {
		method: "POST",
		headers: plexHeaders(clientId),
		signal: AbortSignal.timeout(8000),
	});
	if (!res.ok) throw new Error(`plex.tv HTTP ${res.status}`);
	const pin = (await res.json()) as { id: number; code: string };
	const authUrl =
		`https://app.plex.tv/auth#?clientID=${encodeURIComponent(clientId)}` +
		`&code=${encodeURIComponent(pin.code)}` +
		`&context%5Bdevice%5D%5Bproduct%5D=${encodeURIComponent(PRODUCT)}`;
	return { ...pin, authUrl };
}

export async function waitForPin(clientId: string, id: number, timeoutMs = 180_000): Promise<string> {
	const end = Date.now() + timeoutMs;
	while (Date.now() < end) {
		await new Promise((r) => setTimeout(r, 2000));
		try {
			const res = await fetch(`https://plex.tv/api/v2/pins/${id}`, { headers: plexHeaders(clientId), signal: AbortSignal.timeout(6000) });
			if (res.ok) {
				const pin = (await res.json()) as { authToken?: string | null };
				if (pin.authToken) return pin.authToken;
			}
		} catch {
			/* on réessaie */
		}
	}
	throw new Error("Délai de connexion Plex dépassé");
}

async function reachable(url: string, clientId: string, token: string): Promise<boolean> {
	try {
		const res = await fetch(`${url}/identity`, { headers: plexHeaders(clientId, token), signal: AbortSignal.timeout(2500) });
		return res.ok;
	} catch {
		return false;
	}
}

export async function discoverServers(clientId: string, userToken: string): Promise<PlexServerChoice[]> {
	const res = await fetch("https://plex.tv/api/v2/resources?includeHttps=1&includeRelay=0", {
		headers: plexHeaders(clientId, userToken),
		signal: AbortSignal.timeout(8000),
	});
	if (!res.ok) throw new Error(`plex.tv HTTP ${res.status}`);
	const resources = (await res.json()) as Meta[];
	const servers = resources.filter((r) => String(r.provides ?? "").includes("server"));
	servers.sort((a, b) => Number(!!b.owned) - Number(!!a.owned));
	const out: PlexServerChoice[] = [];
	for (const s of servers) {
		const token = String(s.accessToken || userToken);
		const conns: Meta[] = (s.connections ?? []).filter((c: Meta) => !c.relay);
		conns.sort((a, b) => Number(!!b.local) - Number(!!a.local));
		for (const c of conns) {
			const uri = trimUrl(String(c.uri));
			if (await reachable(uri, clientId, token)) {
				out.push({ name: String(s.name), url: uri, token, local: !!c.local });
				break;
			}
		}
	}
	return out;
}

export async function testPlex(cfg: PlexConfig): Promise<string> {
	const d = (await serverGet(cfg, "/")) as { MediaContainer?: { friendlyName?: string; version?: string } };
	const sessions = await readPlexSessions(cfg);
	const name = d.MediaContainer?.friendlyName ?? "serveur";
	return `${name} (v${d.MediaContainer?.version ?? "?"}) — ${sessions.length} lecture(s) musique en cours`;
}
