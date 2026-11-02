## Design specs

- Design specs are Markdown files with `id` and `type` frontmatter whose `paths` name the files they govern. The hub names the specs covering a task when you propose or accept it, and `hub_specs` answers on request.
- Read a covering spec when your change touches a boundary, contract, invariant or decision it states. Follow it, or reconcile the contradiction; never silently diverge.
- When your change alters one of those, update the owning spec in the same change. Never edit `verified-against`; a person stamps it.
