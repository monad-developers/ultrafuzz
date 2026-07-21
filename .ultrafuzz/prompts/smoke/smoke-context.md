---
id: smoke-context
display_name: Build smoke benchmark context
---

# Build smoke benchmark context

Create one compact, source-backed map that lets eight parallel bug-finding
strategies start immediately. Inspect only this target checkout. Do not read or
search benchmark ground truth, expected findings, audit answers, sibling target
checkouts, or prior Ultrafuzz runs.

Identify:

- the native framework (Foundry, Hardhat, or the repository's existing Vyper
  Python stack), checked-in test roots, focused test commands, fixtures, and
  locally available dependencies;
- externally callable state-changing and view surfaces, actors, privileged
  roles, pause/configuration controls, and lifecycle states;
- value/accounting stores, rounding and conversion boundaries, cached or
  externally supplied state, time/block-dependent behavior, and AMM/liquidity
  interactions that actually exist in the target; and
- a short property catalog prioritizing asset conservation, authorization,
  state-transition consistency, view/state agreement, stale-dependency
  behavior, and empty/terminal lifecycle boundaries.

Use exact source paths and function names. Keep the map bounded: prioritize the
highest-signal modules instead of exhaustively documenting the repository. Do
not install or fetch dependencies and do not edit production code. Record an
unavailable runner or dependency as blocked while continuing source analysis.

Write the result to `{{artifact_path}}/smoke-context.md` with sections for
framework, actors, high-signal surfaces, native validation commands, and target
properties.
