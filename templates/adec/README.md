# ADEc policy examples

These are editable examples for the separately operated `adec` service. They
follow the public policy schema at [agent-decide commit 008548c5](https://github.com/STAIxBWLB/agent-decide/blob/008548c57d3b0983719826aae36288dc5e3bad31/src/policy.ts): `policyId`, `provider`, `instructions`, `candidates`, `default`, `contextLimit`, and `minMargin`.

Before a person copies a file into their ADEc policy directory, replace the
provider and every `replace-me-*` alias or effort with values that exist in
their own ADEc configuration and match the hub route's allowed candidate
pairs. Keep `default` equal to one candidate pair. `ahub.stage` uses `none`
effort for both options, matching the stage route contract. The plan/execute
`edit-effort` token is only a syntactically valid placeholder.

Every candidate sets `onPrem` explicitly to `false`. A person must verify a
model's actual serving location before changing this to `true`; a loopback hub
endpoint alone does not establish that the model itself is on-prem. Until then,
these examples are not suitable for sensitive routes that require an on-prem
candidate.

The `contextLimit` value `20000` and `minMargin` value `0.05` are example
settings, not measured or calibrated defaults. ADEc's `minMargin` is independent
of the hub's `ambiguous_band`.

Both policies are for model/effort selection only. They do not authorize or
apply a selection. The host keeps its existing route, phase transition, review
and escalation rules, and executes its existing fallback in `shadow` mode.
Decision mode remains off unless a person explicitly configures `shadow`.
`enforce` is refused. The hub does not access the ADEc home; the person owns
local policy placement and service configuration.

No provider, alias, effort, latency gain, live model behavior, or production
readiness is established by these examples. The manual model-routing receipt
and live benchmark remain unrun.
