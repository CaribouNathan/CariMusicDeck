// Génère le profil Stream Deck XL prêt à l'emploi « CariCover XL » (archive .streamDeckProfile, format profil v2).
// Déterministe : mêmes identifiants à chaque build. Appelé par build.mjs.
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";

const NS = "fr.cariboulabs.caricover";
export const PROFILE_NAME = "CariCover XL";
const PLUGIN_DIR = "fr.cariboulabs.caricover.sdPlugin";

// Disposition 8×4 : mosaïque 4×4 à gauche, commandes à droite.
const cover = [];
for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) cover.push({ x, y, a: "cover", name: "Pochette en lecture", settings: { layout: "auto", text: "none", press: "playpause" }, title: true });
const keys = [
	...cover,
	{ x: 4, y: 0, a: "title", name: "Titre", settings: { field: "title", overflow: "scroll" } },
	{ x: 5, y: 0, a: "title", name: "Titre", settings: { field: "artist", overflow: "scroll" } },
	{ x: 6, y: 0, a: "title", name: "Titre", settings: { field: "album", overflow: "scroll" } },
	{ x: 7, y: 0, a: "info", name: "Infos piste", settings: {} },
	{ x: 4, y: 1, a: "time", name: "Temps", settings: { mode: "total" } },
	{ x: 5, y: 1, a: "rating", name: "Note", settings: { musicMode: "heart", increment: "1", showLabel: true } },
	{ x: 6, y: 1, a: "shuffle", name: "Aléatoire", settings: {} },
	{ x: 7, y: 1, a: "repeat", name: "Répétition", settings: {} },
	{ x: 4, y: 2, a: "previous", name: "Précédent", settings: { seekStep: "10" } },
	{ x: 5, y: 2, a: "playpause", name: "Lecture / Pause", settings: {} },
	{ x: 6, y: 2, a: "next", name: "Suivant", settings: { seekStep: "10" } },
	{ x: 7, y: 2, a: "playlist", name: "Playlist", settings: { source: "music", showName: true }, title: true },
	{ x: 4, y: 3, a: "voldown", name: "Volume −", settings: { step: 5, holdAction: "repeat", fade: 0 } },
	{ x: 5, y: 3, a: "volup", name: "Volume +", settings: { step: 5 } },
	{ x: 6, y: 3, a: "playlist", name: "Playlist", settings: { source: "music", showName: true }, title: true },
	{ x: 7, y: 3, a: "radio", name: "Radio", settings: {} },
];

function stableUuid(input) {
	const b = createHash("sha1").update(`caricover:${input}`).digest().subarray(0, 16);
	b[6] = (b[6] & 0x0f) | 0x50;
	b[8] = (b[8] & 0x3f) | 0x80;
	const h = b.toString("hex");
	return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

// Nom de dossier de page : UUID encodé en base32 (alphabet 0-9A-V, avec U→V et V→W) + « Z », comme les exports Stream Deck.
function pageFolderId(uuid) {
	return ((uuid.replaceAll("-", "") + "000").match(/.{5}/g) ?? [])
		.map((g) => Number.parseInt(g, 16).toString(32).padStart(4, "0"))
		.join("")
		.slice(0, 26)
		.toUpperCase()
		.replaceAll("V", "W")
		.replaceAll("U", "V") + "Z";
}

function actionEntry(k, version) {
	return {
		ActionID: stableUuid(`action:${k.x},${k.y}`),
		LinkedTitle: true,
		Name: k.name,
		Plugin: { Name: "CariCover", UUID: NS, Version: version },
		Resources: null,
		Settings: k.settings,
		State: 0,
		States: [
			{
				FontFamily: "",
				FontSize: 10,
				FontStyle: "",
				FontUnderline: false,
				OutlineThickness: 2,
				ShowTitle: !!k.title,
				TitleAlignment: "bottom",
				TitleColor: "#ffffff",
			},
		],
		UUID: `${NS}.${k.a}`,
	};
}

export async function makeProfile(version = "1.0.0.0") {
	const rootId = stableUuid("profile:root").toUpperCase();
	const pageId = stableUuid("profile:page:main");
	const root = `${rootId}.sdProfile`;
	const page = {
		Controllers: [{ Actions: Object.fromEntries(keys.map((k) => [`${k.x},${k.y}`, actionEntry(k, version)])), Type: "Keypad" }],
		Icon: "",
		Name: "",
	};
	const files = [
		[`${root}/manifest.json`, JSON.stringify({ Name: PROFILE_NAME, Pages: { Current: pageId, Pages: [pageId] }, Version: "2.0" })],
		[`${root}/Profiles/${pageFolderId(pageId)}/manifest.json`, JSON.stringify(page)],
	];
	const dest = path.join(PLUGIN_DIR, `${PROFILE_NAME}.streamDeckProfile`);
	await writeFile(dest, zip(files));
	return dest;
}

// ---------- zip minimal (stocké, sans compression) ----------
const crcTable = Array.from({ length: 256 }, (_, i) => {
	let v = i;
	for (let b = 0; b < 8; b++) v = v & 1 ? 0xedb88320 ^ (v >>> 1) : v >>> 1;
	return v >>> 0;
});
function crc32(data) {
	let v = 0xffffffff;
	for (const byte of data) v = crcTable[(v ^ byte) & 0xff] ^ (v >>> 8);
	return (v ^ 0xffffffff) >>> 0;
}
function zip(files) {
	const local = [];
	const central = [];
	let offset = 0;
	for (const [filename, contents] of files) {
		const name = Buffer.from(filename, "utf8");
		const data = Buffer.from(contents, "utf8");
		const crc = crc32(data);
		const lh = Buffer.alloc(30);
		lh.writeUInt32LE(0x04034b50, 0);
		lh.writeUInt16LE(20, 4);
		lh.writeUInt16LE(0x0800, 6);
		lh.writeUInt16LE(0x0021, 12);
		lh.writeUInt32LE(crc, 14);
		lh.writeUInt32LE(data.length, 18);
		lh.writeUInt32LE(data.length, 22);
		lh.writeUInt16LE(name.length, 26);
		local.push(lh, name, data);
		const ch = Buffer.alloc(46);
		ch.writeUInt32LE(0x02014b50, 0);
		ch.writeUInt16LE(20, 4);
		ch.writeUInt16LE(20, 6);
		ch.writeUInt16LE(0x0800, 8);
		ch.writeUInt16LE(0x0021, 14);
		ch.writeUInt32LE(crc, 16);
		ch.writeUInt32LE(data.length, 20);
		ch.writeUInt32LE(data.length, 24);
		ch.writeUInt16LE(name.length, 28);
		ch.writeUInt32LE(offset, 42);
		central.push(ch, name);
		offset += lh.length + name.length + data.length;
	}
	const c = Buffer.concat(central);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(files.length, 8);
	end.writeUInt16LE(files.length, 10);
	end.writeUInt32LE(c.length, 12);
	end.writeUInt32LE(offset, 16);
	return Buffer.concat([...local, c, end]);
}
