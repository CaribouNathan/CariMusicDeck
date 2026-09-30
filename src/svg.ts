// Rendus SVG des touches (144×144). Stream Deck rasterise lui-même le SVG : texte net, aucune dépendance.
// SVG volontairement simple (pas de clipPath/filtres) pour le moteur SVG de Stream Deck.

const S = 144;
const FONT = "Helvetica Neue, Helvetica, Arial, sans-serif";
export const WHITE = "#FFFFFF";
export const GRAY = "#8E8E93";
export const DIM = "#48484A";
const TRACK = "#2C2C2E";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function svgUri(body: string, bg = "#000000"): string {
	const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}" viewBox="0 0 ${S} ${S}"><rect x="0" y="0" width="${S}" height="${S}" fill="${bg}"/>${body}</svg>`;
	return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

// ---------------------------------------------------------------- texte

/** Largeur approximative (em) d'un caractère en Helvetica Neue gras. */
function charW(ch: string): number {
	if (" ".includes(ch)) return 0.28;
	if ("il.,:;'|!ìíîï".includes(ch)) return 0.28;
	if ("fjtrI()[]-".includes(ch)) return 0.37;
	if ("mwMW@".includes(ch)) return 0.9;
	if (/[0-9]/.test(ch)) return 0.58;
	if (/[A-ZÀ-Ý]/.test(ch)) return 0.7;
	if (/[a-zß-ÿ]/.test(ch)) return 0.58;
	return 0.62;
}
export const textWidth = (s: string, size: number) => [...s].reduce((w, c) => w + charW(c), 0) * size;

function wrap(text: string, size: number, maxW: number): string[] {
	const words = text.split(/\s+/).filter(Boolean);
	const lines: string[] = [];
	let line = "";
	for (const w of words) {
		const cand = line ? `${line} ${w}` : w;
		if (textWidth(cand, size) <= maxW || !line) line = cand;
		else {
			lines.push(line);
			line = w;
		}
	}
	if (line) lines.push(line);
	return lines;
}

function ellipsize(s: string, size: number, maxW: number): string {
	if (textWidth(s, size) <= maxW) return s;
	let t = s;
	while (t.length > 1 && textWidth(`${t}…`, size) > maxW) t = t.slice(0, -1);
	return `${t.trimEnd()}…`;
}

export interface Fitted {
	size: number;
	lines: string[];
}

/** Plus grande taille pour laquelle le texte tient dans la boîte (retour à la ligne, maxLines). */
export function fitText(text: string, maxW: number, maxH: number, maxLines: number, maxSize: number, minSize: number): Fitted {
	const t = text.trim() || "—";
	for (let size = maxSize; size >= minSize; size--) {
		const lines = wrap(t, size, maxW);
		if (lines.length <= maxLines && lines.every((l) => textWidth(l, size) <= maxW) && lines.length * size * 1.12 <= maxH) return { size, lines };
	}
	const lines = wrap(t, minSize, maxW).slice(0, maxLines);
	const full = wrap(t, minSize, maxW);
	if (full.length > maxLines) lines[maxLines - 1] = `${lines[maxLines - 1]}…`;
	return { size: minSize, lines: lines.map((l) => ellipsize(l, minSize, maxW)) };
}

function textBlock(f: Fitted, cy: number, color: string, weight = "bold"): string {
	const lh = f.size * 1.12;
	const top = cy - (f.lines.length * lh) / 2 + f.size * 0.82;
	return f.lines
		.map(
			(l, i) =>
				`<text x="${S / 2}" y="${(top + i * lh).toFixed(1)}" font-family="${FONT}" font-size="${f.size}" font-weight="${weight}" fill="${color}" text-anchor="middle">${esc(l)}</text>`,
		)
		.join("");
}

function line(text: string, y: number, size: number, color: string, weight = "bold", maxW = 132): string {
	let sz = size;
	while (sz > 10 && textWidth(text, sz) > maxW) sz--;
	return `<text x="${S / 2}" y="${y}" font-family="${FONT}" font-size="${sz}" font-weight="${weight}" fill="${color}" text-anchor="middle">${esc(ellipsize(text, sz, maxW))}</text>`;
}

function bar(y: number, frac: number, color: string, h = 8, x = 14, w = 116): string {
	const f = Math.max(0, Math.min(1, frac));
	const fw = Math.max(f > 0 ? h : 0, w * f);
	return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${h / 2}" fill="${TRACK}"/>${fw ? `<rect x="${x}" y="${y}" width="${fw.toFixed(1)}" height="${h}" rx="${h / 2}" fill="${color}"/>` : ""}`;
}

