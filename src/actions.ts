// Touches de contrôle et d'information — toutes agissent sur la source en cours (Plex ou Apple Music).
import type { JsonObject } from "@elgato/utils";
import type { NowPlaying, SourceId } from "./engine.js";
import { LiveAction, type Key } from "./base.js";
import { renderSingle } from "./render.js";
import {
	DIM,
	WHITE,
	fitsComfortably,
	fmtTime,
	heartKey,
	idleKey,
	infoKey,
	marqueeCycle,
	marqueeKey,
	playlistKey,
	playPauseKey,
	radioKey,
	ratingKey,
	repeatKey,
	shuffleKey,
	skipKey,
	timeKey,
	titleKey,
	volumeKey,
} from "./svg.js";

export const NS = "fr.cariboulabs.caricover";

// ------------------------------------------------------------ Lecture / Pause

export class PlayPauseAction extends LiveAction<JsonObject> {
	constructor(e: NowPlaying) {
		super(e, `${NS}.playpause`, false, true);
	}
	protected draw(): string {
		const c = this.engine.current;
		return playPauseKey(c ? c.state === "playing" : null);
	}
	protected override onTap() {
		return this.engine.playPause();
	}
	protected override onHold() {
		return this.engine.stop();
	}
}

// ------------------------------------------------------------ Précédent / Suivant (maintien = recherche)

type SkipSettings = JsonObject & { seekStep?: number };

export class SkipAction extends LiveAction<SkipSettings> {
	private seeking = new Map<string, NodeJS.Timeout>();
	constructor(
		e: NowPlaying,
		private dir: "prev" | "next",
	) {
		super(e, `${NS}.${dir === "next" ? "next" : "previous"}`, true, true);
	}
	protected draw(_s: SkipSettings, id: string): string {
		const c = this.engine.current;
		if (this.seeking.has(id)) return skipKey(this.dir, this.engine.accent, fmtTime(this.engine.positionMs()));
		return skipKey(this.dir, c && c.src !== "radio" ? WHITE : DIM); // radio en direct : pas de piste suivante
	}
	protected override onTap() {
		return this.dir === "next" ? this.engine.next() : this.engine.previous();
	}
	protected override async onHold(a: Key<SkipSettings>, s: SkipSettings) {
		if (!this.engine.current) return false;
		const step = (Number(s.seekStep) || 10) * 1000 * (this.dir === "next" ? 1 : -1);
		void this.engine.seekBy(step);
		this.seeking.set(
			a.id,
			setInterval(() => void this.engine.seekBy(step), 350),
		);
		void this.refresh();
	}
	protected override onHoldEnd(a: Key<SkipSettings>) {
		clearInterval(this.seeking.get(a.id));
		this.seeking.delete(a.id);
		void this.refresh();
	}
}

// ------------------------------------------------------------ Aléatoire / Répétition

export class ShuffleAction extends LiveAction<JsonObject> {
	constructor(e: NowPlaying) {
		super(e, `${NS}.shuffle`);
	}
	protected draw(): string {
		const c = this.engine.current;
		return shuffleKey(c ? c.shuffle : null, this.engine.accent);
	}
	protected override onTap() {
		return this.engine.current?.shuffle === null ? Promise.resolve(false) : this.engine.toggleShuffle();
	}
}

export class RepeatAction extends LiveAction<JsonObject> {
	constructor(e: NowPlaying) {
		super(e, `${NS}.repeat`);
	}
	protected draw(): string {
		const c = this.engine.current;
		return repeatKey(c ? c.repeat : null, this.engine.accent);
	}
	protected override onTap() {
		return this.engine.current?.repeat === null ? Promise.resolve(false) : this.engine.cycleRepeat();
	}
}

// ------------------------------------------------------------ Titre / Infos / Temps

type TitleSettings = JsonObject & { field?: "title" | "artist" | "album" | "artist-title"; overflow?: "scroll" | "shrink" };

const MARQUEE_SPEED = 45; // px/s (à l'échelle 144 px)
const MARQUEE_PAUSE = 1.5; // s d'arrêt au début de chaque passage

