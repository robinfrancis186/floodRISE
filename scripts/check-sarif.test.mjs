import assert from "node:assert/strict";
import test from "node:test";

import { reportableSarifResults } from "./check-sarif.mjs";

function sarifResult({
  ruleSeverity,
  resultSeverity,
  level = "warning",
} = {}) {
  return {
    version: "2.1.0",
    runs: [{
      tool: {
        driver: {
          name: "CodeQL",
          rules: [{
            id: "js/example",
            defaultConfiguration: { level },
            properties: ruleSeverity === undefined
              ? {}
              : { "security-severity": String(ruleSeverity) },
          }],
        },
      },
      results: [{
        ruleId: "js/example",
        level,
        message: { text: "Representative finding." },
        properties: resultSeverity === undefined
          ? {}
          : { "security-severity": String(resultSeverity) },
      }],
    }],
  };
}

test("fails the release threshold for a high-severity CodeQL rule", () => {
  const findings = reportableSarifResults(sarifResult({ ruleSeverity: 8.1 }));
  assert.equal(findings.length, 1);
  assert.equal(findings[0].ruleId, "js/example");
});

test("honors a result-specific severity and ignores a lower warning", () => {
  assert.equal(
    reportableSarifResults(sarifResult({ ruleSeverity: 8.1, resultSeverity: 4.2 })).length,
    0,
  );
});

test("fails closed for a SARIF error without numeric security severity", () => {
  assert.equal(reportableSarifResults(sarifResult({ level: "error" })).length, 1);
});

test("accepts a clean CodeQL run", () => {
  assert.deepEqual(
    reportableSarifResults({
      version: "2.1.0",
      runs: [{ tool: { driver: { name: "CodeQL", rules: [] } }, results: [] }],
    }),
    [],
  );
});