// ---------------------------------------------------------------- icônes

const PLAY = (c: string) => `<path d="M52 36 L52 108 L108 72 Z" fill="${c}" stroke="${c}" stroke-width="6" stroke-linejoin="round"/>`;
const PAUSE = (c: string) => `<rect x="44" y="38" width="20" height="68" rx="5" fill="${c}"/><rect x="80" y="38" width="20" height="68" rx="5" fill="${c}"/>`;

export const playPauseKey = (playing: boolean | null) =>
	svgUri(playing ? PAUSE(WHITE) : PLAY(playing === null ? DIM : WHITE));

export function skipKey(dir: "prev" | "next", color: string, caption?: string): string {
	const m = (x: number) => (dir === "next" ? x : S - x);
	const tri = (x0: number) =>
		`<path d="M${m(x0)} 46 L${m(x0)} 98 L${m(x0 + 32)} 72 Z" fill="${color}" stroke="${color}" stroke-width="4" stroke-linejoin="round"/>`;
	const barX = dir === "next" ? 102 : S - 102 - 9;
	const body = `${tri(36)}${tri(68)}<rect x="${barX}" y="44" width="9" height="56" rx="3" fill="${color}"/>`;
	if (!caption) return svgUri(body);
	return svgUri(`<g transform="translate(0,-14)">${body}</g>${line(caption, 124, 24, color)}`);
}

export function shuffleKey(on: boolean | null, accent: string): string {
	const c = on ? accent : on === null ? DIM : GRAY;
	const st = `fill="none" stroke="${c}" stroke-width="8" stroke-linecap="round" stroke-linejoin="round"`;
	return svgUri(
		`<path d="M30 48 H48 C70 48 74 96 96 96 H112" ${st}/><path d="M30 96 H48 C70 96 74 48 96 48 H112" ${st}/>` +
			`<path d="M100 36 L113 48 L100 60" ${st}/><path d="M100 84 L113 96 L100 108" ${st}/>` +
			(on ? `<circle cx="72" cy="128" r="5" fill="${accent}"/>` : ""),
	);
}

export function repeatKey(mode: "off" | "one" | "all" | null, accent: string): string {
	const c = mode === "all" || mode === "one" ? accent : mode === null ? DIM : GRAY;
	const st = `fill="none" stroke="${c}" stroke-width="8" stroke-linecap="round" stroke-linejoin="round"`;
	return svgUri(
		`<path d="M36 70 V62 C36 52 43 46 53 46 H106" ${st}/><path d="M96 34 L108 46 L96 58" ${st}/>` +
			`<path d="M108 74 V82 C108 92 101 98 91 98 H38" ${st}/><path d="M48 86 L36 98 L48 110" ${st}/>` +
			(mode === "one" ? `<text x="72" y="83" font-family="${FONT}" font-size="30" font-weight="bold" fill="${c}" text-anchor="middle">1</text>` : "") +
			(mode === "one" || mode === "all" ? `<circle cx="72" cy="130" r="5" fill="${accent}"/>` : ""),
	);
}

// ---------------------------------------------------------------- touches texte

export function titleKey(text: string, dimmed: boolean): string {
	const f = fitText(text, 132, 132, 4, 34, 13);
	return svgUri(textBlock(f, 72, dimmed ? GRAY : WHITE));
}

export function infoKey(codec: string, quality: string, position: string, accent: string, dimmed: boolean): string {
	const c = dimmed ? GRAY : WHITE;
	return svgUri(
		line(codec || "—", 50, 36, c) + line(quality || " ", 88, 24, dimmed ? DIM : GRAY, "normal") + line(position || " ", 126, 28, dimmed ? DIM : accent),
	);
}

export const fmtTime = (ms: number) => {
	const t = Math.max(0, Math.floor(ms / 1000));
	const h = Math.floor(t / 3600);
	const m = Math.floor((t % 3600) / 60);
	const s = String(t % 60).padStart(2, "0");
	return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
};

