// Generates src/contracts.ts from the shared JSON Schema. Run: pnpm gen:contracts
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { compileFromFile } from "json-schema-to-typescript";

const schema = resolve(import.meta.dirname, "../../../packages/contracts/kickstream.schema.json");
export const target = resolve(import.meta.dirname, "../src/contracts.ts");

export async function render() {
  return compileFromFile(schema, {
    unreachableDefinitions: true,
    bannerComment:
      "/* Generated from packages/contracts/kickstream.schema.json. Do not edit. Run `pnpm gen:contracts`. */",
  });
}

if (resolve(process.argv[1] ?? "") === import.meta.filename) {
  await writeFile(target, await render());
}
