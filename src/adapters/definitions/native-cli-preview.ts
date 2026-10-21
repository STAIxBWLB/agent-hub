import type { AdapterDefinition } from "../registry-types.ts";
import type { NativePreviewBuilder } from "./native-cli-preview-common.ts";

/** The host admits builtin-only preview ports before calling this projection. */
export function builtinPreview(definition: AdapterDefinition): NativePreviewBuilder | undefined {
  return definition.cli.preview;
}
