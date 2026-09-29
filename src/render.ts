// Rendu des tuiles : recadrage "cover" de la pochette sur la mosaïque, découpe par touche.
import { Jimp } from "jimp";

type Img = Awaited<ReturnType<typeof Jimp.read>>;

export const TILE = 144; // résolution @2x acceptée par toutes les touches (XL : 96 px physiques)

export async function decode(buf: Buffer): Promise<Img> {
	const img = (await Jimp.fromBuffer(buf)) as Img;
	// Aplatit la transparence sur fond noir : les touches sont opaques (JPEG) et la barre de progression
	// doit rester visible même sur une pochette PNG à fond transparent.
	const d = img.bitmap.data;
	for (let i = 0; i < d.length; i += 4) {
		const a = d[i + 3];
		if (a === 255) continue;
		d[i] = (d[i] * a) / 255;
		d[i + 1] = (d[i + 1] * a) / 255;
		d[i + 2] = (d[i + 2] * a) / 255;
		d[i + 3] = 255;
	}
	return img;
}

function dim(img: Img, factor: number): void {
	const d = img.bitmap.data;
	for (let i = 0; i < d.length; i += 4) {
		d[i] = d[i] * factor;
		d[i + 1] = d[i + 1] * factor;
		d[i + 2] = d[i + 2] * factor;
	}
}

function blend(img: Img, x: number, y: number, a: number, r = 255, g = 255, b = 255): void {
	if (x < 0 || y < 0 || x >= img.bitmap.width || y >= img.bitmap.height || a <= 0) return;
	const i = (y * img.bitmap.width + x) * 4;
	const d = img.bitmap.data;
	d[i] = d[i] * (1 - a) + r * a;
	d[i + 1] = d[i + 1] * (1 - a) + g * a;
	d[i + 2] = d[i + 2] * (1 - a) + b * a;
}

/** Triangle "lecture" antialiasé (supersampling 4×4). */
function playGlyph(img: Img, cx: number, cy: number, size: number, alpha = 0.92): void {
	const h = size;
	const w = size * 0.866;
	const x0 = cx - w * 0.4; // léger décalage optique vers la gauche
	const x1 = x0 + w;
	const y0 = cy - h / 2;
	const y1 = cy + h / 2;
	const inside = (px: number, py: number) => {
		if (px < x0 || px > x1) return false;
		const t = (px - x0) / w; // 0 → base, 1 → pointe
		const half = (h / 2) * (1 - t);
		return Math.abs(py - cy) <= half;
	};
	for (let y = Math.floor(y0); y <= Math.ceil(y1); y++) {
		for (let x = Math.floor(x0); x <= Math.ceil(x1); x++) {
			let n = 0;
			for (let sy = 0; sy < 4; sy++) for (let sx = 0; sx < 4; sx++) if (inside(x + (sx + 0.5) / 4, y + (sy + 0.5) / 4)) n++;
			if (n) blend(img, x, y, (n / 16) * alpha);
		}
	}
}

export interface GroupSpec {
	cols: number;
	rows: number;
}

export interface RenderOptions {
	paused: boolean;
	gapPct: number; // espace physique entre touches, en % de la largeur d'une touche
}

/** Rend une mosaïque cols×rows : tuiles Jimp indexées "c,r" (avant encodage, pour y ajouter la barre de progression). */
export function renderGroupTiles(art: Img, g: GroupSpec, opt: RenderOptions): Map<string, Img> {
	const gap = Math.round((TILE * Math.max(0, opt.gapPct)) / 100);
	const W = g.cols * TILE + (g.cols - 1) * gap;
	const H = g.rows * TILE + (g.rows - 1) * gap;
	const base = art.clone().cover({ w: W, h: H }) as Img;
	if (opt.paused) {
		dim(base, 0.42);
		// Glyphe dans une touche entière (jamais à cheval sur l'espace physique entre touches)
		const gc = Math.floor(g.cols / 2);
		const gr = Math.floor(g.rows / 2);
		playGlyph(base, gc * (TILE + gap) + TILE / 2, gr * (TILE + gap) + TILE / 2, TILE * 0.36);
	}
	const out = new Map<string, Img>();
	for (let r = 0; r < g.rows; r++)
		for (let c = 0; c < g.cols; c++) out.set(`${c},${r}`, base.clone().crop({ x: c * (TILE + gap), y: r * (TILE + gap), w: TILE, h: TILE }) as Img);
	return out;
}

export const encodeTile = (t: Img) => t.getBase64("image/jpeg", { quality: 92 });

