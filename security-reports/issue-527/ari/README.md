# Aggregate Risk Index (ARI)

*Specification v1.1 — a risk metric for threat models. For human readers and for agents generating or refreshing a threat model.*

---

## 1. What ARI is, and why it's useful

A threat model produces a *list* — assets, threats, countermeasures. The frameworks that generate that list (STRIDE, LINDDUN, PASTA, attack trees) deliberately stop there: they give you no single number. So the questions a team actually asks go unanswered — *"Are we more or less exposed than we were last quarter?"*, *"Which of these two designs is safer?"*, *"Did that hardening PR actually move the needle?"*

**ARI answers those.** It is a single **0–100 index** that summarizes an entire threat model in one figure: *how much of the risk you have identified remains unmitigated*, weighted by each threat's severity and discounted by how well controls cover it.

- **Lower is safer.** `0` means every threat is eliminated or deeply mitigated; `100` means every threat is wide open. The index maps to an **A–F grade**.
- **It is built for comparison over time.** Because it is normalized (a percentage of the model's own worst case), it is comparable across versions of one model, across proposed redesigns, and even across different apps — none of which a raw count or sum of threats supports.
- **It is a coverage index, not an actuarial estimate.** ARI measures how well your identified risk is *covered by controls*, tracked consistently across versions. It is not an industry standard and does not try to be (see §7); its value is comparability within one model's life, nothing more.

**Name and direction.** ARI = *Aggregate Risk Index* — a normalized index in the literal sense, not a running total. Lower is safer. The un-normalized weighted sum is still reported alongside it as **Risk Mass (RM)**, a secondary diagnostic used for version-to-version deltas (§3.2).

---

## 2. How ARI is calculated

*This section is the core of the metric — the part a threat-modeling skill should embed directly.*

### 2.1 At a glance

Every threat `T` contributes `severity_weight(T) × gap(T)`. Sum those contributions (**Risk Mass**), divide by the maximum the model could carry (**Risk Capacity**), and scale to 100:

```
ARI = 100 × Σ severity_weight(T) · gap(T)  /  Σ severity_weight(T) · 1.0        ∈ [0, 100],  lower is safer
        ╰──────────── Risk Mass ───────────╯    ╰──── Risk Capacity ────╯
```

Three inputs feed it: a **severity weight** (§2.2), a per-threat **coverage gap** (§2.3), and **normalization** (§2.4). The **grade** comes from the ARI plus severity gates (§2.5). A reference implementation is in §2.6.

### 2.2 Severity weight

Derive each threat's severity from Likelihood × Impact (per the threat model's severity matrix), then weight it:

```
severity_weight:  Low = 1    Medium = 3    High = 5    [Critical = 8, if the model uses a Critical tier]
```

If your model has no Critical tier, leave Highs at 5. Whatever you choose, fix it and hold it constant across the model's version history.

### 2.3 Coverage gap — the per-threat residual

The coverage gap is the fraction of a threat's risk that **remains after its controls**. It is computed from *all* of a threat's countermeasures, combined multiplicatively.

**Per-control effectiveness and leakage.** Each countermeasure has an **effectiveness** `e` (the fraction of risk it removes) and a **leakage** `1 − e` (the fraction it leaves). Effectiveness is a continuous scale; the four status labels are **named default anchors** on it, so a model can be scored from the labels alone — or refined with justified custom values (see "Optional: justified levels," below).

| Status | Symbol | Default `e` | Leakage `1 − e` |
| --- | --- | --- | --- |
| **Eliminated** — attack surface or asset designed out (removed, not guarded) | 🚫 | 100% | **0.00** (absorbing) |
| **Applied** — control present in code, verified | ✅ | 80% | **0.20** |
| **Partial** — some aspects present, gaps remain | ⚠️ | 50% | **0.50** |
| **Not Applied** — planned/absent | ⬜ | 0% | *excluded* |

*Eliminated* is distinct from a strong mitigation: it means the surface is **gone** (deleted key, dropped endpoint, cut data field), so there is nothing left to fail. It is the only status that reaches `e = 100%`. Reserve it for genuine removal, not "we mitigated it really well."

**Combining controls (defense-in-depth).**

```
gap(T) =
   0.00                                          if any control of T is Eliminated (🚫)
   max(FLOOR, Π leakage(c) over present c)        otherwise        FLOOR = 0.03
```

Not-Applied controls are excluded (they are plans, not defenses). A threat with no Applied/Partial/Eliminated control has an empty product = `1.00` → fully open. The `FLOOR` encodes that a guarded risk never truly reaches zero — defects exist, monitoring lags, controls share failure modes; **only elimination clears the floor.**