export class TitleAction extends LiveAction<TitleSettings> {
	private since = new Map<string, { text: string; t0: number }>();
	constructor(e: NowPlaying) {
		super(e, `${NS}.title`, true, true);
	}
	protected draw(s: TitleSettings, id: string): string {
		const c = this.engine.current;
		if (!c) return idleKey();
		const text =
			(s.field === "artist" ? c.artist : s.field === "album" ? c.album : s.field === "artist-title" ? `${c.artist} — ${c.title}` : c.title) || "—";
		if (s.overflow === "shrink" || fitsComfortably(text)) return titleKey(text, c.state === "paused");
		// défilement : repart du début à chaque changement de texte
		let st = this.since.get(id);
		if (!st || st.text !== text) {
			st = { text, t0: Date.now() };
			this.since.set(id, st);
		}
		if (c.state === "paused") return marqueeKey(text, 0, true);
		const period = marqueeCycle(text) / MARQUEE_SPEED + MARQUEE_PAUSE;
		const p = ((Date.now() - st.t0) / 1000) % period;
		const offset = p < MARQUEE_PAUSE ? 0 : (p - MARQUEE_PAUSE) * MARQUEE_SPEED;
		// pas de 6 px : limite le nombre d'images envoyées sans saccade visible
		return marqueeKey(text, Math.round(offset / 6) * 6, false);
	}
	protected override onTap() {
		return this.engine.playPause();
	}
	protected override onHold() {
		return this.engine.stop();
	}
}

export class InfoAction extends LiveAction<JsonObject> {
	constructor(e: NowPlaying) {
		super(e, `${NS}.info`);
	}
	protected draw(): string {
		const c = this.engine.current;
		if (!c) return infoKey("", "", "", this.engine.accent, true);
		return infoKey(c.codec, c.quality, c.position, this.engine.accent, c.state === "paused");
	}
}

type TimeSettings = JsonObject & { mode?: "total" | "remaining" };

export class TimeAction extends LiveAction<TimeSettings> {
	constructor(e: NowPlaying) {
		super(e, `${NS}.time`, true);
	}
	protected draw(s: TimeSettings): string {
		const c = this.engine.current;
		if (!c) return timeKey(0, 0, "total", this.engine.accent, true);
		return timeKey(this.engine.positionMs(), c.durMs, s.mode === "remaining" ? "remaining" : "total", this.engine.accent, c.state === "paused");
	}
	protected override async onTap(a: Key<TimeSettings>, s: TimeSettings) {
		const next: TimeSettings = { ...s, mode: s.mode === "remaining" ? "total" : "remaining" };
		this.settings.set(a.id, next);
		await a.setSettings(next);
		void this.refresh();
	}
}

// ------------------------------------------------------------ Note

type RatingSettings = JsonObject & { increment?: "1" | "0.5"; showLabel?: boolean; musicMode?: "heart" | "stars" };

export class RatingAction extends LiveAction<RatingSettings> {
	constructor(e: NowPlaying) {
		super(e, `${NS}.rating`);
	}
	private heart(s: RatingSettings): boolean {
		return this.engine.current?.src === "music" && s.musicMode !== "stars";
	}
	protected draw(s: RatingSettings): string {
		const c = this.engine.current;
		if (this.heart(s)) return heartKey(c ? c.favorite : null, this.engine.accent, s.showLabel !== false);
		return ratingKey(c ? c.rating : null, this.engine.accent, s.showLabel !== false);
	}
	protected override async onTap(_a: Key<RatingSettings>, s: RatingSettings) {
		const c = this.engine.current;
		if (!c) return false;
		if (this.heart(s)) return this.engine.toggleFavorite();
		if (c.rating === null) return false;
		const step = s.increment === "0.5" ? 1 : 2;
		// arrondi au pas courant, puis +1 pas ; au-delà de 5 étoiles, retour à 0
		const base = Math.floor(c.rating / step) * step;
		const next = base + step > 10 ? 0 : base + step;
		this.engine.setRating(next);
	}
}

// ------------------------------------------------------------ Volume

type VolumeSettings = JsonObject & { step?: number; fade?: number; holdAction?: "repeat" | "mute" };

const VOLUME_REPEAT_MS = 150;