/** Rend une mosaïque cols×rows et renvoie les data-URI de chaque tuile, indexées "c,r". */
export async function renderGroup(art: Img, g: GroupSpec, opt: RenderOptions): Promise<Map<string, string>> {
	const out = new Map<string, string>();
	for (const [k, t] of renderGroupTiles(art, g, opt)) out.set(k, await encodeTile(t));
	return out;
}

export const BAR_H = 8;
export const BAR_MARGIN = 10;

/** Largeur totale (px) de la mosaïque d'un groupe, espaces physiques compris. */
export const groupWidth = (cols: number, gapPct: number) => cols * TILE + (cols - 1) * Math.round((TILE * Math.max(0, gapPct)) / 100);

/**
 * Barre de progression continue sur la rangée du bas d'une mosaïque.
 * col : colonne de la tuile ; fillPx : longueur remplie (px, repère global de la mosaïque).
 */
export function withProgress(tile: Img, col: number, cols: number, gapPct: number, fillPx: number, accent: string): Img {
	const gap = Math.round((TILE * Math.max(0, gapPct)) / 100);
	const W = groupWidth(cols, gapPct);
	const x0 = BAR_MARGIN;
	const x1 = W - BAR_MARGIN;
	const y0 = TILE - BAR_MARGIN - BAR_H;
	const ox = col * (TILE + gap);
	const ar = parseInt(accent.slice(1, 3), 16), ag = parseInt(accent.slice(3, 5), 16), ab = parseInt(accent.slice(5, 7), 16);
	const t = tile.clone() as Img;
	const d = t.bitmap.data;
	const r = BAR_H / 2;
	for (let y = y0; y < y0 + BAR_H; y++) {
		for (let x = 0; x < TILE; x++) {
			const gx = ox + x;
			if (gx < x0 || gx >= x1) continue;
			// extrémités arrondies
			const cy = y + 0.5 - (y0 + r);
			if (gx < x0 + r && (gx + 0.5 - (x0 + r)) ** 2 + cy ** 2 > r * r) continue;
			if (gx >= x1 - r && (gx + 0.5 - (x1 - r)) ** 2 + cy ** 2 > r * r) continue;
			const i = (y * TILE + x) * 4;
			if (gx < x0 + fillPx) {
				d[i] = ar; d[i + 1] = ag; d[i + 2] = ab;
			} else {
				// piste : assombrit la pochette
				d[i] = d[i] * 0.3; d[i + 1] = d[i + 1] * 0.3; d[i + 2] = d[i + 2] * 0.3;
			}
		}
	}
	return t;
}

/** Couleur d'accent extraite de la pochette : teinte la plus saturée et lumineuse, éclaircie si besoin. */
export function accentFrom(art: Img): string {
	const small = art.clone().resize({ w: 24, h: 24 }) as Img;
	const d = small.bitmap.data;
	let best = { score: -1, r: 255, g: 159, b: 10 };
	const buckets = new Map<number, { n: number; r: number; g: number; b: number; s: number }>();
	for (let i = 0; i < d.length; i += 4) {
		const r = d[i], g = d[i + 1], b = d[i + 2];
		const max = Math.max(r, g, b), min = Math.min(r, g, b);
		const v = max / 255;
		const s = max === 0 ? 0 : (max - min) / max;
		if (v < 0.25 || s < 0.25) continue;
		let h = 0;
		if (max !== min) {
			if (max === r) h = ((g - b) / (max - min)) % 6;
			else if (max === g) h = (b - r) / (max - min) + 2;
			else h = (r - g) / (max - min) + 4;
		}
		const key = Math.round(((h * 60 + 360) % 360) / 20);
		const e = buckets.get(key) ?? { n: 0, r: 0, g: 0, b: 0, s: 0 };
		e.n++; e.r += r; e.g += g; e.b += b; e.s += s * v;
		buckets.set(key, e);
	}
	for (const e of buckets.values()) {
		const score = e.s; // fréquence × saturation × luminosité
		if (score > best.score) best = { score, r: e.r / e.n, g: e.g / e.n, b: e.b / e.n };
	}
	if (best.score < 0) return "#FF9F0A";
	// garantir une luminosité lisible sur fond noir
	const max = Math.max(best.r, best.g, best.b);
	const k = max < 200 ? 200 / Math.max(1, max) : 1;
	const hex = (x: number) => Math.round(Math.min(255, x * k)).toString(16).padStart(2, "0");
	return `#${hex(best.r)}${hex(best.g)}${hex(best.b)}`;
}

/** Pochette seule en tuile 144 px (JPEG data-URI), utilisée par le bouton Playlist. */
export async function renderSingle(art: Img, dimmed = false): Promise<string> {
	const t = art.clone().cover({ w: TILE, h: TILE }) as Img;
	if (dimmed) dim(t, 0.55);
	return t.getBase64("image/jpeg", { quality: 90 });
}
