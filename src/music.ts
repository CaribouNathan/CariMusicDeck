// Source Apple Music (Music.app, macOS) via AppleScript.
// NB : les variables AppleScript sont préfixées "cari" pour ne jamais heurter un mot réservé
// (ex. "st" = suffixe ordinal de « 1st »).
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export interface MusicSnapshot {
	state: "playing" | "paused";
	title: string;
	artist: string;
	album: string;
	persistentId: string;
	artworkCount: number;
	positionMs: number;
	durationMs: number;
	volume: number;
	shuffle: boolean;
	repeat: "off" | "one" | "all";
	rating: number | null; // 0–100, null = non gérée
	kind: string;
	bitRate: number;
	sampleRate: number;
	trackNumber: number;
	trackCount: number;
	playlistName: string;
	playlistIsUser: boolean;
	playlistIndex: number;
	playlistCount: number;
	favorite: boolean | null; // favori (macOS 14+ « favorited », sinon « loved »)
}

const SEP = String.fromCharCode(31);
const OSASCRIPT = "/usr/bin/osascript";

export class MusicError extends Error {
	constructor(
		message: string,
		readonly code: "permission" | "timeout" | "script",
	) {
		super(message);
	}
}

function osascript(script: string, args: string[] = [], timeout = 90_000): Promise<string> {
	// Timeout long : la première exécution affiche la demande d'autorisation macOS et bloque jusqu'à la réponse.
	return new Promise((resolve, reject) => {
		execFile(OSASCRIPT, ["-e", script, ...args], { timeout, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
			if (!err) return resolve(stdout.replace(/\n$/, ""));
			const msg = `${stderr || err.message}`.trim();
			if (/-1743|not authori[sz]ed|pas autoris/i.test(msg))
				reject(new MusicError("Accès à Musique refusé : Réglages Système › Confidentialité et sécurité › Automatisation › Stream Deck › Musique", "permission"));
			else if ((err as { killed?: boolean }).killed) reject(new MusicError("AppleScript sans réponse (délai dépassé)", "timeout"));
			else reject(new MusicError(`AppleScript : ${msg}`, "script"));
		});
	});
}

/** Enveloppe : n'exécute le corps que si Music tourne (ne le lance jamais). */
const whenRunning = (body: string, otherwise = `return "off"`) => `
if application "Music" is running then
	tell application "Music"
${body}
	end tell
else
	${otherwise}
end if
`;

// Valeurs numériques converties en entiers (ms, via div — opérateur natif, pas d'OSAX) : pas de virgule décimale selon la langue.
const STATE_SCRIPT = whenRunning(`
		set cariPlayerState to player state
		if cariPlayerState is playing or cariPlayerState is fast forwarding or cariPlayerState is rewinding then
			set cariStateText to "playing"
		else if cariPlayerState is paused then
			set cariStateText to "paused"
		else
			return "stopped"
		end if
		set cariSep to (character id 31)
		set cariName to ""
		set cariArtist to ""
		set cariAlbum to ""
		set cariPid to ""
		set cariArtCount to 0
		set cariDur to 0
		set cariRating to -1
		set cariKind to ""
		set cariBitRate to 0
		set cariSampleRate to 0
		set cariTrackNo to 0
		set cariTrackCount to 0
		set cariIndex to 0
		set cariFav to "-1"
		try
			set cariTrack to current track
			try
				set cariName to name of cariTrack
			end try
			try
				set cariArtist to artist of cariTrack
			end try
			try
				set cariAlbum to album of cariTrack
			end try
			try
				set cariPid to persistent ID of cariTrack
			end try
			try
				set cariArtCount to count of artworks of cariTrack
			end try
			try
				set cariDur to ((duration of cariTrack) * 1000) div 1
			end try
			try
				set cariRating to rating of cariTrack
			end try
			try
				set cariKind to kind of cariTrack
			end try
			try
				set cariBitRate to bit rate of cariTrack
			end try
			try
				set cariSampleRate to sample rate of cariTrack
			end try
			try
				set cariTrackNo to track number of cariTrack
			end try
			try
				set cariTrackCount to track count of cariTrack
			end try
			try
				set cariIndex to index of cariTrack
			end try
			try
				if favorited of cariTrack then
					set cariFav to "1"
				else
					set cariFav to "0"
				end if
			on error
				try
					if loved of cariTrack then
						set cariFav to "1"
					else
						set cariFav to "0"
					end if
				end try
			end try
		end try
		if cariName is "" then
			try
				set cariName to current stream title
			end try
		end if
		set cariPos to 0
		try
			set cariPos to ((player position) * 1000) div 1
		end try
		set cariVol to sound volume
		set cariShuffle to "0"
		try
			if shuffle enabled then set cariShuffle to "1"
		end try
		set cariRepeat to "off"
		try
			set cariRep to song repeat
			if cariRep is one then
				set cariRepeat to "one"
			else if cariRep is all then
				set cariRepeat to "all"
			end if
		end try
		set cariPlName to ""
		set cariPlUser to "0"
		set cariPlCount to 0
		try
			set cariPl to current playlist
			set cariPlName to name of cariPl
			if (special kind of cariPl) is none and (class of cariPl) is user playlist then set cariPlUser to "1"
			if cariPlUser is "1" then set cariPlCount to count of tracks of cariPl
		end try
		return cariStateText & cariSep & cariName & cariSep & cariArtist & cariSep & cariAlbum & cariSep & cariPid & cariSep & (cariArtCount as text) & cariSep & (cariPos as text) & cariSep & (cariDur as text) & cariSep & (cariVol as text) & cariSep & cariShuffle & cariSep & cariRepeat & cariSep & (cariRating as text) & cariSep & cariKind & cariSep & (cariBitRate as text) & cariSep & (cariSampleRate as text) & cariSep & (cariTrackNo as text) & cariSep & (cariTrackCount as text) & cariSep & cariPlName & cariSep & cariPlUser & cariSep & (cariIndex as text) & cariSep & (cariPlCount as text) & cariSep & cariFav`);

