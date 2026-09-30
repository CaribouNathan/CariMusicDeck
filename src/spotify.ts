// Source Spotify (app macOS) via AppleScript.
// Variables AppleScript préfixées "spot" (aucun risque de mot réservé) ; nombres convertis en entiers (div 1).
import { execFile } from "node:child_process";

export interface SpotifySnapshot {
	state: "playing" | "paused";
	title: string;
	artist: string;
	album: string;
	id: string;
	artworkUrl: string;
	positionMs: number;
	durationMs: number;
	volume: number;
	shuffle: boolean;
	repeat: boolean;
	trackNumber: number;
}

const SEP = String.fromCharCode(31);

function osascript(script: string, args: string[] = [], timeout = 90_000): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile("/usr/bin/osascript", ["-e", script, ...args], { timeout }, (err, stdout, stderr) => {
			if (!err) return resolve(stdout.replace(/\n$/, ""));
			const msg = `${stderr || err.message}`.trim();
			if (/-1743|not authori[sz]ed|pas autoris/i.test(msg))
				reject(new Error("Accès à Spotify refusé : Réglages Système › Confidentialité et sécurité › Automatisation › Stream Deck › Spotify"));
			else reject(new Error(`AppleScript : ${msg}`));
		});
	});
}

const whenRunning = (body: string) => `
if application "Spotify" is running then
	tell application "Spotify"
${body}
	end tell
else
	return "off"
end if
`;

const STATE_SCRIPT = whenRunning(`
		set spotState to player state
		if spotState is playing then
			set spotStateText to "playing"
		else if spotState is paused then
			set spotStateText to "paused"
		else
			return "stopped"
		end if
		set spotSep to (character id 31)
		set spotName to ""
		set spotArtist to ""
		set spotAlbum to ""
		set spotId to ""
		set spotArt to ""
		set spotDur to 0
		set spotNo to 0
		try
			set spotTrack to current track
			try
				set spotName to name of spotTrack
			end try
			try
				set spotArtist to artist of spotTrack
			end try
			try
				set spotAlbum to album of spotTrack
			end try
			try
				set spotId to id of spotTrack
			end try
			try
				set spotArt to artwork url of spotTrack
			end try
			try
				set spotDur to (duration of spotTrack) div 1
			end try
			try
				set spotNo to track number of spotTrack
			end try
		end try
		set spotPos to 0
		try
			set spotPos to ((player position) * 1000) div 1
		end try
		set spotVol to 0
		try
			set spotVol to sound volume
		end try
		set spotShuffle to "0"
		try
			if shuffling then set spotShuffle to "1"
		end try
		set spotRepeat to "0"
		try
			if repeating then set spotRepeat to "1"
		end try
		return spotStateText & spotSep & spotName & spotSep & spotArtist & spotSep & spotAlbum & spotSep & spotId & spotSep & spotArt & spotSep & (spotPos as text) & spotSep & (spotDur as text) & spotSep & (spotVol as text) & spotSep & spotShuffle & spotSep & spotRepeat & spotSep & (spotNo as text)`);

const int = (s: string | undefined) => {
	const n = parseInt(String(s ?? "").replace(/[^\d-]/g, ""), 10);
	return Number.isFinite(n) ? n : 0;
};

export async function readSpotify(): Promise<SpotifySnapshot | null> {
	const out = await osascript(STATE_SCRIPT);
	if (out === "off" || out === "stopped" || !out) return null;
	const f = out.split(SEP);
	return {
		state: f[0] === "paused" ? "paused" : "playing",
		title: f[1] ?? "",
		artist: f[2] ?? "",
		album: f[3] ?? "",
		id: f[4] ?? "",
		artworkUrl: f[5] ?? "",
		positionMs: int(f[6]),
		durationMs: int(f[7]), // Spotify donne la durée en ms
		volume: int(f[8]),
		shuffle: f[9] === "1",
		repeat: f[10] === "1",
		trackNumber: int(f[11]),
	};
}

const run = (body: string) => osascript(whenRunning(body), [], 10_000);

/** Accepte une URI (spotify:playlist:…) ou un lien open.spotify.com. */
export function toSpotifyUri(input: string): string {
	const s = input.trim();
	if (s.startsWith("spotify:")) return s;
	const m = s.match(/open\.spotify\.com\/(?:intl-[a-z]+\/)?(playlist|album|artist|track|show|episode)\/([A-Za-z0-9]+)/);
	return m ? `spotify:${m[1]}:${m[2]}` : s;
}

export const spotify = {
	playPause: () => run(`playpause`),
	stop: () => run(`pause`),
	next: () => run(`next track`),
	previous: () => run(`previous track`),
	seek: (sec: number) => run(`set player position to ${Math.max(0, sec).toFixed(2)}`),
	setVolume: (v: number) => run(`set sound volume to ${Math.round(Math.max(0, Math.min(100, v)))}`),
	setShuffle: (on: boolean) => run(`set shuffling to ${on}`),
	setRepeat: (on: boolean) => run(`set repeating to ${on}`),
	async playUri(uri: string, shuffle: boolean): Promise<void> {
		await osascript(
			`on run argv
	set spotUri to item 1 of argv
	set spotShuffle to ((item 2 of argv) is "1")
	tell application "Spotify"
		set shuffling to spotShuffle
		play track spotUri
	end tell
end run`,
			[toSpotifyUri(uri), shuffle ? "1" : "0"],
			20_000,
		);
	},
};
