import role0 from "../../templates/roles/dev/software-architect.md" with { type: "text" };
import role1 from "../../templates/roles/dev/backend-engineer.md" with { type: "text" };
import role2 from "../../templates/roles/dev/frontend-engineer.md" with { type: "text" };
import role3 from "../../templates/roles/dev/test-engineer.md" with { type: "text" };
import role4 from "../../templates/roles/dev/code-reviewer.md" with { type: "text" };
import role5 from "../../templates/roles/dev/security-reviewer.md" with { type: "text" };
import role6 from "../../templates/roles/research/research-lead.md" with { type: "text" };
import role7 from "../../templates/roles/research/researcher.md" with { type: "text" };
import role8 from "../../templates/roles/research/analyst.md" with { type: "text" };
import role9 from "../../templates/roles/research/statistician.md" with { type: "text" };
import role10 from "../../templates/roles/research/fact-checker.md" with { type: "text" };

import role11 from "../../templates/roles/writing/editor.md" with { type: "text" };
import role12 from "../../templates/roles/writing/translator.md" with { type: "text" };
import role13 from "../../templates/roles/writing/style-checker.md" with { type: "text" };
import role14 from "../../templates/roles/writing/terminology-checker.md" with { type: "text" };
import role15 from "../../templates/roles/ops/project-manager.md" with { type: "text" };
import role16 from "../../templates/roles/ops/meeting-actions-owner.md" with { type: "text" };

export const SHIPPED_ROLES: Readonly<Record<string, string>> = {
  "software-architect": role0,
  "backend-engineer": role1,
  "frontend-engineer": role2,
  "test-engineer": role3,
  "code-reviewer": role4,
  "security-reviewer": role5,
  "research-lead": role6,
  "researcher": role7,
  "analyst": role8,
  "statistician": role9,
  "fact-checker": role10,
  "editor": role11,
  "translator": role12,
  "style-checker": role13,
  "terminology-checker": role14,
  "project-manager": role15,
  "meeting-actions-owner": role16,
};
