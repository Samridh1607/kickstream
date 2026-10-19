import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const dir = dirname(fileURLToPath(import.meta.url));

const htmlNames = [
  "index.html",
  "architecture.html",
  "capabilities.html",
  "security.html",
  "operations.html",
  "integrations.html",
  "constraints.html",
];

const areas = [
  "solution-overview",
  "architecture-and-data-flow",
  "functional-capabilities",
  "security-privacy-identity",
  "deployment-and-operations",
  "integrations-and-data-sources",
  "assumptions-constraints-risks",
];

function read(name) {
  return readFileSync(join(dir, name), "utf8");
}

const html = Object.fromEntries(htmlNames.map((name) => [name, read(name)]));
const htmlAll = Object.values(html).join("\n");
const css = read("theme.css");
const sty = read("kickstream-microsoft.sty");
const solution = read("kickstream-solution.tex");
const briefing = read("kickstream-briefing.tex");
const authored = [htmlAll, css, sty, solution, briefing].join("\n");

function sectionText(source, area) {
  const re = new RegExp(
    `<section[^>]*data-area="${area}"[^>]*>([\\s\\S]*?)</section>`,
    "i",
  );
  const match = source.match(re);
  assert.ok(match, `missing section ${area}`);
  return match[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

test("seven areas are present, non-empty, and specific to Kickstream", () => {
  const byArea = {
    "solution-overview": html["index.html"],
    "architecture-and-data-flow": html["architecture.html"],
    "functional-capabilities": html["capabilities.html"],
    "security-privacy-identity": html["security.html"],
    "deployment-and-operations": html["operations.html"],
    "integrations-and-data-sources": html["integrations.html"],
    "assumptions-constraints-risks": html["constraints.html"],
  };
  for (const area of areas) {
    assert.match(htmlAll, new RegExp(`data-area="${area}"`));
    assert.match(solution, new RegExp(`% area:${area}`));
    const text = sectionText(byArea[area], area);
    assert.ok(text.length > 500, `${area} is only ${text.length} characters`);
    assert.match(text, /Kickstream|studio|YouTube|Cosmos|Entra|StatsBomb|Container/);
    assert.doesNotMatch(text, /\bTBD\b|TODO|lorem ipsum/i);
  }
  assert.match(briefing, /area:solution-overview/);
  assert.match(briefing, /area:assumptions-constraints-risks/);
});

test("shared Microsoft theme tokens are used by more than one document", () => {
  assert.match(css, /Segoe UI Variable/);
  assert.match(css, /Segoe UI/);
  assert.match(css, /#0078D4/i);
  assert.match(css, /#FFFFFF/i);
  assert.match(css, /#242424/i);
  assert.match(css, /#616161/i);
  assert.match(css, /--ks-title:\s*28px/);
  assert.match(css, /font-size:\s*var\(--ks-title\)/);
  assert.match(css, /--ks-body:\s*14px/);
  assert.match(css, /font-size:\s*var\(--ks-body\)/);
  const styled = htmlNames.filter((name) => html[name].includes('href="theme.css"'));
  assert.ok(styled.length > 1, "theme.css must be linked from more than one document");
  assert.equal(styled.length, htmlNames.length);
  for (const name of htmlNames) {
    assert.match(html[name], /class="ks-header"/);
    assert.match(html[name], /class="ks-mark"/);
  }
  assert.match(sty, /Segoe UI Variable/);
  assert.match(sty, /Segoe UI/);
  assert.match(sty, /0078D4/i);
  assert.match(solution, /usepackage\{kickstream-microsoft\}/);
  assert.match(briefing, /usepackage\{kickstream-microsoft\}/);
  assert.match(briefing, /0078D4/);
});

test("claims match the repository and do not invent Marketplace fulfillment", () => {
  const limits = htmlAll + "\n" + solution;
  assert.match(
    limits,
    /StatsBomb Open Data is non-commercial and must not ship in a paid offer/,
  );
  assert.match(
    limits,
    /Kickstream does not implement Microsoft Marketplace SaaS fulfillment, an Entra purchase landing page, or a live Partner Center offer/,
  );
  assert.match(limits, /x-ms-client-principal-id/);
  assert.match(limits, /AzureADMyOrg/);
  assert.match(limits, /centralindia/);
  assert.match(limits, /\/api\/health/);
  assert.match(limits, /min_replicas = 1|min\\_replicas = 1/);
  const studio = html["capabilities.html"];
  assert.match(studio, /switches the program with a click/);
  assert.match(studio, /Keyboard shortcuts are not implemented/);
  assert.match(studio, /Coming in a later phase/);
  assert.doesNotMatch(studio, /keys 1/);
  for (const banned of [
    "Event Hubs",
    "Web PubSub",
    "Key Vault",
    "Front Door",
    "App Service",
    "Service Bus",
    "Azure Functions",
  ]) {
    assert.equal(authored.includes(banned), false, `unexpected Azure service: ${banned}`);
  }
});

test("print editions were compiled", () => {
  for (const name of ["kickstream-solution.pdf", "kickstream-briefing.pdf"]) {
    const size = statSync(join(dir, name)).size;
    const header = readFileSync(join(dir, name)).subarray(0, 5).toString("utf8");
    assert.equal(header, "%PDF-");
    assert.ok(size > 20_000, `${name} is only ${size} bytes`);
  }
});

test("the document directory is the shipped set, not a fixture copy", () => {
  const names = readdirSync(dir);
  assert.ok(names.includes("index.html"));
  assert.ok(names.includes("theme.css"));
  assert.ok(names.includes("kickstream-solution.tex"));
  const entry = html["index.html"];
  assert.match(entry, /Kickstream is live-streaming software for football/);
});
