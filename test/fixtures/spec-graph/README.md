Derived from vault-mem#91 pending its T6 conformance fixture.

This issue-derived fixture covers the schema owner's published error and warning classes; agent-hub does not import vault-mem code.

Discovery requires both `id` and `type` keys. A file missing either key is ignored silently, including the missing-id and missing-type payloads. Present but empty or malformed values are validated as errors. The missing-title payload covers the required-field error class. Payloads use `.md.fixture` and are restored to Markdown only in temporary test repositories.