const int = (s: string | undefined) => {
	const n = parseInt(String(s ?? "").replace(/[^\d-]/g, ""), 10);
	return Number.isFinite(n) ? n : 0;
};

export async function readMusic(): Promise<MusicSnapshot | null> {
	const out = await osascript(STATE_SCRIPT);
	if (out === "off" || out === "stopped" || out === "") return null;
	const f = out.split(SEP);
	const rating = int(f[11]);
	return {
		state: f[0] === "paused" ? "paused" : "playing",
		title: f[1] ?? "",
		artist: f[2] ?? "",
		album: f[3] ?? "",
		persistentId: f[4] ?? "",
		artworkCount: int(f[5]),
		positionMs: int(f[6]),
		durationMs: int(f[7]),
		volume: int(f[8]),
		shuffle: f[9] === "1",
		repeat: f[10] === "one" ? "one" : f[10] === "all" ? "all" : "off",
		rating: rating < 0 ? null : rating,
		kind: f[12] ?? "",
		bitRate: int(f[13]),
		sampleRate: int(f[14]),
		trackNumber: int(f[15]),
		trackCount: int(f[16]),
		playlistName: f[17] ?? "",
		playlistIsUser: f[18] === "1",
		playlistIndex: int(f[19]),
		playlistCount: int(f[20]),
		favorite: f[21] === "1" ? true : f[21] === "0" ? false : null,
	};
}

// ---------------------------------------------------------------- pochettes

const ART_TMP = path.join(os.tmpdir(), "fr.cariboulabs.caricover-music-art.bin");
const PL_ART_TMP = path.join(os.tmpdir(), "fr.cariboulabs.caricover-playlist-art.bin");

const WRITE_ART = `
	set cariFile to open for access (POSIX file cariOutPath) with write permission
	try
		set eof cariFile to 0
		write cariArtData to cariFile
		close access cariFile
	on error cariErr
		try
			close access cariFile
		end try
		error cariErr
	end try
	return "ok"`;

const ARTWORK_SCRIPT = `
on run argv
	set cariOutPath to item 1 of argv
	tell application "Music"
		set cariArtData to raw data of artwork 1 of current track
	end tell
${WRITE_ART}
end run
`;

const PLAYLIST_ARTWORK_SCRIPT = `
on run argv
	set cariOutPath to item 1 of argv
	set cariName to item 2 of argv
	if application "Music" is not running then return "off"
	tell application "Music"
		set cariArtData to raw data of artwork 1 of track 1 of user playlist cariName
	end tell
${WRITE_ART}
end run
`;

async function artToFile(script: string, args: string[], file: string): Promise<Buffer | null> {
	try {
		const r = await osascript(script, [file, ...args], 10_000);
		if (r !== "ok") return null;
		const buf = await readFile(file);
		return buf.length > 100 ? buf : null;
	} catch {
		return null;
	}
}

