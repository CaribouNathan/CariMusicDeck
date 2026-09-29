// Pochette : une touche, ou mosaïque automatique sur des touches voisines.
import streamDeck, {
	SingletonAction,
	type DidReceiveSettingsEvent,
	type KeyAction,
	type KeyDownEvent,
	type KeyUpEvent,
	type SendToPluginEvent,
	type WillAppearEvent,
	type WillDisappearEvent,
} from "@elgato/streamdeck";
import type { JsonObject, JsonValue } from "@elgato/utils";
import { NS } from "./actions.js";
import { HoldTracker } from "./base.js";
import type { Img, NowPlaying } from "./engine.js";
import { handlePiMessage, onPiAppear, pushStatus } from "./pi.js";
import { BAR_MARGIN, encodeTile, groupWidth, renderGroupTiles, withProgress } from "./render.js";

type CoverSettings = JsonObject & {
	layout?: "auto" | "single";
	text?: "none" | "title" | "artist" | "album" | "source";
	press?: "playpause" | "none";
};

type Key = KeyAction<CoverSettings>;

export class CoverAction extends SingletonAction<CoverSettings> {
	override readonly manifestId = `${NS}.cover`;

	private settings = new Map<string, CoverSettings>();
	private sentImage = new Map<string, string>();
	private sentTitle = new Map<string, string | undefined>();
	private renderQueued = false;
	private rendering = false;
	private dirty = false;

	private hold = new HoldTracker<CoverSettings>(
		async (_a, s) => ((s.press ?? "playpause") === "none" ? undefined : this.engine.playPause()),
		async (_a, s) => ((s.press ?? "playpause") === "none" ? undefined : this.engine.stop()),
	);

	constructor(private engine: NowPlaying) {
		super();
		engine.onChange(() => {
			this.scheduleRender();
			pushStatus(engine);
		});
		// barre de progression : rafraîchie au rythme de l'horloge du moteur
		engine.onTick(() => {
			if (engine.global.coverProgress && engine.current?.state === "playing") this.scheduleRender();
		});
	}

	get visibleCount(): number {
		return this.actions.length;
	}

	override onWillAppear(ev: WillAppearEvent<CoverSettings>): void {
		this.settings.set(ev.action.id, ev.payload.settings ?? {});
		this.sentImage.delete(ev.action.id);
		this.sentTitle.delete(ev.action.id);
		this.scheduleRender();
	}

	override onWillDisappear(ev: WillDisappearEvent<CoverSettings>): void {
		this.settings.delete(ev.action.id);
		this.sentImage.delete(ev.action.id);
		this.sentTitle.delete(ev.action.id);
		this.scheduleRender();
	}

	override onDidReceiveSettings(ev: DidReceiveSettingsEvent<CoverSettings>): void {
		this.settings.set(ev.action.id, ev.payload.settings ?? {});
		this.sentImage.clear(); // la disposition des mosaïques peut changer
		this.sentTitle.delete(ev.action.id);
		this.scheduleRender();
	}

	override onKeyDown(ev: KeyDownEvent<CoverSettings>): void {
		this.hold.down(ev.action as Key, ev.payload.settings ?? {});
	}

	override onKeyUp(ev: KeyUpEvent<CoverSettings>): void {
		this.hold.up(ev.action as Key, ev.payload.settings ?? {});
	}

	override onPropertyInspectorDidAppear(): void {
		onPiAppear(this.engine);
	}

	override async onSendToPlugin(ev: SendToPluginEvent<JsonValue, CoverSettings>): Promise<void> {
		await handlePiMessage(this.engine, ev.payload);
	}

	scheduleRender(): void {
		if (this.renderQueued) return;
		this.renderQueued = true;
		setTimeout(() => {
			this.renderQueued = false;
			void this.render();
		}, 40);
	}

