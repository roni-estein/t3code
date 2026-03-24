#!/usr/bin/env node
/**
 * Probes the local Cursor CLI for the authoritative model id list (`agent models`).
 *
 * Usage:
 *   node scripts/cursor-agent-models-probe.mjs           # print JSON to stdout
 *   node scripts/cursor-agent-models-probe.mjs --write   # write packages/contracts/src/cursorCliModels.json
 *   node scripts/cursor-agent-models-probe.mjs --check   # fail if snapshot is stale vs live CLI
 *
 * Requires `agent` on PATH (install: Cursor CLI). Uses the same auth as interactive agent.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const SNAPSHOT_PATH = join(REPO_ROOT, "packages/contracts/src/cursorCliModels.json");

const ESC = "\u001B";
const ANSI = new RegExp(`${ESC}\\[[0-9;]*[a-zA-Z]`, "g");

function stripAnsi(text) {
  return text.replace(ANSI, "");
}

function cleanDisplayLabel(raw) {
  return raw
    .replace(/\s*\(default\)\s*$/i, "")
    .replace(/\s*\(current\)\s*$/i, "")
    .trim();
}

function parseModelsOutput(text) {
  const lines = stripAnsi(text).split("\n");
  const models = [];
  for (const line of lines) {
    const trimmed = line.trim();
    const m = /^(\S+)\s+-\s+(.+)$/.exec(trimmed);
    if (!m) continue;
    const id = m[1];
    const label = cleanDisplayLabel(m[2]);
    if (id === "Tip:" || id === "Available") continue;
    models.push({ id, label });
  }
  return models;
}

function probeLiveModels() {
  const r = spawnSync("agent", ["models"], {
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
  if (r.error) {
    throw r.error;
  }
  if (r.status !== 0) {
    throw new Error(r.stderr || `agent models exited ${r.status}`);
  }
  return parseModelsOutput(r.stdout ?? "");
}

function agentVersion() {
  const r = spawnSync("agent", ["-v"], { encoding: "utf8" });
  if (r.status !== 0) return null;
  return (r.stdout ?? "").trim() || null;
}

function main() {
  const write = process.argv.includes("--write");
  const check = process.argv.includes("--check");

  const models = probeLiveModels();
  if (models.length === 0) {
    console.error(
      "cursor-agent-models-probe: no models parsed (is `agent` installed and logged in?)",
    );
    process.exit(1);
  }

  const payload = {
    probeCommand: "agent models",
    generatedAt: new Date().toISOString(),
    agentVersion: agentVersion(),
    models,
  };

  if (write) {
    writeFileSync(SNAPSHOT_PATH, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    console.error(`Wrote ${models.length} models to ${SNAPSHOT_PATH}`);
  }

  if (check) {
    const existing = JSON.parse(readFileSync(SNAPSHOT_PATH, "utf8"));
    const want = new Set(existing.models.map((m) => m.id));
    const got = new Set(models.map((m) => m.id));
    const missing = [...want].filter((id) => !got.has(id));
    const extra = [...got].filter((id) => !want.has(id));
    if (missing.length || extra.length) {
      console.error("cursor-agent-models-probe: snapshot drift vs live `agent models`");
      if (missing.length) console.error("missing from live:", missing.join(", "));
      if (extra.length) console.error("extra in live:", extra.join(", "));
      console.error("Re-run: node scripts/cursor-agent-models-probe.mjs --write");
      process.exit(1);
    }
    console.error(`OK: ${models.length} models match ${SNAPSHOT_PATH}`);
  }

  if (!write && !check) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  }
}

main();
