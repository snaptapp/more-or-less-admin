#!/usr/bin/env node
/**
 * Ops_Assistant_Check. Fails when the Notion Ops Assistant instructions, worker
 * tool declarations, and Admin Ops API routes disagree.
 *
 * Standalone. Node builtins only. No network.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const TOOL_RE = /worker\.tool\(\s*"([a-z][a-z0-9_]*)"/g;
const MENTION_RE = /`([a-z][a-z0-9_]*)(?:\([^`]*\))?`/g;
const CALL_RE = /\/api\/internal\/ops\/([a-z0-9_-]+)\/([a-z0-9_-]+)/g;

const TOOL_PREFIXES = [
  "factbank_",
  "moderation_",
  "crawl_",
  "mol_",
  "production_",
  "deployment_",
  "worker_",
  "binding_",
  "kv_",
  "d1_",
  "r2_",
  "recent_",
  "players_",
  "daily_",
  "analytics_",
  "config_",
  "roles_",
  "audit_",
];

function walkTs(dir, out) {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      if (name === "node_modules") continue;
      walkTs(full, out);
    } else if (name.endsWith(".ts")) out.push(full);
  }
}

function declaredTools(root) {
  const files = [];
  walkTs(path.join(root, "notion-workers"), files);
  const declared = new Map();
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(TOOL_RE)) {
      declared.set(match[1], path.relative(root, file));
    }
  }
  return declared;
}

function mentions(root) {
  const text = readFileSync(path.join(root, "notion-workers", "AGENT_INSTRUCTIONS.md"), "utf8");
  return new Set([...text.matchAll(MENTION_RE)].map((match) => match[1]));
}

function isToolShaped(token) {
  return TOOL_PREFIXES.some((prefix) => token.startsWith(prefix));
}

function routeHandles(root, area, action) {
  const file = path.join(root, "src", "routes", "api", "internal", "ops", area, "$action.ts");
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return { ok: false, file };
  }
  const quoted = `"${action}"`;
  return { ok: text.includes(quoted), file };
}

/** @returns {string[]} problems. Empty means the assistant contract holds. */
export function checkOpsAssistant(root) {
  const problems = [];
  const declared = declaredTools(root);
  if (declared.size === 0) problems.push("No Notion worker tools were declared.");
  const named = mentions(root);

  for (const [tool, file] of declared) {
    if (!named.has(tool)) {
      problems.push(`${tool} is declared in ${file} but AGENT_INSTRUCTIONS.md does not mention it.`);
    }
  }
  for (const token of named) {
    if (isToolShaped(token) && !declared.has(token)) {
      problems.push(`AGENT_INSTRUCTIONS.md mentions \`${token}\`, but no Notion worker declares that tool.`);
    }
  }

  const workerFiles = [];
  walkTs(path.join(root, "notion-workers"), workerFiles);
  for (const file of workerFiles) {
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(CALL_RE)) {
      const area = match[1];
      const action = match[2];
      const handled = routeHandles(root, area, action);
      if (!handled.ok) {
        const where = path.relative(root, file);
        problems.push(`${where} calls /api/internal/ops/${area}/${action}, which ${handled.file ? path.relative(root, handled.file) : "the route"} does not handle.`);
      }
    }
  }
  return problems;
}

function isDirectInvocation() {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(entry).href;
}

if (isDirectInvocation()) {
  const problems = checkOpsAssistant(process.cwd());
  if (problems.length > 0) {
    for (const problem of problems) console.error(problem);
    process.exit(1);
  }
  console.log("Ops assistant tools, instructions, and API routes agree.");
}
