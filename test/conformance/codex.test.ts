import { definitionOf } from "../../src/adapters/registry.ts";
import { registerCodexConformance } from "../../src/adapters/conformance/codex.ts";
registerCodexConformance(definitionOf("codex")!, { label: "Codex" });