	/** Regroupe les touches "auto" adjacentes (par appareil) en rectangles englobants. */
	private layout(keys: Key[]): Map<string, { cols: number; rows: number; c: number; r: number }> {
		const out = new Map<string, { cols: number; rows: number; c: number; r: number }>();
		const auto: Key[] = [];
		for (const k of keys) {
			const s = this.settings.get(k.id) ?? {};
			if ((s.layout ?? "auto") === "auto" && k.coordinates && !k.isInMultiAction()) auto.push(k);
			else out.set(k.id, { cols: 1, rows: 1, c: 0, r: 0 });
		}
		const parent = new Map<string, string>(auto.map((k) => [k.id, k.id]));
		const find = (x: string): string => {
			while (parent.get(x) !== x) x = parent.get(x)!;
			return x;
		};
		for (let i = 0; i < auto.length; i++) {
			for (let j = i + 1; j < auto.length; j++) {
				const a = auto[i];
				const b = auto[j];
				if (a.device.id !== b.device.id) continue;
				const d = Math.abs(a.coordinates!.column - b.coordinates!.column) + Math.abs(a.coordinates!.row - b.coordinates!.row);
				if (d === 1) parent.set(find(a.id), find(b.id));
			}
		}
		const groups = new Map<string, Key[]>();
		for (const k of auto) {
			const root = find(k.id);
			groups.set(root, [...(groups.get(root) ?? []), k]);
		}
		for (const members of groups.values()) {
			const cs = members.map((k) => k.coordinates!.column);
			const rs = members.map((k) => k.coordinates!.row);
			const minC = Math.min(...cs);
			const minR = Math.min(...rs);
			const cols = Math.max(...cs) - minC + 1;
			const rows = Math.max(...rs) - minR + 1;
			for (const k of members) out.set(k.id, { cols, rows, c: k.coordinates!.column - minC, r: k.coordinates!.row - minR });
		}
		return out;
	}

	private titleFor(s: CoverSettings): string | undefined {
		const c = this.engine.current;
		switch (s.text ?? "none") {
			case "title":
				return c?.title ?? "";
			case "artist":
				return c?.artist ?? "";
			case "album":
				return c?.album ?? "";
			case "source":
				return c ? (c.src === "music" ? "Music" : c.src === "radio" ? "Radio" : "Plex") : "";
			default:
				return undefined;
		}
	}

	async render(): Promise<void> {
		if (this.rendering) {
			this.dirty = true;
			return;
		}
		this.rendering = true;
		try {
			do {
				this.dirty = false;
				await this.renderOnce();
			} while (this.dirty);
		} catch (e) {
			streamDeck.logger.error(`Rendu : ${e instanceof Error ? e.stack : e}`);
		} finally {
			this.rendering = false;
		}
	}

	private tileCache: { key: string; groups: Map<string, Map<string, Img>> } = { key: "", groups: new Map() };

	private async renderOnce(): Promise<void> {
		const keys = this.actions.filter((a) => a.isKey()).toArray() as Key[];
		if (!keys.length) return;
		const e = this.engine;
		const cur = e.current;
		let art = cur ? e.artFor(cur) : e.idleArt;
		if (art === undefined) return; // pochette en cours de chargement : on garde l'affichage précédent
		if (art === null) art = e.idleArt;
		const paused = cur?.state === "paused";
		const gapPct = e.global.gapPct ?? 30;
		const stateKey = `${cur ? `${cur.artKey}|${cur.state}` : "idle"}|${gapPct}`;
		if (this.tileCache.key !== stateKey) this.tileCache = { key: stateKey, groups: new Map() };
		const showBar = !!e.global.coverProgress && !!cur && cur.durMs > 0;
		const frac = showBar ? Math.min(1, e.positionMs() / cur!.durMs) : 0;
		const accent = e.accent;

		const pos = this.layout(keys);
		for (const k of keys) {
			const p = pos.get(k.id)!;
			let fill = -1;
			if (showBar && p.r === p.rows - 1) {
				const span = groupWidth(p.cols, gapPct) - 2 * BAR_MARGIN;
				fill = Math.round((span * frac) / 2) * 2; // pas de 2 px : limite les envois
			}
			const imgKey = `${stateKey}|${p.cols}x${p.rows}|${p.c},${p.r}|${fill}|${fill >= 0 ? accent : ""}`;
			if (art && this.sentImage.get(k.id) !== imgKey) {
				const gk = `${p.cols}x${p.rows}`;
				let group = this.tileCache.groups.get(gk);
				if (!group) {
					group = renderGroupTiles(art, p, { paused, gapPct });
					this.tileCache.groups.set(gk, group);
				}
				let tile = group.get(`${p.c},${p.r}`)!;
				if (fill >= 0) tile = withProgress(tile, p.c, p.cols, gapPct, fill, accent);
				await k.setImage(await encodeTile(tile));
				this.sentImage.set(k.id, imgKey);
			} else if (!art && this.sentImage.get(k.id) !== "default") {
				await k.setImage(undefined);
				this.sentImage.set(k.id, "default");
			}
			const t = this.titleFor(this.settings.get(k.id) ?? {});
			const tk = t === undefined ? "\u0000user" : t;
			if (this.sentTitle.get(k.id) !== tk) {
				await k.setTitle(t);
				this.sentTitle.set(k.id, tk);
			}
		}
	}
}