/** Pochette locale ; null si Music ne la fournit pas (titres en streaming hors bibliothèque sous Tahoe). */
export const readMusicArtworkLocal = () => artToFile(ARTWORK_SCRIPT, [], ART_TMP);
export const readPlaylistArtwork = (name: string) => artToFile(PLAYLIST_ARTWORK_SCRIPT, [name], PL_ART_TMP);

const norm = (s: string) =>
	s
		.toLowerCase()
		.normalize("NFD")
		.replace(/[̀-ͯ]/g, "")
		.replace(/\s*[([].*?[)\]]\s*/g, " ")
		.replace(/[^a-z0-9]+/g, " ")
		.trim();

/** Repli : recherche iTunes Search API (catalogue Apple), pochette 1000 px. */
export async function searchItunesArtwork(m: { artist: string; album: string; title: string }, country = "FR"): Promise<Buffer | null> {
	const entity = m.album ? "album" : "song";
	const term = [m.artist, m.album || m.title].filter(Boolean).join(" ");
	if (!term) return null;
	const url = `https://itunes.apple.com/search?term=${encodeURIComponent(term)}&entity=${entity}&limit=15&country=${country}`;
	try {
		const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
		if (!res.ok) return null;
		const data = (await res.json()) as { results?: Array<Record<string, string>> };
		const results = data.results ?? [];
		if (!results.length) return null;
		const wantAlbum = norm(m.album);
		const wantArtist = norm(m.artist);
		const score = (r: Record<string, string>) =>
			(wantAlbum && norm(r.collectionName ?? "") === wantAlbum ? 4 : 0) +
			(wantAlbum && norm(r.collectionName ?? "").includes(wantAlbum) ? 1 : 0) +
			(wantArtist && norm(r.artistName ?? "") === wantArtist ? 2 : 0) +
			(!m.album && norm(r.trackName ?? "") === norm(m.title) ? 3 : 0);
		const best = [...results].sort((a, b) => score(b) - score(a))[0];
		const art = best.artworkUrl100?.replace(/\/\d+x\d+bb\./, "/1000x1000bb.");
		if (!art) return null;
		const img = await fetch(art, { signal: AbortSignal.timeout(6000) });
		return img.ok ? Buffer.from(await img.arrayBuffer()) : null;
	} catch {
		return null;
	}
}

// ---------------------------------------------------------------- commandes

const run = (body: string) => osascript(whenRunning(body, `return "off"`), [], 10_000);

export const music = {
	playPause: () => run(`playpause`),
	play: () => run(`play`),
	pause: () => run(`pause`),
	stop: () => run(`stop`),
	next: () => run(`next track`),
	previous: () => run(`previous track`),
	seek: (sec: number) => run(`set player position to ${Math.max(0, sec).toFixed(2)}`),
	setVolume: (v: number) => run(`set sound volume to ${Math.round(Math.max(0, Math.min(100, v)))}`),
	setShuffle: (on: boolean) => run(`set shuffle enabled to ${on}`),
	setRepeat: (r: "off" | "one" | "all") => run(`set song repeat to ${r}`),
	setFavorite: (on: boolean) =>
		run(`try
			set favorited of current track to ${on}
		on error
			set loved of current track to ${on}
		end try`),
	setRating: (r100: number) => run(`set rating of current track to ${Math.round(Math.max(0, Math.min(100, r100)))}`),
	async listPlaylists(): Promise<string[]> {
		const out = await osascript(
			whenRunning(
				`
		set cariNames to name of every user playlist whose special kind is none
		set AppleScript's text item delimiters to (character id 31)
		set cariOut to cariNames as text
		set AppleScript's text item delimiters to ""
		return cariOut`,
				`error "Music n'est pas ouvert"`,
			),
			[],
			20_000,
		);
		return out ? out.split(SEP).filter(Boolean) : [];
	},
	async playPlaylist(name: string, shuffle: boolean): Promise<void> {
		await osascript(
			`on run argv
	set cariName to item 1 of argv
	set cariShuffle to ((item 2 of argv) is "1")
	tell application "Music"
		set shuffle enabled to cariShuffle
		play user playlist cariName
	end tell
end run`,
			[name, shuffle ? "1" : "0"],
			20_000,
		);
	},
};
