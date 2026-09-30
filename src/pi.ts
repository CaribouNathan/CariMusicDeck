// Messages échangés avec le Property Inspector (commun à toutes les actions).
import streamDeck from "@elgato/streamdeck";
import type { JsonObject, JsonValue } from "@elgato/utils";
import { randomUUID } from "node:crypto";
import type { GlobalSettings, NowPlaying, SourceId } from "./engine.js";
import { readMusic, readMusicArtworkLocal, searchItunesArtwork } from "./music.js";
import { backendLabel } from "./nowplaying.js";
import { readStations } from "./radio.js";
import { createPin, discoverServers, testPlex, waitForPin } from "./plex.js";

const reply = (p: Record<string, JsonValue>) => streamDeck.ui.sendToPropertyInspector(p);
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function pushStatus(engine: NowPlaying): void {
	if (!streamDeck.ui.action) return;
	void reply({ event: "status", text: engine.statusText() });
}

export function onPiAppear(engine: NowPlaying): void {
	pushStatus(engine);
	void reply({ event: "global", settings: engine.global as JsonValue });
}

export async function saveGlobal(engine: NowPlaying, next: GlobalSettings): Promise<void> {
	await streamDeck.settings.setGlobalSettings(next as JsonObject);
	engine.setGlobal(next);
	await reply({ event: "global", settings: next as JsonValue });
}

export async function handlePiMessage(engine: NowPlaying, payload: JsonValue): Promise<void> {
	const msg = (payload ?? {}) as { event?: string; [k: string]: JsonValue | undefined };
	const g = engine.global;

	switch (msg.event) {
		case "status":
			pushStatus(engine);
			return;

		case "musicTest":
			try {
				const m = await readMusic();
				if (!m) return void reply({ event: "musicTest", ok: true, message: "Music fermé ou à l'arrêt : lance un morceau puis reteste." });
				const local = m.artworkCount > 0 ? await readMusicArtworkLocal() : null;
				const itunes = local ? null : await searchItunesArtwork(m, g.itunesCountry || "FR");
				const art = local ? `pochette locale OK (${Math.round(local.length / 1024)} Ko)` : itunes ? "pochette via catalogue iTunes OK" : "aucune pochette trouvée";
				await reply({
					event: "musicTest",
					ok: !!(local || itunes),
					message: `${m.state === "playing" ? "▶︎" : "❚❚"} ${m.title || "(sans titre)"} · ${m.artist || "?"} · ${m.album || "?"} — volume ${m.volume} %, ${art}`,
				});
			} catch (e) {
				await reply({ event: "musicTest", ok: false, message: `Échec : ${errText(e)}` });
			}
			return;

		case "npTest": {
			const st = engine.np.state;
			const b = engine.np.backend;
			if (!b) return void reply({ event: "npTest", ok: false, message: "Moteur absent : lance build.command (adaptateur embarqué) ou « brew install media-control »." });
			if (engine.global.nowPlayingEnabled === false) return void reply({ event: "npTest", ok: false, message: "Source désactivée ci-dessus." });
			await reply({
				event: "npTest",
				ok: !engine.np.error,
				message: engine.np.error
					? `Moteur : ${backendLabel(b)} — erreur : ${engine.np.error}`
					: st
						? `Moteur : ${backendLabel(b)} — ${st.playing ? "▶︎" : "❚❚"} ${st.title} · ${st.artist} (${st.bundleId})`
						: `Moteur : ${backendLabel(b)} — rien en lecture pour l'instant`,
			});
			return;
		}

		case "plexTest": {
			const cfg = engine.plexConfig;
			if (!cfg) return void reply({ event: "plexTest", ok: false, message: "Renseigne l'URL et le jeton (ou connecte-toi)." });
			try {
				await reply({ event: "plexTest", ok: true, message: `OK — ${await testPlex(cfg)}` });
			} catch (e) {
				await reply({ event: "plexTest", ok: false, message: `Échec : ${errText(e)}` });
			}
			return;
		}

		case "plexLogin":
			try {
				const clientId = g.clientId ?? randomUUID();
				const pin = await createPin(clientId);
				await streamDeck.system.openUrl(pin.authUrl);
				await reply({ event: "plexLogin", state: "waiting", message: "Valide la connexion dans le navigateur…" });
				const userToken = await waitForPin(clientId, pin.id);
				await reply({ event: "plexLogin", state: "discovering", message: "Connecté. Recherche des serveurs…" });
				const servers = await discoverServers(clientId, userToken);
				const first = servers[0];
				await saveGlobal(engine, {
					...engine.global,
					clientId,
					plexEnabled: true,
					plexServers: servers,
					plexUserToken: userToken,
					plexUrl: first?.url ?? engine.global.plexUrl ?? "",
					plexToken: first?.token ?? userToken,
				});
				await reply({
					event: "plexLogin",
					state: "done",
					message: first ? `Serveur : ${first.name} (${first.local ? "réseau local" : "distant"})` : "Aucun serveur joignable trouvé.",
				});
			} catch (e) {
				await reply({ event: "plexLogin", state: "error", message: `Échec : ${errText(e)}` });
			}
			return;

		case "listStations": {
			const r = await readStations();
			if (!r) return void reply({ event: "stations", items: [], message: "CariRadio (1.1 ou plus récent) doit être ouverte." });
			await reply({
				event: "stations",
				items: r.stations.map((s) => ({ id: s.id, name: s.name, favicon: s.favicon })) as unknown as JsonValue,
				message: r.stations.length ? `${r.stations.length} favori(s)` : "Aucun favori : ajoute des stations avec l'étoile dans CariRadio.",
			});
			return;
		}

		case "listPlaylists": {
			const source = (msg.source === "plex" ? "plex" : "music") as SourceId;
			if (msg.source === "spotify") return void reply({ event: "playlists", source: "spotify", items: [], message: "Spotify : colle le lien de la playlist ci-dessous." });
			try {
				const items = await engine.listPlaylists(source);
				await reply({ event: "playlists", source, items: items as unknown as JsonValue, message: `${items.length} playlist(s)` });
			} catch (e) {
				await reply({ event: "playlists", source, items: [], message: `Échec : ${errText(e)}` });
			}
			return;
		}
	}
}
