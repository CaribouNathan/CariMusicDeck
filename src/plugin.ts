// CariCover — point d'entrée : moteur + enregistrement des actions.
import streamDeck from "@elgato/streamdeck";
import type { JsonObject } from "@elgato/utils";
import { randomUUID } from "node:crypto";
import {
	InfoAction,
	PlaylistAction,
	PlayPauseAction,
	RadioAction,
	RatingAction,
	RepeatAction,
	ShuffleAction,
	SkipAction,
	TimeAction,
	TitleAction,
	VolumeAction,
} from "./actions.js";
import { CoverAction } from "./cover.js";
import { NowPlaying, type GlobalSettings } from "./engine.js";

const all: { visibleCount: number }[] = [];
const engine = new NowPlaying(() => all.some((a) => a.visibleCount > 0));
engine.log = (m) => streamDeck.logger.info(m);

const cover = new CoverAction(engine);
const actions = [
	cover,
	new PlayPauseAction(engine),
	new SkipAction(engine, "prev"),
	new SkipAction(engine, "next"),
	new ShuffleAction(engine),
	new RepeatAction(engine),
	new TitleAction(engine),
	new InfoAction(engine),
	new TimeAction(engine),
	new RatingAction(engine),
	new VolumeAction(engine, "up"),
	new VolumeAction(engine, "down"),
	new PlaylistAction(engine),
	new RadioAction(engine),
];
for (const a of actions) {
	all.push(a);
	streamDeck.actions.registerAction(a);
}

streamDeck.settings.onDidReceiveGlobalSettings((ev) => {
	engine.setGlobal(ev.settings as GlobalSettings);
	cover.scheduleRender();
});
streamDeck.system.onSystemDidWakeUp(() => cover.scheduleRender());

await streamDeck.connect();
const g = (await streamDeck.settings.getGlobalSettings()) as GlobalSettings;
if (!g.clientId) {
	g.clientId = randomUUID();
	await streamDeck.settings.setGlobalSettings(g as JsonObject);
}
engine.setGlobal(g);
await engine.init();