| Controls present | gap | Reading |
| --- | --- | --- |
| none | **1.00** | fully open |
| 1 Partial | **0.50** | one half-built control |
| 2 Partial | 0.25 | |
| 1 Applied | **0.20** | one solid control — not near-zero |
| 1 Applied + 1 Partial | **0.10** | |
| 2 Applied (independent) | **0.04** | genuine defense-in-depth |
| ≥3 Applied (independent) | **0.03** | floored |
| any Eliminated | **0.00** | surface removed |

**Guardrail — independence.** Multiplicativity assumes controls fail *independently*. Two controls sharing a failure mode — same key, same platform, same library, same human approver — count as **one**. Don't inflate defense-in-depth by listing correlated controls; count the independent layers only.

**Optional — justified mitigation levels.** A control rarely lands exactly on 80% or 50%. An author **may** assign an explicit effectiveness `e` in place of a status default, *provided it is justified in writing* in that countermeasure's subsection. The status label still stands (for skimmers and for the severity gates); the percentage refines the leakage.

> *Example — a not-quite-complete CSP against XSS (a High threat, weight 5).* The only control is a CSP that blocks inline scripts and `eval`, but `script-src` still allows a third-party origin you can't guarantee is JSONP-free, and there's no server-side output encoding.
> - *Label-only:* `⚠️ Partial` → `e = 50%` → `gap = 0.50` → contributes `2.5`.
> - *Justified override:* *"blocks the inline/`eval` vectors that cover most payloads; residual is one un-vetted `script-src` origin and no output encoding"* → `e = 65%` → `gap = 0.35` → contributes `1.75`.
> - *After remediation:* drop the un-vetted origin (strict CSP, `e = 90%`) **and** add independent output encoding (`e = 70%`) → `0.10 × 0.30 = 0.03` (floored) → contributes `0.15`.

Custom levels are the most gameable input in the model, so they are fenced:

1. **Justify or default.** No written rationale → use the status default. A bare custom number is invalid.
2. **Conservative by default.** When unsure, round *down* (toward more leakage). The metric should never flatter the system.
3. **Quantize.** Use coarse steps (multiples of 5%). `73.4%` is false precision.
4. **No 100% short of elimination.** A mitigating control caps below 100%; the `0.03` floor backstops any single-control claim. If you think a control is ~100% effective, ask whether the surface is actually *eliminated*.
5. **`e > 80%` demands strong, specific justification** and invites scrutiny — especially when it would clear a severity gate (§2.5). A single unlayered control earning an A on a High is the classic abuse.
6. **Independence still governs combining.** Two justified controls sharing a failure mode are one control, whatever their percentages.

### 2.4 The index — normalization

Report a **density**, not a mass:

```
Risk Mass      RM = Σ severity_weight(T) · gap(T)      # weighted residual (secondary diagnostic)
Risk Capacity  RC = Σ severity_weight(T) · 1.0         # every threat fully open = Σ weights
ARI               = 100 × RM / RC                       # 0–100, lower is safer
```

ARI is the **weighted-average coverage gap across the model, as a percentage of the maximum risk this model could carry** — i.e., *what fraction of your identified risk is still unretired.* Normalization is what makes a larger, more thorough model score *better* when its extra threats are covered, rather than being penalized for its size:

- Adding a **well-mitigated** threat adds little to `RM` but a full weight to `RC` → ARI **drops**.
- Adding an **open** threat raises ARI — honestly.
- Because it's a percentage, it is comparable across models and apps of different sizes.

**Retention rule.** A mature model must *keep* retired threats as closed entries (Eliminated / Applied), not delete them. Deleting a mitigated threat shrinks `RC` and perversely *raises* ARI; retiring it in place (strikethrough, dated) grows `RC` and *lowers* ARI as risk is retired over time. Never-delete is a scoring requirement here, not just audit hygiene.

### 2.5 Grade

The grade comes from the ARI band, then is **capped** (never raised) by severity gates keyed on High/Critical threats (weight ≥ 5), so a pile of well-covered low-severity threats can't mask an open High:

| ARI (0–100) | Band | | Gate condition | Grade cap |
| --- | --- | --- | --- | --- |
| ≤ 10 | A | | Any High/Critical with `gap > 0.10` | no better than **B** |
| 10 – 25 | B | | Any High/Critical with `gap ≥ 0.50` | no better than **C** |
| 25 – 45 | C | | Two+ High/Critical with `gap ≥ 0.50` | no better than **D** |
| 45 – 70 | D | | Three+ High/Critical fully open (`gap = 1.0`) | **F** |
| > 70 | F | | | |

