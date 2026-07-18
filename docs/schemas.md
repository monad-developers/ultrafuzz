# Ultrafuzz Schemas

Ultrafuzz publishes JSON Schema snapshot files in the repository so generated
artifacts and topology exports can carry stable `$id` values.

The canonical schema ID namespace is the Monad Ultrafuzz blog post URL with
schema fragments:

- `https://blog.monad.xyz/blog/ultrafuzz#schema/topology/expanded-graph`
- `https://blog.monad.xyz/blog/ultrafuzz#schema/artifacts/finding`
- `https://blog.monad.xyz/blog/ultrafuzz#schema/artifacts/findings`
- `https://blog.monad.xyz/blog/ultrafuzz#schema/artifacts/run-state`
- `https://blog.monad.xyz/blog/ultrafuzz#schema/artifacts/usage-ledger`

These IDs are demonstrative identifiers for schema identity and `$ref` targets.
They are not hosted schema URLs, and clients should not expect HTTP requests to
those fragment URLs to return JSON Schema documents. Use the checked-in schema
files under `packages/topology/schema/` and `packages/artifacts/schema/` as the
resolvable documents.
