import { definitionOf } from "../../src/adapters/registry.ts";
import { registerLocalConformance, registerPiConformance } from "../../src/adapters/conformance/local-pi.ts";
registerLocalConformance(definitionOf("local")!, { label: "local" });
registerPiConformance(definitionOf("pi")!, { label: "Pi" });
