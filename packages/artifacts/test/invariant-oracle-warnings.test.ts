import assert from "node:assert/strict";
import test from "node:test";

import {
  INVARIANT_ORACLE_GATE,
  MAX_ARTIFACT_VALIDATION_WARNINGS,
  MAX_ARTIFACT_VALIDATION_WARNING_BYTES,
  invariantOracleWarnings
} from "../src/index.js";

function warningsFor(files: Record<string, string>): Array<{ code: string; path: string; line: string }> {
  return invariantOracleWarnings(new Map(Object.entries(files).map(([path, text]) => [path, Buffer.from(text)]))).map(
    (warning) => {
      assert.equal(warning.gate, INVARIANT_ORACLE_GATE);
      return { code: warning.code, path: warning.artifact_path, line: warning.field_path };
    }
  );
}

// A handler and property pair written the way #687's prompts ask: a liveness
// call with a selector-aware catch, a spec-derived bound, and assert for every
// check. Guards before the target call stay ordinary requires.
const FALSIFIABLE_SUITE = `
// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ShareVault} from "../../src/ShareVault.sol";
import {MathLib as ML} from "contracts/libraries/MathLib.sol";
import {Test} from "forge-std/Test.sol";

contract TargetFunctions {
    ShareVault internal vault;

    function handler_withdrawAll() public {
        uint256 shares = vault.balanceOf(address(this));
        require(shares > 0, "nothing to withdraw: assert(true) here is only text");
        try vault.withdraw(shares) returns (uint256) {} catch (bytes memory reason) {
            bytes4 selector = bytes4(reason);
            if (selector != ShareVault.ZeroAmount.selector && selector != ShareVault.InsufficientShares.selector) {
                assert(false);
            }
        }
    }

    function handler_withdrawSome(uint256 shares) public {
        uint256 supplyBefore = vault.totalSupply();
        uint256 assetsBefore = vault.totalAssets();
        uint256 out = vault.withdraw(shares);
        // README: rounded down. assert(true) in a comment is not code.
        assert(out * supplyBefore <= shares * assetsBefore);
        assertEq(ML.WAD, 1e18);
    }
}
`;

test("a falsifiable invariant suite produces no oracle warnings (#687)", () => {
  assert.deepEqual(warningsFor({ "invariant-suite/test/recon/TargetFunctions.sol": FALSIFIABLE_SUITE }), []);
});

test("constant comparisons preserve string literals and ignore punctuation inside them", () => {
  const source = `contract Properties {
    function property_strings() public {
        assert(keccak256("a") == keccak256("b"));
        assertEq("a b", "ab");
        assertEq("a,b", "a)c");
        assertEq("assert(true)", "assert(false)");
        assertEq("a\\"b", "a\\"c");
        assertEq('a', 'b');
        assert(keccak256("same") == keccak256("same"));
        assertEq("a,b", "a,b");
    }
}`;
  assert.deepEqual(
    warningsFor({ "invariant-suite/test/Properties.sol": source }).map(({ code, line }) => ({ code, line })),
    [
      { code: "INVARIANT_ORACLE_CONSTANT_TRUE", line: "line 9" },
      { code: "INVARIANT_ORACLE_CONSTANT_TRUE", line: "line 10" }
    ]
  );
});

test("constant comparisons treat matching literal contents as equal across quote styles", () => {
  const source = `contract Properties {
    function property_strings() public {
        assertEq("a", 'a');
        assert(keccak256("a") == keccak256('a'));
        assertEq("a,b", 'a,b');
        assertEq("a", 'b');
        assert(keccak256("a") == keccak256('b'));
        assertEq("a,b", 'a)c');
    }
}`;
  assert.deepEqual(
    warningsFor({ "invariant-suite/test/Properties.sol": source }).map(({ code, line }) => ({ code, line })),
    [
      { code: "INVARIANT_ORACLE_CONSTANT_TRUE", line: "line 3" },
      { code: "INVARIANT_ORACLE_CONSTANT_TRUE", line: "line 4" },
      { code: "INVARIANT_ORACLE_CONSTANT_TRUE", line: "line 5" }
    ]
  );
});

test("production implementation imports support either Solidity quote style", () => {
  for (const quote of ['"', "'"]) {
    const source = `import {MathLib as ML} from ${quote}contracts/MathLib.sol${quote};
import * as Math from ${quote}../src/Math.sol${quote};
import {Test} from ${quote}forge-std/Test.sol${quote};
contract Properties {
    function property_expected() public {
        assert(observed == ML.f(x));
        assertEq(observed, Math.f(x));
        assertEq(observed, Test.f(x));
    }
}`;
    assert.deepEqual(
      warningsFor({ "invariant-suite/test/Properties.sol": source }).map(({ code, line }) => ({ code, line })),
      [
        { code: "INVARIANT_ORACLE_IMPLEMENTATION_CALL", line: "line 6" },
        { code: "INVARIANT_ORACLE_IMPLEMENTATION_CALL", line: "line 7" }
      ]
    );
  }
});