export class VolumeAction extends LiveAction<VolumeSettings> {
	private repeating = new Map<string, NodeJS.Timeout>();
	constructor(
		e: NowPlaying,
		private dir: "up" | "down",
	) {
		super(e, `${NS}.vol${dir}`, false, true);
	}
	protected draw(): string {
		const c = this.engine.current;
		return volumeKey(this.dir, c ? c.volume : null, this.engine.muted, this.engine.accent);
	}
	private delta(s: VolumeSettings): number {
		const step = Number(s.step) || 5;
		return this.dir === "up" ? step : -step;
	}
	protected override onTap(_a: Key<VolumeSettings>, s: VolumeSettings) {
		return this.engine.volumeStep(this.delta(s));
	}
	protected override async onHold(a: Key<VolumeSettings>, s: VolumeSettings) {
		if (this.dir === "down" && s.holdAction === "mute") return this.engine.toggleMute(Number(s.fade) || 0);
		// répétition automatique tant que la touche est maintenue
		const ok = await this.engine.volumeStep(this.delta(s));
		if (!ok) return false;
		this.repeating.set(
			a.id,
			setInterval(() => void this.engine.volumeStep(this.delta(s)), VOLUME_REPEAT_MS),
		);
	}
	protected override onHoldEnd(a: Key<VolumeSettings>) {
		clearInterval(this.repeating.get(a.id));
		this.repeating.delete(a.id);
	}
}

// ------------------------------------------------------------ Playlist

type PlaylistSettings = JsonObject & {
	source?: SourceId;
	playlistId?: string;
	playlistTitle?: string;
	shuffle?: boolean;
	showName?: boolean;
};

export class PlaylistAction extends LiveAction<PlaylistSettings> {
	private art = new Map<string, string | null>();
	private artTried = new Map<string, number>();
	constructor(e: NowPlaying) {
		super(e, `${NS}.playlist`);
	}
	protected async draw(s: PlaylistSettings): Promise<string> {
		const name = s.playlistTitle || "";
		if (!s.playlistId) return playlistKey("Choisir une playlist");
		const k = `${s.source}:${s.playlistId}`;
		const retry = !this.art.get(k) && Date.now() - (this.artTried.get(k) ?? 0) > 3_000;
		if (!this.art.has(k) || retry) {
			this.art.set(k, this.art.get(k) ?? null);
			this.artTried.set(k, Date.now());
			void this.engine.playlistArt(s.source ?? "music", s.playlistId).then(async (img) => {
				this.art.set(k, img ? await renderSingle(img) : null);
				void this.refresh();
			});
		}
		return this.art.get(k) ?? playlistKey(name);
	}
	protected override title(s: PlaylistSettings): string | undefined {
		if (!s.playlistId || s.showName === false) return undefined;
		const k = `${s.source}:${s.playlistId}`;
		return this.art.get(k) ? s.playlistTitle : undefined; // sans pochette, le nom est déjà dessiné
	}
	protected override onTap(_a: Key<PlaylistSettings>, s: PlaylistSettings) {
		if (!s.playlistId) return Promise.resolve(false);
		return this.engine.playPlaylist(s.source ?? "music", s.playlistId, !!s.shuffle);
	}
	override onDidReceiveSettings(ev: Parameters<LiveAction<PlaylistSettings>["onDidReceiveSettings"]>[0]): void {
		const s = ev.payload.settings ?? {};
		this.art.delete(`${s.source}:${s.playlistId}`);
		this.artTried.delete(`${s.source}:${s.playlistId}`);
		super.onDidReceiveSettings(ev);
	}
}

// ------------------------------------------------------------ Radio (CariRadio)

export class RadioAction extends LiveAction<JsonObject> {
	constructor(e: NowPlaying) {
		super(e, `${NS}.radio`, false, true);
	}
	protected draw(): string {
		const r = this.engine.radio;
		const name = r?.station.name ?? "Radio Choco";
		if (!r) return radioKey("off", this.engine.accent, name);
		const st = r.status === "playing" || r.status === "loading" ? "playing" : r.status === "paused" ? "paused" : "idle";
		return radioKey(st, this.engine.accent, name);
	}
	/** Appui : lance CariRadio en lecture si fermée, sinon lecture/pause. */
	protected override onTap() {
		return this.engine.radioToggle();
	}
	/** Maintien : affiche la fenêtre CariRadio. */
	protected override onHold() {
		return this.engine.radioShow();
	}
}
