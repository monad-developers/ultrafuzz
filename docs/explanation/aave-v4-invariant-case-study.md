# Aave v4 Invariant Case Study

This case study records what one generated Aave v4 invariant suite tested, what
its campaign artifacts found, and what that evidence cannot establish. It is a
bounded reading of one run, not a verdict on invariant testing or on Ultrafuzz's
advantage over a no-fuzz campaign. The original evidence and discussion were
captured in [issue #405](https://github.com/monad-developers/ultrafuzz/issues/405).

## Scope and Provenance

The evidence came from run
`aave-v4-v0012-main-issue328fix-r52-invariant-only` (R52). Its
`stateful-invariant-implement-properties` artifact contained 13 properties and
about 33 KB of generated `Properties.sol` code. The target was upstream
`aave/aave-v4` at commit
`6959e3219b5506bf2acae18551cbb2a68a5b8fba`.

Several limits apply before interpreting the result:

- This was one model, one lane, one target, and one run.
- `property-specification-fanin` failed, so the catalog supplied to property
  implementation was incomplete.
- Campaign artifacts contained usable failures, but the run was not a completed,
  scorable benchmark at the time; its pipeline was blocked by the findings
  schema-version problem tracked in
  [#356](https://github.com/monad-developers/ultrafuzz/issues/356).
- The run targeted upstream Aave v4 rather than the ScFuzzBench fork containing
  the injected reference bugs.
- There was no no-fuzz arm on the same target commit.

Those constraints make the artifacts useful for inspecting suite shape, but not
for comparing recall.

## What the Generated Suite Tested

The 13 generated properties fall into four groups:

| Class                                                   | Properties                                                                                                                 | Requires a sequence?                 |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| State-local conservation: sums of parts equal the whole | `catalogHubAssetAccounting`, `catalogHubSpokeAggregates`, `catalogSpokeReserveAndUserAccounting`, `catalogUserAccountData` | No; each is checkable in one state   |
| Math identity against a re-derived oracle               | `catalogPreviewRounding`, `catalogRoundTripPreviews`, `catalogInterestRateMath`, `catalogLiquidationBonusMath`             | No; each is a single-call comparison |
| Configuration and sanity                                | `catalogConfigurationBounds`, `catalogOracleSources`, `reconReservesStayListed`, `reconSetupStable`                        | No                                   |
| Temporal                                                | `catalogAddedSharePriceNonDecreasing`                                                                                      | Yes, with the limitations below      |

Twelve of the thirteen properties are state-local or single-call checks. They
can still expose a violation when fuzzed, but this artifact does not demonstrate
that fuzzing was necessary to derive them: they describe structural facts that
a no-fuzz agent can infer by reading the contracts.

The re-derived math identities have another limitation. For example,
`catalogPreviewRounding` compares `hub.previewAddByAssets(...)` with a local
`_mulDivDown(assets, shares + VIRTUAL_SHARES, ...)` calculation derived from the
implementation. That detects divergence between two code paths, but not a wrong
assumption shared by both.

## The Temporal Property and Its Blind Spots

The suite's one temporal property was:

```solidity
function property_catalogAddedSharePriceNonDecreasing() public view {
    if (!_before.initialized || !_after.initialized) return;
    if (_before.activeAddedShares == 0 || _after.activeAddedShares == 0) return;
    assert(_after.activeAddedAssets * _before.activeAddedShares
        >= _before.activeAddedAssets * _after.activeAddedShares);
}
```

Compared with ScFuzzBench's
`invariant_supplySharePriceAndDrawnIndexMonotonic`, it was weaker in two ways:

1. It compared only one before/after step. The reference compares against a
   ghost maximum observed across the sequence. Step-wise comparison is
   equivalent only when every state transition is wrapped by the snapshot
   machinery; an uninstrumented handler creates a hole that a retained maximum
   can still expose later.
2. It checked only the active asset and actor. The generated snapshot selected
   `activeAssetIndex % assets.length`, while the reference checked every asset.
   A handler acting on asset A could therefore perturb asset B invisibly, even
   though cross-asset effects through the shared Hub are exactly the kind of
   multi-transaction behavior the experiment is meant to test.

The generated `BeforeAfter.sol` was a 45-line, flat ten-field snapshot. The
reference used 89 lines and also tracked ghost maxima, an `Operation` enum, and
an `isAnyUserLiquidatable` flag.

## What Was Missing

There was no generated analogue of
`invariant_shouldNotBecomeLiquidatable`: no operation other than a price change
may make a user liquidatable. That property encodes economic intent across a
sequence rather than restating local code structure. The generated snapshot
could not express it because it recorded neither the operation nor whether any
user was liquidatable.

The suite also omitted the reference's deliberate v0, v1, and v2 formulations
of the solvency invariant. Those variants preserve competing definitions from
auditors and the protocol team instead of silently choosing one.

## What the Campaign Artifacts Found

The recovered R52 campaign artifacts contained three confirmed failures with
reproducers:

1. `catalogInterestRateMath` compared a stored drawn rate with a recomputation
   over view-accrued debt. The finding identified itself as a harness artifact.
2. `catalogHubSpokeAggregates` observed `getAddedAssets(0)=100000100301` against
   a Spoke sum of `100000100300`: a one-unit difference. The generated property
   used exact equality where the reference used a relative-difference check and
   a `MIN_TOTAL_SUPPLIED` floor, so rounding dust is the leading explanation.
3. `catalogAddedSharePriceNonDecreasing` reproduced a borrow, one second of
   accrual, and a supply before the exchange ratio decreased. This was a genuine
   three-step sequence and the only result with the shape the experiment was
   intended to distinguish, but the missing tolerance means dust remained a
   plausible explanation.

These are campaign leads, not three established protocol bugs. The first was
self-classified as a harness problem, and the latter two require tolerance-aware
validation.

## What Would Answer the Comparison Question

A defensible invariant-versus-no-fuzz comparison needs all of the following:

1. Target the ScFuzzBench fork at the commit corresponding to the selected
   ground truth, rather than upstream Aave v4.
2. Complete the full benchmark pipeline and score its campaign without an
   artifact-contract or pipeline blocker.
3. Run a no-fuzz arm against the same target commit and model conditions.
4. Repeat both arms and compare recall against the known bug set, split by
   whether each bug requires a transaction sequence.

Until then, a completed run can show that the pipeline works and reveal the
shape of generated properties. It cannot show whether those properties find the
bugs for which stateful fuzzing should have the strongest edge.

## Follow-up Engineering Seams

This case study exposes three narrow, independently testable improvements:

- Generate conservation properties with target-appropriate absolute or
  relative tolerances and explicit minimum-value floors instead of unconditional
  exact equality.
- Give `BeforeAfter` scaffolding ghost state and operation tracking so generated
  properties can express sequence-wide monotonicity and operation-conditioned
  safety.
- Reject or clearly mark an evaluation whose target repository and ground-truth
  repository describe different codebases, before reporting meaningful recall.

Each improvement should be evaluated separately. None changes the evidentiary
limits of the historical R52 run.
