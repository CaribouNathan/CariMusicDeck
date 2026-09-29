// Classe de base des touches "live" : suivi des instances visibles, rendu différentiel, appui court / long.
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
import type { NowPlaying } from "./engine.js";
import { handlePiMessage, onPiAppear } from "./pi.js";

export const HOLD_MS = 400;
export type Key<S extends JsonObject> = KeyAction<S>;

/** Distingue appui court et appui long (400 ms). */
export class HoldTracker<S extends JsonObject> {
	private map = new Map<string, { timer: NodeJS.Timeout; held: boolean }>();
	constructor(
		private onTap: (a: Key<S>, s: S) => Promise<boolean | void>,
		private onHold: ((a: Key<S>, s: S) => Promise<boolean | void>) | null,
		private onHoldEnd: ((a: Key<S>, s: S) => Promise<void> | void) | null = null,
	) {}

	down(a: Key<S>, s: S): void {
		if (!this.onHold) {
			void this.run(a, this.onTap(a, s));
			return;
		}
		const st = { held: false, timer: setTimeout(() => {
			st.held = true;
			void this.run(a, this.onHold!(a, s));
		}, HOLD_MS) };
		this.map.set(a.id, st);
	}

	up(a: Key<S>, s: S): void {
		const st = this.map.get(a.id);
		if (!st) return;
		clearTimeout(st.timer);
		this.map.delete(a.id);
		if (!st.held) void this.run(a, this.onTap(a, s));
		else void this.onHoldEnd?.(a, s);
	}

	private async run(a: Key<S>, p: Promise<boolean | void>): Promise<void> {
		try {
			if ((await p) === false) await a.showAlert();
		} catch (e) {
			streamDeck.logger.error(`Action : ${e instanceof Error ? e.stack : e}`);
			await a.showAlert();
		}
	}
}

export abstract class LiveAction<S extends JsonObject> extends SingletonAction<S> {
	protected settings = new Map<string, S>();
	private sentImage = new Map<string, string>();
	private sentTitle = new Map<string, string>();
	private refreshing = false;
	private again = false;
	protected hold: HoldTracker<S>;

	constructor(
		protected engine: NowPlaying,
		override readonly manifestId: string,
		ticks = false,
		withHold = false,
	) {
		super();
		engine.onChange(() => void this.refresh());
		if (ticks) engine.onTick(() => void this.refresh());
		this.hold = new HoldTracker<S>(
			(a, s) => this.onTap(a, s),
			withHold ? (a, s) => this.onHold(a, s) : null,
			withHold ? (a, s) => this.onHoldEnd(a, s) : null,
		);
	}

	protected abstract draw(s: S, id: string): string | Promise<string>;
	protected title(_s: S): string | undefined {
		return undefined;
	}
	protected async onTap(_a: Key<S>, _s: S): Promise<boolean | void> {}
	protected async onHold(_a: Key<S>, _s: S): Promise<boolean | void> {}
	protected onHoldEnd(_a: Key<S>, _s: S): void {}

	get visibleCount(): number {
		return this.actions.length;
	}

	protected s(id: string): S {
		return this.settings.get(id) ?? ({} as S);
	}

	override onWillAppear(ev: WillAppearEvent<S>): void {
		this.settings.set(ev.action.id, ev.payload.settings ?? ({} as S));
		this.sentImage.delete(ev.action.id);
		this.sentTitle.delete(ev.action.id);
		void this.refresh();
	}

	override onWillDisappear(ev: WillDisappearEvent<S>): void {
		this.settings.delete(ev.action.id);
		this.sentImage.delete(ev.action.id);
		this.sentTitle.delete(ev.action.id);
	}

	override onDidReceiveSettings(ev: DidReceiveSettingsEvent<S>): void {
		this.settings.set(ev.action.id, ev.payload.settings ?? ({} as S));
		this.sentImage.delete(ev.action.id);
		this.sentTitle.delete(ev.action.id);
		void this.refresh();
	}

	override onKeyDown(ev: KeyDownEvent<S>): void {
		this.settings.set(ev.action.id, ev.payload.settings ?? ({} as S));
		this.hold.down(ev.action as Key<S>, ev.payload.settings ?? ({} as S));
	}

	override onKeyUp(ev: KeyUpEvent<S>): void {
		this.hold.up(ev.action as Key<S>, ev.payload.settings ?? ({} as S));
	}

	override onPropertyInspectorDidAppear(): void {
		onPiAppear(this.engine);
	}

	override async onSendToPlugin(ev: SendToPluginEvent<JsonValue, S>): Promise<void> {
		await handlePiMessage(this.engine, ev.payload);
	}

	async refresh(): Promise<void> {
		if (this.refreshing) {
			this.again = true;
			return;
		}
		this.refreshing = true;
		try {
			do {
				this.again = false;
				for (const a of this.actions) {
					if (!a.isKey()) continue;
					const s = this.s(a.id);
					const img = await this.draw(s, a.id);
					if (this.sentImage.get(a.id) !== img) {
						await a.setImage(img);
						this.sentImage.set(a.id, img);
					}
					const t = this.title(s);
					const tk = t === undefined ? "\u0000" : t;
					if (this.sentTitle.get(a.id) !== tk) {
						await a.setTitle(t);
						this.sentTitle.set(a.id, tk);
					}
				}
			} while (this.again);
		} catch (e) {
			streamDeck.logger.error(`Rendu ${this.manifestId} : ${e instanceof Error ? e.stack : e}`);
		} finally {
			this.refreshing = false;
		}
	}
}
