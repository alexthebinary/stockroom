// A fake camera feed for Chromium: the sample widget's barcode on white for
// 3 s, then an empty frame for 2 s, looping. Same barcode library the app
// uses for its printable test sheet, so the e2e scans what a person would.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { prepareZXingModule, writeBarcode } from "zxing-wasm/writer";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
prepareZXingModule({ overrides: { wasmBinary: readFileSync(require.resolve("zxing-wasm/writer/zxing_writer.wasm")) }, fireImmediately: true });

const out = join(here, "widget.y4m");
const png = join(here, "widget.png");
const result = await writeBarcode("012345678905", { format: "UPCA", scale: 5, addQuietZones: true });
if (!result.image) throw new Error(`barcode writer failed: ${result.error}`);
writeFileSync(png, Buffer.from(await result.image.arrayBuffer()));

execFileSync("ffmpeg", [
  "-loglevel", "error", "-y",
  "-f", "lavfi", "-i", "color=c=white:s=1280x720:r=15:d=3",
  "-i", png,
  "-f", "lavfi", "-i", "color=c=0xe8e8e0:s=1280x720:r=15:d=2",
  "-filter_complex", "[0][1]overlay=(W-w)/2:(H-h)/2:shortest=1[a];[a][2]concat=n=2:v=1[v]",
  "-map", "[v]", "-pix_fmt", "yuv420p", out,
]);
console.log(`wrote ${out}`);
