// Génère les icônes des actions (liste 20/40 px + image par défaut 72/144 px) à partir des rendus SVG du plugin.
// Usage : node assets/make_action_icons.mjs <chemin playwright-core>   (outil de dev, non requis pour le build)
import { build } from "esbuild";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

const pw = createRequire(path.resolve(process.argv[2] ?? ".") + "/")("playwright-core");
const out = "fr.cariboulabs.caricover.sdPlugin/imgs/actions";
const tmp = path.resolve("assets/.svg-bundle.mjs");
await build({ entryPoints: ["src/svg.ts"], outfile: tmp, bundle: true, format: "esm", platform: "node", logLevel: "silent" });
const S = await import(tmp);

const W = "#FFFFFF";
const transparent = (uri) => uri.replace("fill%3D%22%23000000%22", "fill%3D%22none%22");
const raw = (body) => `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144">${body}</svg>`)}`;
const stroke = `fill="none" stroke="${W}" stroke-width="12" stroke-linecap="round" stroke-linejoin="round"`;

const defs = {
	playpause: { list: transparent(S.playPauseKey(false)), key: S.playPauseKey(false) },
	previous: { list: transparent(S.skipKey("prev", W)), key: S.skipKey("prev", W) },
	next: { list: transparent(S.skipKey("next", W)), key: S.skipKey("next", W) },
	shuffle: { list: transparent(S.shuffleKey(false, W)).replaceAll("%238E8E93", "%23FFFFFF"), key: S.shuffleKey(false, "#FF9F0A") },
	repeat: { list: transparent(S.repeatKey("off", W)).replaceAll("%238E8E93", "%23FFFFFF"), key: S.repeatKey("off", "#FF9F0A") },
	title: {
		list: raw(`<text x="72" y="112" font-family="Helvetica Neue, Arial" font-size="118" font-weight="bold" fill="${W}" text-anchor="middle">T</text>`),
		key: S.titleKey("Titre du morceau", true),
	},
	info: {
		list: raw(`<circle cx="72" cy="72" r="58" ${stroke}/><circle cx="72" cy="40" r="9" fill="${W}"/><path d="M72 64 V108" ${stroke}/>`),
		key: S.infoKey("FLAC", "24/96", "7/14", "#FF9F0A", true),
	},
	time: {
		list: raw(`<circle cx="72" cy="72" r="58" ${stroke}/><path d="M72 36 V72 L96 88" ${stroke}/>`),
		key: S.timeKey(0, 0, "total", "#FF9F0A", true),
	},
	rating: {
		list: raw(`<polygon points="72,10 89,52 134,55 99,84 111,128 72,103 33,128 45,84 10,55 55,52" fill="${W}" stroke="${W}" stroke-width="6" stroke-linejoin="round"/>`),
		key: S.ratingKey(null, "#FF9F0A", true),
	},
	volup: { list: transparent(S.volumeKey("up", 60, false, W)), key: S.volumeKey("up", null, false, "#FF9F0A") },
	voldown: { list: transparent(S.volumeKey("down", 60, false, W)), key: S.volumeKey("down", null, false, "#FF9F0A") },
	radio: {
		list: raw(`<circle cx="72" cy="66" r="12" fill="${W}"/><path d="M65 76 H79 L88 124 H56 Z" fill="${W}"/><path d="M46 40 A 36 36 0 0 0 46 92 M98 40 A 36 36 0 0 1 98 92 M26 22 A 62 62 0 0 0 26 110 M118 22 A 62 62 0 0 1 118 110" ${stroke}/>`),
		key: S.radioKey("off", "#FF9F0A", "Radio Choco"),
	},
	playlist: { list: transparent(S.playlistKey("")).replaceAll("%238E8E93", "%23FFFFFF"), key: S.playlistKey("Playlist") },
};

const browser = await pw.chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });
const page = await browser.newPage();
async function shot(uri, size, file) {
	await page.setViewportSize({ width: size, height: size });
	await page.setContent(`<html><body style="margin:0;background:transparent"><img src="${uri}" width="${size}" height="${size}" style="display:block"></body></html>`);
	await page.waitForFunction(() => document.images[0].complete);
	await writeFile(file, await page.screenshot({ omitBackground: true }));
}
for (const [name, d] of Object.entries(defs)) {
	const dir = `${out}/${name}`;
	await mkdir(dir, { recursive: true });
	await shot(d.list, 20, `${dir}/icon.png`);
	await shot(d.list, 40, `${dir}/icon@2x.png`);
	await shot(d.key, 72, `${dir}/key.png`);
	await shot(d.key, 144, `${dir}/key@2x.png`);
}
await browser.close();
console.log("icônes générées :", Object.keys(defs).join(", "));
