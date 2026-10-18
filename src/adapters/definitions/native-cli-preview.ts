import type { AdapterDefinition } from "../registry-types.ts";
import type { NativePreviewBuilder } from "./native-cli-preview-common.ts";
import { previewClaude } from "./native-cli-preview-claude.ts";
import { previewCodex } from "./native-cli-preview-codex.ts";
import { previewKimi } from "./native-cli-preview-kimi.ts";
import { previewPi } from "./native-cli-preview-pi.ts";
import { previewQwen } from "./native-cli-preview-qwen.ts";
import { previewJcode } from "./native-cli-preview-jcode.ts";

// Private implementations of the fixed builtin set; neither config nor an external definition can add callbacks.
const previews: Readonly<Record<string, NativePreviewBuilder>> = Object.freeze({
  claude: previewClaude, codex: previewCodex, kimi: previewKimi, pi: previewPi, qwen: previewQwen, jcode: previewJcode,
});
export function builtinPreview(definition: AdapterDefinition): NativePreviewBuilder | undefined {
  return Object.hasOwn(previews, definition.kind) ? previews[definition.kind] : undefined;
}
