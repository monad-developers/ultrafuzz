# Monad Bugfinder Context

Ultrafuzz is related to the broader Monad Bugfinder direction: use agentic
systems to generate leads, preserve evidence, and force validation before
humans act on a security claim.

The background write-up is the
[Monad Bugfinder blog post](https://blog.monad.xyz/blog/monad-bugfinder).

## What Carries Over

Ultrafuzz keeps several design lessons visible in a Solidity fuzzing workflow:

- Separate discovery from validation and reporting.
- Preserve run artifacts so claims can be audited later.
- Treat generated reports as allegations until evidence is reviewed.
- Prefer explicit validation gates and handoff files over loose prose-only
  coordination.
- Keep human reviewers in control of submissions and repository changes.

## What Is Different

Ultrafuzz is repository-local and Rust-native. It uses editable Markdown prompts
and topology YAML for campaign construction, CLI backends for agent execution,
and run directories for persisted state. It is intended to be understandable
and modifiable by researchers and protocol developers during a concrete audit
or hardening effort.