export function timeKey(posMs: number, durMs: number, mode: "total" | "remaining", accent: string, dimmed: boolean): string {
	const big = fmtTime(posMs);
	const small = durMs > 0 ? (mode === "remaining" ? `-${fmtTime(durMs - posMs)}` : fmtTime(durMs)) : "--:--";
	return svgUri(
		line(big, 64, 44, dimmed ? GRAY : WHITE) +
			line(small, 102, 30, dimmed ? DIM : GRAY, "normal") +
			bar(118, durMs > 0 ? posMs / durMs : 0, dimmed ? DIM : accent, 10),
	);
}

function starPoints(cx: number, cy: number, R: number): [number, number][] {
	const pts: [number, number][] = [];
	for (let i = 0; i < 10; i++) {
		const r = i % 2 === 0 ? R : R * 0.46;
		const a = -Math.PI / 2 + (i * Math.PI) / 5;
		pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
	}
	return pts;
}
const poly = (pts: [number, number][]) => pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");

export function ratingKey(rating: number | null, accent: string, showLabel: boolean): string {
	const cy = showLabel ? 86 : 72;
	const R = 13.5;
	let body = showLabel ? line(rating === null ? "NOTE —" : "NOTE", 40, 18, GRAY) : "";
	for (let i = 0; i < 5; i++) {
		const cx = 18 + i * 27;
		const pts = starPoints(cx, cy, R);
		const v = rating === null ? 0 : rating - i * 2; // 2 = pleine, 1 = demie
		body += `<polygon points="${poly(pts)}" fill="${TRACK}" stroke="${rating === null ? TRACK : "#636366"}" stroke-width="1.5" stroke-linejoin="round"/>`;
		if (v >= 2) body += `<polygon points="${poly(pts)}" fill="${accent}"/>`;
		else if (v === 1) {
			// moitié gauche : sommet, sommets de gauche, creux inférieur (sur l'axe)
			body += `<polygon points="${poly([pts[0], pts[9], pts[8], pts[7], pts[6], pts[5]])}" fill="${accent}"/>`;
		}
	}
	return svgUri(body);
}

export function volumeKey(dir: "up" | "down", level: number | null, muted: boolean, accent: string): string {
	const c = level === null ? DIM : WHITE;
	const speaker = `<path d="M22 34 H36 L54 20 V68 L36 54 H22 Z" fill="${c}" stroke="${c}" stroke-width="3" stroke-linejoin="round"/>`;
	const wave = (r: number) => `<path d="M${62} ${44 - r} C${62 + r * 0.7} ${44 - r * 0.5} ${62 + r * 0.7} ${44 + r * 0.5} ${62} ${44 + r}" fill="none" stroke="${c}" stroke-width="5" stroke-linecap="round"/>`;
	const waves = muted
		? `<path d="M64 32 L84 56 M84 32 L64 56" stroke="${accent}" stroke-width="6" stroke-linecap="round"/>`
		: (level ?? 0) > 0
			? wave(10) + ((level ?? 0) > 50 ? wave(20) : "")
			: "";
	const sign =
		dir === "up"
			? `<path d="M106 44 H130 M118 32 V56" stroke="${c}" stroke-width="7" stroke-linecap="round"/>`
			: `<path d="M106 44 H130" stroke="${c}" stroke-width="7" stroke-linecap="round"/>`;
	const label = muted ? "MUET" : level === null ? "—" : `${level}%`;
	return svgUri(speaker + waves + sign + line(label, 108, 34, muted ? accent : c) + bar(120, muted ? 0 : (level ?? 0) / 100, level === null ? DIM : accent, 10));
}

export function playlistKey(name: string): string {
	const st = `stroke="${GRAY}" stroke-width="6" stroke-linecap="round"`;
	const icon = `<path d="M34 26 H86 M34 42 H86 M34 58 H70" ${st}/><path d="M92 50 L112 62 L92 74 Z" fill="${GRAY}"/>`;
	const f = fitText(name || "Playlist", 132, 58, 2, 24, 12);
	return svgUri(icon + textBlock(f, 110, WHITE));
}

export const idleKey = (label = "—") => svgUri(line(label, 84, 30, DIM));

// ---------------------------------------------------------------- favori (Apple Music)