```
final_grade = worst( band(ARI), all triggered gate caps )
```

Anchors: everything eliminated or 2×-layered → ARI ≈ 3–9 (**A**); one solid control on every threat → ≈ 20 (**B**); everything half-built → ≈ 50 (**D**); everything open → 100 (**F**). The letter is coarse — **always report the number too**, because meaningful movement often happens within a band.

### 2.6 Reference implementation

```python
LEAKAGE = {"applied": 0.20, "partial": 0.50}       # eliminated handled separately; not_applied excluded
FLOOR   = 0.03
WEIGHT  = {"low": 1, "medium": 3, "high": 5, "critical": 8}

# A control is a status string, or a (status, effectiveness) tuple with a justified e < 1.0 (§2.3).
def _status(c):  return c[0] if isinstance(c, tuple) else c
def _leak(c):
    if isinstance(c, tuple):
        s, e = c
        return 0.0 if s == "eliminated" else 1.0 - e
    return LEAKAGE.get(c, 1.0)                       # unknown/absent -> no mitigation

def gap(controls):                                   # controls on one threat
    if any(_status(c) == "eliminated" for c in controls):
        return 0.0
    g = 1.0
    for c in controls:
        if _status(c) != "not_applied":
            g *= _leak(c)
    return max(FLOOR, g)                              # empty product == 1.0 (fully open)

def ari(threats):                                    # threats: list of (severity, [controls])
    rm = sum(WEIGHT[s] * gap(cs) for s, cs in threats)
    rc = sum(WEIGHT[s]           for s, cs in threats)
    return 0.0 if rc == 0 else 100.0 * rm / rc

def band(x):
    return "A" if x <= 10 else "B" if x <= 25 else "C" if x <= 45 else "D" if x <= 70 else "F"

def grade(threats):
    order = ["A", "B", "C", "D", "F"]
    highs = [gap(cs) for s, cs in threats if WEIGHT[s] >= 5]
    caps = [band(ari(threats))]
    if any(x > 0.10 for x in highs):          caps.append("B")
    if any(x >= 0.50 for x in highs):         caps.append("C")
    if sum(x >= 0.50 for x in highs) >= 2:    caps.append("D")
    if sum(x >= 1.00 for x in highs) >= 3:    caps.append("F")
    return max(caps, key=order.index)                # worst of band and all caps
```

---

## 3. Using ARI in a threat model

### 3.1 Presenting it

1. **In the Risk Index section**, state: **ARI = [X] / 100, Grade [A–F]** (Risk Mass [RM] over Risk Capacity [RC]).
2. **Show the breakdown**, e.g.: *"RC = 78. Open Highs contribute 25 of the 34.1 mass (T9, T13, T14); two partial Highs add 5; the rest is layered or eliminated. ARI = 100 × 34.1 / 78 = 43.7, Grade C — capped at C by two fully-open Highs."*
3. **Drive the Prioritized Remediation Backlog from it.** Rank open gaps by per-threat mass `severity_weight(T) × gap(T)` — the same term the ARI sums, so the backlog can never disagree with the grade. Note the ARI-point drop each fix yields: `ΔARI ≈ 100 × Δmass / RC`.
4. **In the Change Log**, record `ARI: old → new` and the `Δ_scope / Δ_controls` split (§3.2).
5. **For proposed redesigns**, project the post-change ARI (and its decomposition) so options compare on one bounded scale.
6. **Where a countermeasure uses a justified effectiveness** (§2.3), record the value and its one-line rationale in that countermeasure's subsection — e.g. `⚠️ Partial · e = 65% — blocks inline/eval vectors; residual is one un-vetted script-src origin`. A custom level with no rationale is invalid.

### 3.2 Comparing across versions

ARI's main job is comparability over a model's life. Three rules keep it sound:

1. **Version-anchor it.** An ARI is meaningful only relative to the model that produced it. Record it with the doc version and codebase snapshot it was computed against.
2. **Recompute history when scope changes.** When you add, retire, or re-weight threats, the previous ARI is no longer directly comparable. Recompute a **pivot** — previous control statuses over the *current* threat set — so reported deltas isolate control changes from scope changes.
3. **Report the delta decomposition** on every refresh:
   ```
   ΔARI = Δ_scope + Δ_controls
     Δ_scope    = ARI(new threat set, prior/as-found statuses)  −  ARI(previous)
     Δ_controls = ARI(new threat set, new statuses)             −  ARI(new threat set, prior/as-found statuses)
   ```
   Convention: a newly discovered threat enters the pivot at the status the code actually shows at discovery (a newly noticed but already-guarded threat is *scope*, not remediation); deliberate mitigation work in the same refresh is `Δ_controls`. This separates *"we got riskier"* from *"we modeled harder"* — see Example C.

