#!/usr/bin/env node

import { readdir, readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

function numericSeverity(value) {
  const severity = Number(value);
  return Number.isFinite(severity) ? severity : null;
}

export function reportableSarifResults(sarif, minimumSecuritySeverity = 7) {
  const findings = [];
  for (const run of sarif?.runs ?? []) {
    const rules = new Map(
      (run?.tool?.driver?.rules ?? []).map((rule) => [rule.id, rule]),
    );
    for (const result of run?.results ?? []) {
      const rule = rules.get(result.ruleId);
      const severity = numericSeverity(
        result?.properties?.["security-severity"]
          ?? rule?.properties?.["security-severity"],
      );
      const level = result.level ?? rule?.defaultConfiguration?.level ?? "none";
      if ((severity !== null && severity >= minimumSecuritySeverity) || level === "error") {
        findings.push({
          ruleId: result.ruleId ?? "unknown-rule",
          level,
          severity,
          message: result?.message?.text ?? "No finding message supplied.",
        });
      }
    }
  }
  return findings;
}

async function sarifFiles(target) {
  const absolute = resolve(target);
  const details = await stat(absolute);
  if (details.isFile()) return absolute.endsWith(".sarif") ? [absolute] : [];
  if (!details.isDirectory()) return [];

  const entries = await readdir(absolute, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => sarifFiles(resolve(absolute, entry.name))),
  );
  return nested.flat().filter((path) => path.endsWith(".sarif")).sort();
}

async function main() {
  const target = process.argv[2];
  if (!target) {
    throw new Error("Usage: node scripts/check-sarif.mjs <file-or-directory> [minimum-severity]");
  }
  const minimum = process.argv[3] === undefined ? 7 : Number(process.argv[3]);
  if (!Number.isFinite(minimum) || minimum < 0 || minimum > 10) {
    throw new Error("Minimum SARIF security severity must be between 0 and 10.");
  }

  const files = await sarifFiles(target);
  if (files.length === 0) {
    throw new Error(`No SARIF evidence found under ${resolve(target)}.`);
  }

  const findings = [];
  for (const file of files) {
    const sarif = JSON.parse(await readFile(file, "utf8"));
    findings.push(
      ...reportableSarifResults(sarif, minimum).map((finding) => ({ ...finding, file })),
    );
  }
  if (findings.length > 0) {
    for (const finding of findings) {
      process.stderr.write(
        `${finding.ruleId} severity=${finding.severity ?? "n/a"} level=${finding.level}: ${finding.message}\n`,
      );
    }
    throw new Error(
      `${findings.length} CodeQL finding(s) met the release threshold (security severity >= ${minimum} or SARIF error).`,
    );
  }
  process.stdout.write(
    `CodeQL SARIF gate passed: ${files.length} file(s), no release-threshold findings.\n`,
  );
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
