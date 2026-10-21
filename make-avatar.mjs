// make-avatar.mjs — writes the profile picture to ./brand/ (SVG + 1024px PNG).
//   node make-avatar.mjs
import fs from "node:fs";
import { buildAvatarSvg, renderSvgToPng } from "./cards.mjs";

fs.mkdirSync("brand", { recursive: true });
const svg = buildAvatarSvg({ size: 1024 });
fs.writeFileSync("brand/the-tape-avatar.svg", svg);
console.log("wrote brand/the-tape-avatar.svg");
const png = await renderSvgToPng(svg, { scale: 1 });
if (png) { fs.writeFileSync("brand/the-tape-avatar.png", png); console.log("wrote brand/the-tape-avatar.png  <- upload this one"); }
else console.log("PNG renderer missing: npm install --no-save @resvg/resvg-js");
