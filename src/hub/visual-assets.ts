import { basename, extname } from "node:path";
import { readGuardedDeliverable, type DeliverablePorts } from "./deliverable-files.ts";
import type { VisualFile, VisualInput, VisualInputSide, VisualPayload, VisualSide } from "./visual.ts";
export type { VisualFile } from "./visual.ts";

export const VISUAL_ASSET_BYTES = 8 * 1024 * 1024;
export class VisualAssetRefusal extends Error {}
const refuse = (field: string, cause: string, next: string): never => { throw new VisualAssetRefusal(`visual ${field}: ${cause}; ${next}`); };

/** Check both the caller's extension and the actual bytes. No active SVG/XML format is served. */
function imageMime(path: string, data: Uint8Array): VisualFile["mime"] | undefined {
  const extension = extname(path).toLowerCase();
  if (extension === ".png" && data.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => data[index] === value)) return "image/png";
  if ([".jpg", ".jpeg"].includes(extension) && data.length >= 3 && data[0] === 255 && data[1] === 216 && data[2] === 255) return "image/jpeg";
  if (extension === ".webp" && data.length >= 12 && data[0] === 82 && data[1] === 73 && data[2] === 70 && data[3] === 70
    && data[8] === 87 && data[9] === 69 && data[10] === 66 && data[11] === 80) return "image/webp";
  return undefined;
}
const choose = "choose a public project PNG, JPEG or WebP file no larger than 8 MiB and retry";

/** Input text/path screening belongs to visual.ts; this path adds host-owned byte, content and physical-file evidence only. */
export async function resolveVisualAssets(input: VisualInput, id: string, ports: DeliverablePorts): Promise<{ payload: VisualPayload; files: VisualFile[] }> {
  if (input.kind !== "beforeAfter") return { payload: input, files: [] };
  const files: VisualFile[] = [], identities: { dev: number; ino: number }[] = [];
  const side = async (value: VisualInputSide, name: "before" | "after"): Promise<VisualSide> => {
    if ("text" in value) return value;
    let read: Awaited<ReturnType<typeof readGuardedDeliverable>>;
    try { read = await readGuardedDeliverable(value.path, ports, VISUAL_ASSET_BYTES); }
    catch { return refuse(`${name}.path`, "the image is unavailable or not allowed", choose); }
    const mime = imageMime(value.path, read.data);
    if (!mime) return refuse(`${name}.path`, "only PNG, JPEG or WebP image files are supported", "export a supported image and retry");
    if (identities.some(identity => identity.dev === read.identity.dev && identity.ino === read.identity.ino))
      return refuse(`${name}.path`, "before and after name the same physical file", "choose two different image files and retry");
    identities.push(read.identity);
    const asset = `${id}:${name}`;
    files.push({ asset, path: value.path, sha256: read.sha256, bytes: read.bytes, mime });
    return { asset, alt: value.alt };
  };
  const before = await side(input.before, "before"), after = await side(input.after, "after");
  return { payload: { kind: "beforeAfter", ...(input.caption !== undefined ? { caption: input.caption } : {}), before, after }, files };
}

/** Serve only freshly guarded bytes that still match the posted host-owned hash and MIME. */
export async function readVisualAsset(file: VisualFile, ports: DeliverablePorts): Promise<{ bytes: Uint8Array; mime: VisualFile["mime"]; name: string }> {
  try {
    const read = await readGuardedDeliverable(file.path, ports, VISUAL_ASSET_BYTES), mime = imageMime(file.path, read.data);
    if (read.sha256 !== file.sha256 || read.bytes !== file.bytes || !mime || mime !== file.mime) throw new Error("changed");
    return { bytes: read.data, mime, name: basename(file.path) };
  } catch { return refuse("asset", "changed since posted or no longer allowed", "post the visual again using a current public PNG, JPEG or WebP file"); }
}