---

## 4. Worked examples

### 4.1 A larger, more thorough model scores better

**Lazy model:** 2 High threats, both open. `RM = 2×5×1.0 = 10`, `RC = 10` → **ARI = 100, F**.
**Mature model:** 3 High threats, each 2×-layered (`gap 0.04`); 5 Medium threats still open. `RM = 3×5×0.04 + 5×3×1.0 = 15.6`, `RC = 30` → **ARI = 52, D**.

The mature model has a *higher* raw threat count and a higher Risk Mass, yet scores far better (52% vs 100% residual) — normalization rewards the diligence, and the grade correctly flags that five open Mediums keep it out of the top tiers.

### 4.2 Elimination and defense-in-depth register

A hardening change to three threats:

| Threat | Sev (wt) | Before | gap | After | gap |
| --- | --- | --- | --- | --- | --- |
| T_a Signing-key forgery | High (5) | 1 Applied (sig check) | 0.20 | **key eliminated** 🚫 | 0.00 |
| T_b Claim race | Med (3) | 1 Applied (lock) | 0.20 | **2 Applied** (lock + fenced token) | 0.04 |
| T_c Enumeration | Med (3) | none | 1.00 | docs only, no code | 1.00 |

`RC = 11`. **Before:** `RM = 5×0.20 + 3×0.20 + 3×1.0 = 4.6` → **ARI = 41.8**. **After:** `RM = 0 + 3×0.04 + 3×1.0 = 3.12` → **ARI = 28.4**.

The change is credited (−13.4) — an eliminated surface and a second independent layer both move the score — while the untouched open gap (T_c) correctly still dominates the residual. A naive best-control-only scoring would show this improvement as zero.

### 4.3 Version deltas: "riskier" vs "better-modeled"

- **v_n:** `{T1 High, 1 Applied (0.20); T2 Med, open (1.0)}`. `RC=8`, `RM=4.0` → **ARI = 50.0**.
- **v_{n+1}:** discovered a new High **T3** (open); shipped a control for **T2** (now Applied).

| | T1 | T2 | T3 | RC | RM | ARI |
| --- | --- | --- | --- | --- | --- | --- |
| Pivot (new set, old statuses) | 0.20 | 1.00 | 1.00 | 13 | 9.0 | **69.2** |
| Final (new set, new statuses) | 0.20 | 0.20 | 1.00 | 13 | 6.6 | **50.8** |

`Δ_scope = 69.2 − 50.0 = +19.2` (a new open High raised risk); `Δ_controls = 50.8 − 69.2 = −18.4` (mitigating T2 lowered it); total `+0.8`. The headline barely moved, but the decomposition reveals you found a serious new exposure and nearly offset it — a story the single number hides.

---

## 5. Design rationale & known limitations

**Why normalized, not a raw sum.** An un-normalized weighted sum measures risk *mass*: it grows with every threat you enumerate, so a more thorough model scores *worse*, and a big fully-mitigated model can be barred from an A purely for its size. It also breaks the cross-version and cross-model comparison that is the whole point. Normalizing to a 0–100 density fixes all of that (Example 4.1).

**Why a single Applied control leaves 0.20, and layering earns the deep cuts.** Crediting one control with a ~90% reduction makes any second layer invisible — once a threat bottoms out, reinforcement can't register (the failure mode of best-control-only scoring, Example 4.2). Setting a lone control at `0.20` (a single control is a single point of failure) and combining independent controls multiplicatively makes coverage *depth* move the score.

**Why an Eliminated state.** Removing a surface is categorically stronger than guarding it, and should outscore any mitigation. Elimination is the only status that clears the `0.03` residual floor.

**Why bands + gates.** Absolute grade bands on a size-dependent quantity penalize large models. Grading on the normalized index and *capping* on open High-severity threats reproduces the qualitative intent ("no A with open Highs") while keeping the letter independent of model size.

