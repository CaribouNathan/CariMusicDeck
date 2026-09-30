// Source CariRadio (lecteur de radios Caribou Labs) : API locale http://127.0.0.1:32700.
import { execFile } from "node:child_process";

export const RADIO_URL = "http://127.0.0.1:32700";
const BUNDLE_ID = "fr.cariboulabs.cariradio";

export interface RadioTrack {
	title: string;
	artist: string;
	album: string;
	cover: string;
	startedAt: number;
	endAt: number;
	duration: number;
	/** CariRadio ≥ 1.1.2 : true si `cover` est le logo de la station */
	coverIsStation?: boolean;
	/** CariRadio ≥ 1.3 : morceau dans les « J'aime » */
	liked?: boolean;
}

export interface RadioStation {
	id: string;
	name: string;
	subtitle: string;
	favicon: string;
}

export interface RadioState {
	status: "idle" | "loading" | "playing" | "paused" | "error";
	volume: number;
	station: { name: string; subtitle: string; id?: string; favicon?: string };
	track: RadioTrack | null;
	/** CariRadio ≥ 1.1.2 : pochette du morceau, sinon logo de la station */
	artwork?: string;
	/** CariRadio ≥ 1.1 : favoris (dans l'ordre du menu Stations) */
	favorites?: RadioStation[];
}

/** null = CariRadio n'est pas lancée. */
export async function readRadio(): Promise<RadioState | null> {
	try {
		const res = await fetch(`${RADIO_URL}/state`, { signal: AbortSignal.timeout(800) });
		if (!res.ok) return null;
		return (await res.json()) as RadioState;
	} catch {
		return null;
	}
}

/** Favoris de CariRadio + station en cours (null si l'app est fermée ou trop ancienne). */
export async function readStations(): Promise<{ current: string; stations: RadioStation[] } | null> {
	try {
		const res = await fetch(`${RADIO_URL}/stations`, { signal: AbortSignal.timeout(1500) });
		if (!res.ok) return null;
		return (await res.json()) as { current: string; stations: RadioStation[] };
	} catch {
		return null;
	}
}

export async function radioCmd(path: string): Promise<boolean> {
	try {
		const res = await fetch(`${RADIO_URL}${path}`, { method: "POST", signal: AbortSignal.timeout(1500) });
		return res.ok;
	} catch {
		return false;
	}
}

const open = (args: string[]) =>
	new Promise<boolean>((resolve) => execFile("/usr/bin/open", args, { timeout: 10_000 }, (err) => resolve(!err)));

/** Lance CariRadio (lecture automatique si demandée). */
export async function launchRadio(autoplay: boolean): Promise<boolean> {
	const extra = autoplay ? ["--args", "--autoplay"] : [];
	return (await open(["-b", BUNDLE_ID, ...extra])) || open(["-a", "CariRadio", ...extra]);
}
