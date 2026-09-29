// Bundle du plugin : src/plugin.ts → fr.cariboulabs.caricover.sdPlugin/bin/plugin.js
import { build } from "esbuild";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { makeProfile } from "./assets/make_profile.mjs";

const out = "fr.cariboulabs.caricover.sdPlugin/bin";
await mkdir(out, { recursive: true });
await build({
	entryPoints: ["src/plugin.ts"],
	outfile: `${out}/plugin.js`,
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node24",
	minify: true,
	legalComments: "none",
	banner: { js: 'import { createRequire as __cr } from "node:module"; const require = __cr(import.meta.url);' },
	logLevel: "info",
});
await writeFile(`${out}/package.json`, '{ "type": "module" }\n');

const manifest = JSON.parse(await readFile("fr.cariboulabs.caricover.sdPlugin/manifest.json", "utf8"));
console.log("  profil :", await makeProfile(manifest.Version));