**Known limitations — state these in any model that uses ARI:**
- **Constants are calibrated, not derived.** Leakage anchors (`0.20 / 0.50`), the `0.03` floor, the Critical weight (`8`), band edges, and gate thresholds are judgment calls. Fix them once and hold them constant; retune only with a Change Log note and a full recompute.
- **Independence is assumed, not proven.** The multiplicative rule over-credits correlated controls; the §2.3 independence guardrail is manual.
- **Coverage status ≠ residual risk.** By default, leakage grades a control's *presence and completeness*, not its measured efficacy. Justified effectiveness levels (§2.3) narrow this at the cost of author subjectivity, which the guardrails fence but can't remove. Use custom levels where you can defend them; default where you can't.
- **The letter is coarse.** Report the number and the decomposition; don't let the grade alone drive decisions.

---

## 6. Migration from earlier versions

v1.1 replaced an earlier additive formulation (v1.0) that summed `severity_weight × coverage_gap` without normalization, without defense-in-depth, and without an Eliminated state. **The two are different metrics on different scales and are not comparable** — a v1.0 score and a v1.1 score of the same number mean unrelated things.

If migrating a model scored under v1.0: recompute from scratch under §2, record the result as a fresh baseline (`Metric migrated v1.0 → v1.1; scores rebased, prior deltas not carried forward`), re-classify any surface-removing ✅ controls as 🚫 Eliminated, and apply the independence check (§2.3) to any threat listing multiple controls.

---

## 7. Relationship to existing standards

ARI is a bespoke, skill-internal metric — **not** an industry standard, and not meant to interoperate with one. It exists because no popular standard packages together the three things a threat model needs in one figure: per-threat severity, a control-coverage discount, and a normalized aggregate comparable across versions. Each named standard owns one layer and leaves the others alone; ARI borrows the accepted idea from each:

- **Severity layer — closest relative: OWASP Risk Rating Methodology.** ARI's `Likelihood × Impact` severity matrix is the same shape OWASP uses. This is the appsec-native ancestor of ARI's threat-scoring engine. (**DREAD** is the philosophical ancestor of "score each threat and sum," but is largely deprecated for subjectivity; we don't follow it.)
- **Per-finding scoring — the default people reach for: CVSS (v3.1/v4.0).** CVSS scores *individual vulnerabilities* on 0–10, and FIRST explicitly discourages summing/averaging them — exactly the aggregation ARI performs. Score concrete findings with CVSS; track a model's posture with ARI.
- **Coverage → residual risk — the lineage: ISO/IEC 27005 and NIST SP 800-30 / RMF.** ARI's `coverage_gap` is the `residual risk = inherent risk after controls` concept these frameworks formalize in a risk register, turned into a crisp per-threat factor.
- **Aggregate risk — closest in ambition: FAIR (Open Group).** FAIR rolls risk into one aggregate, but *quantitatively in expected loss* (frequency × magnitude, Monte Carlo), needing data a codebase-derived model rarely has. ARI targets the same "one comparable number" goal with a lightweight coverage index instead.
- **Normalized 0–100 / A–F output — closest in shape: security ratings (BitSight, SecurityScorecard, UpGuard).** These grade posture A–F on 0–100 like ARI, but from *outside-in* signals (exposed services, cert hygiene, leaked creds), not a threat model. The resemblance is presentational.

Adjacent but out of scope: **SSVC** and **EPSS** are vulnerability *prioritization* aids, not aggregate scores; **OWASP SAMM** and **BSIMM** measure program *maturity*; **NIST CSF** and **ISO/IEC 27001** are governance frameworks above any single metric.

**One-line positioning for a skeptical reviewer:** *ARI uses OWASP-style Likelihood × Impact severity and ISO 27005 / NIST 800-30 residual-risk thinking, aggregated into a normalized index in the spirit of FAIR — as a coverage index for tracking one threat model over time, not an interop-grade or actuarial standard. Score findings with CVSS; track posture with ARI.*

---

## 8. Change log

Maintained as a practice for future revisions: record every substantive change to this spec here, so a model citing "ARI v1.x" can be traced to the exact rules it was scored under. When the scoring rules change, bump the version and note whether prior scores remain comparable.

| Version | Date | Summary |
| --- | --- | --- |
| v1.1 | 2026-07 | Normalized 0–100 index (was an un-normalized weighted sum); multiplicative defense-in-depth; added Eliminated status; grade = ARI band capped by High-severity gates; optional justified per-control effectiveness levels; version-delta decomposition (scope vs controls). Not score-comparable to v1.0. |
| v1.0 | — | Original additive index `Σ severity_weight × coverage_gap`; per-threat coverage floor at the single best control; absolute grade bands. Superseded. |