export function heartKey(fav: boolean | null, accent: string, showLabel: boolean, label = "FAVORI"): string {
	const cy = showLabel ? 84 : 72;
	const c = fav === null ? DIM : fav ? accent : "#636366";
	// cœur 72×64 centré
	const d = `M72 ${cy + 30} C 20 ${cy - 4}, 30 ${cy - 44}, 72 ${cy - 18} C 114 ${cy - 44}, 124 ${cy - 4}, 72 ${cy + 30} Z`;
	const shape = fav
		? `<path d="${d}" fill="${c}" stroke="${c}" stroke-width="4" stroke-linejoin="round"/>`
		: `<path d="${d}" fill="none" stroke="${c}" stroke-width="7" stroke-linejoin="round"/>`;
	return svgUri((showLabel ? line(label, 30, 18, GRAY) : "") + `<g transform="translate(72 ${cy}) scale(1.3) translate(-72 ${-cy})">${shape}</g>`);
}

// ---------------------------------------------------------------- texte défilant

/** Le texte tient-il (3 lignes max) sans descendre sous une taille confortable ? */
export function fitsComfortably(text: string, minSize = 20): boolean {
	const t = text.trim() || "—";
	for (let size = 34; size >= minSize; size--) {
		const lines = wrap(t, size, 132);
		if (lines.length <= 3 && lines.every((l) => textWidth(l, size) <= 132) && lines.length * size * 1.12 <= 132) return true;
	}
	return false;
}

/** Une ligne en grand qui défile horizontalement ; offset en px depuis le début. */
export function marqueeKey(text: string, offsetPx: number, dimmed: boolean, size = 38): string {
	const gap = size * 1.6;
	const w = textWidth(text, size) + gap;
	const x = 8 - (offsetPx % w);
	const t = (xx: number) =>
		`<text x="${xx.toFixed(1)}" y="${72 + size * 0.36}" font-family="${FONT}" font-size="${size}" font-weight="bold" fill="${dimmed ? GRAY : WHITE}">${esc(text)}</text>`;
	return svgUri(t(x) + t(x + w));
}
export const marqueeCycle = (text: string, size = 38) => textWidth(text, size) + size * 1.6;

// ---------------------------------------------------------------- radio (CariRadio)

export function radioKey(state: "off" | "idle" | "playing" | "paused", accent: string, name: string): string {
	const live = state === "playing";
	const c = state === "off" ? GRAY : WHITE;
	const w = live ? "#FF453A" : c;
	const st = `fill="none" stroke="${w}" stroke-width="7" stroke-linecap="round"`;
	const cx = 72;
	const cy = 54;
	const arcs =
		`<path d="M${cx - 18} ${cy - 16} A 24 24 0 0 0 ${cx - 18} ${cy + 16}" ${st}/><path d="M${cx + 18} ${cy - 16} A 24 24 0 0 1 ${cx + 18} ${cy + 16}" ${st}/>` +
		`<path d="M${cx - 32} ${cy - 28} A 42 42 0 0 0 ${cx - 32} ${cy + 28}" ${st}/><path d="M${cx + 32} ${cy - 28} A 42 42 0 0 1 ${cx + 32} ${cy + 28}" ${st}/>`;
	const mast = `<circle cx="${cx}" cy="${cy}" r="9" fill="${c}"/><path d="M${cx - 4} ${cy + 6} L${cx + 4} ${cy + 6} L${cx + 10} ${cy + 34} L${cx - 10} ${cy + 34} Z" fill="${c}"/>`;
	const label = state === "playing" ? "EN DIRECT" : state === "paused" ? "EN PAUSE" : state === "idle" ? "PRÊT" : name;
	void accent;
	return svgUri(arcs + mast + line(label, 124, 20, live ? "#FF453A" : state === "off" ? GRAY : WHITE));
}

// ---------------------------------------------------------------- station favorite (CariRadio)

/** Touche Station sans logo : initiales dans une pastille + nom. */
export function stationKey(name: string, accent: string, current: boolean, playing: boolean): string {
	const initials =
		name
			.replace(/[^\p{L}\p{N} ]/gu, "")
			.split(/\s+/)
			.filter(Boolean)
			.slice(0, 2)
			.map((w) => w[0])
			.join("")
			.toUpperCase() || "♪";
	const ring = playing ? "#FF453A" : current ? accent || WHITE : GRAY;
	const disc = `<circle cx="72" cy="56" r="34" fill="none" stroke="${ring}" stroke-width="5"/>` + line(initials, 70, 34, playing ? WHITE : current ? WHITE : GRAY, "bold", 56);
	const f = fitText(name || "Station", 132, 34, 1, 22, 12);
	return svgUri(disc + textBlock(f, 118, playing ? WHITE : GRAY));
}