test("invariant oracle warnings name each check Recon cannot fail (#687)", () => {
  const properties = `
pragma solidity 0.8.24;
import {MathLib as ML} from "contracts/libraries/MathLib.sol";
import {Pool} from "../../src/Pool.sol";

contract Properties {
    Pool internal pool;
    Observation internal o;

    function property_proportionalWithdraw() public {
        if (!o.observed) {
            assert(true);
            return;
        }
        assert(o.amountQuote == ML.mulDiv(o.quoteBalanceBefore, o.shares, o.totalSupplyBefore));
        assertEq(o.amountBase, o.amountBase);
        t(true, "always");
        assert(o.reserve == o.reserve);
    }

    function handler_close() public {
        uint256 bound = pool.maxClose();
        require(bound > 0, "guard before the target call");
        pool.close();
        require(pool.virtualNativeReserve() == 0, "close execution mismatch");
        try pool.sweep() {} catch {}
    }
}
`;
  assert.deepEqual(warningsFor({ "invariant-suite/test/recon/Properties.sol": properties }), [
    { code: "INVARIANT_ORACLE_CONSTANT_TRUE", path: "invariant-suite/test/recon/Properties.sol", line: "line 12" },
    { code: "INVARIANT_ORACLE_CONSTANT_TRUE", path: "invariant-suite/test/recon/Properties.sol", line: "line 16" },
    { code: "INVARIANT_ORACLE_CONSTANT_TRUE", path: "invariant-suite/test/recon/Properties.sol", line: "line 17" },
    { code: "INVARIANT_ORACLE_CONSTANT_TRUE", path: "invariant-suite/test/recon/Properties.sol", line: "line 18" },
    { code: "INVARIANT_ORACLE_REQUIRE_DISCARDED", path: "invariant-suite/test/recon/Properties.sol", line: "line 25" },
    { code: "INVARIANT_ORACLE_BLANKET_CATCH", path: "invariant-suite/test/recon/Properties.sol", line: "line 26" },
    {
      code: "INVARIANT_ORACLE_IMPLEMENTATION_CALL",
      path: "invariant-suite/test/recon/Properties.sol",
      line: "line 15"
    }
  ]);
});

test("invariant oracle warnings read only the suite's test sources", () => {
  const blanket = "contract C { function f() public { try x.y() {} catch {} } }";
  assert.deepEqual(
    warningsFor({
      "invariant-suite/src/Vault.sol": blanket,
      "invariant-suite/test/Readme.md": blanket,
      "findings.json": blanket,
      "invariant-suite/tests/Handlers.sol": blanket
    }).map(({ path }) => path),
    ["invariant-suite/tests/Handlers.sol"]
  );
});

// A selector-aware catch ends in an assertion. Checking it must not move the
// start of the next search past assertions earlier in the file or in later files.
test("invariant oracle warnings keep finding assertions after a selector-aware catch", () => {
  const padding = "        uint256 unused = 0;\n".repeat(40);
  const first = `
pragma solidity 0.8.24;
import {MathLib as ML} from "contracts/libraries/MathLib.sol";
contract Properties {
    function property_expected() public {
        assert(observed == ML.mulDiv(a, b, c));
    }
    function handler_exit() public {
        try vault.withdraw(1) returns (uint256) {} catch (bytes memory reason) {
${padding}            if (bytes4(reason) != Vault.ZeroAmount.selector) assert(false);
        }
    }
}
`;
  const second = `
pragma solidity 0.8.24;
contract Later {
    function property_trivial() public {
        assert(true);
    }
}
`;
  assert.deepEqual(
    warningsFor({ "invariant-suite/test/a/Properties.sol": first, "invariant-suite/test/b/Later.sol": second }).map(
      ({ code, path }) => `${code} ${path}`
    ),
    [
      "INVARIANT_ORACLE_IMPLEMENTATION_CALL invariant-suite/test/a/Properties.sol",
      "INVARIANT_ORACLE_CONSTANT_TRUE invariant-suite/test/b/Later.sol"
    ]
  );
});

// Recon discards an ordinary revert, so a catch that only rethrows cannot report the failure.
test("a catch that only rethrows is an oracle warning", () => {
  const handler =
    "contract C { function f() public { try vault.withdraw(1) returns (uint256) {} catch { revert(); } } }";
  assert.deepEqual(
    warningsFor({ "invariant-suite/test/C.sol": handler }).map(({ code }) => code),
    ["INVARIANT_ORACLE_BLANKET_CATCH"]
  );
});

test("dense suites stop scanning at the warning budget without inventing an omitted count", () => {
  const artifactPath = "invariant-suite/test/a-λ.sol";
  const source = (count: number) =>
    Buffer.from(`contract C {\nfunction property() public {\n${"assert(true);\n".repeat(count)}}\n}\n`);
  const unreadable = new Proxy(Buffer.from("assert(true);"), {
    get() {
      throw new Error("a source after the exhausted warning budget must not be read");
    }
  });
  const warnings = invariantOracleWarnings(
    new Map([
      [artifactPath, source(100_000)],
      ["invariant-suite/test/z.sol", unreadable]
    ])
  );
  assert.ok(warnings.length <= MAX_ARTIFACT_VALIDATION_WARNINGS);
  assert.ok(Buffer.byteLength(JSON.stringify(warnings)) <= MAX_ARTIFACT_VALIDATION_WARNING_BYTES);
  assert.equal(warnings.at(-1)?.code, "ARTIFACT_VALIDATION_WARNINGS_TRUNCATED");
  assert.match(warnings.at(-1)?.message ?? "", /scanning stopped/u);
  assert.doesNotMatch(warnings.at(-1)?.message ?? "", /\d+ further/u);
  const retained = warnings.slice(0, -1);
  assert.ok(retained.length > 0);
  for (const [index, warning] of retained.entries()) {
    assert.equal(warning.code, "INVARIANT_ORACLE_CONSTANT_TRUE");
    assert.equal(warning.field_path, `line ${String(index + 3)}`);
  }
  // Exhausting the input exactly at the retained prefix needs no truncation notice.
  assert.deepEqual(invariantOracleWarnings(new Map([[artifactPath, source(retained.length)]])), retained);
});
