import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

async function readJson(path, label) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(`read ${label} '${path}' failed: ${error.message}`);
  }
}

export async function validateAppSchema(schemaPath, packagePath) {
  const schema = await readJson(schemaPath, "Kestral app schema");
  const app = await readJson(packagePath, "app.json");
  // The public schema intentionally uses conditional keyword fragments without
  // repeating their enclosing type; accept those valid JSON Schema fragments.
  const ajv = new Ajv2020({ allErrors: true, strict: true, strictTypes: false, strictRequired: false });
  addFormats(ajv);
  const validate = ajv.compile(schema);
  if (!validate(app)) {
    const details = validate.errors
      .map((error) => `${error.instancePath || "/"} ${error.message}`)
      .join("; ");
    throw new Error(`app.json does not validate against the Kestral schema: ${details}`);
  }
}

const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === currentFile) {
  const schemaPath = process.argv[2] ?? process.env.KESTRAL_APP_SCHEMA;
  const packagePath = process.argv[3] ?? "dist/app.json";
  if (!schemaPath) {
    throw new Error("a public Kestral schema path is required (argument 1 or KESTRAL_APP_SCHEMA)");
  }
  await validateAppSchema(schemaPath, packagePath);
  console.log(`Validated ${packagePath} against ${schemaPath}.`);
}
