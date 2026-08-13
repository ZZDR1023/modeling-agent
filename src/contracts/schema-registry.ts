import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { ErrorObject, ValidateFunction } from "ajv";

export type SchemaName =
  | "problem-spec"
  | "task-graph"
  | "coverage-report"
  | "evaluation-contract"
  | "experiment-request"
  | "experiment-result"
  | "evidence-graph";

const schemaFiles: Record<SchemaName, string> = {
  "problem-spec": "problem-spec.v1.json",
  "task-graph": "task-graph.v1.json",
  "coverage-report": "coverage-report.v1.json",
  "evaluation-contract": "evaluation-contract.v1.json",
  "experiment-request": "experiment-request.v1.json",
  "experiment-result": "experiment-result.v1.json",
  "evidence-graph": "evidence-graph.v1.json"
};

function defaultSchemaDirectory(): string {
  // This resolves to schemas/ for tsx and dist/schemas/ after compilation.
  return fileURLToPath(new URL("../../schemas/", import.meta.url));
}

export class ContractValidationError extends Error {
  readonly schemaName: SchemaName;
  readonly validationErrors: ErrorObject[];

  constructor(schemaName: SchemaName, errors: ErrorObject[] | null | undefined) {
    const normalized = errors ?? [];
    super(
      `Contract ${schemaName} failed: ${normalized
        .map((error) => `${error.instancePath || "/"} ${error.message ?? "is invalid"}`)
        .join("; ")}`
    );
    this.name = "ContractValidationError";
    this.schemaName = schemaName;
    this.validationErrors = normalized;
  }
}

export class SchemaRegistry {
  readonly #ajv: InstanceType<typeof Ajv2020>;
  readonly #validators = new Map<SchemaName, ValidateFunction>();

  constructor(schemaDirectory = defaultSchemaDirectory()) {
    this.#ajv = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true });
    this.#ajv.addFormat("date-time", {
      type: "string",
      validate: (value: string) => !Number.isNaN(Date.parse(value))
    });

    for (const [name, filename] of Object.entries(schemaFiles) as Array<[SchemaName, string]>) {
      const schema = JSON.parse(readFileSync(resolve(schemaDirectory, filename), "utf8")) as object;
      this.#validators.set(name, this.#ajv.compile(schema));
    }
  }

  validate<T>(name: SchemaName, value: unknown): T {
    const validator = this.#validators.get(name);
    if (!validator) {
      throw new Error(`Unknown schema: ${name}`);
    }
    if (!validator(value)) {
      throw new ContractValidationError(name, validator.errors);
    }
    return value as T;
  }
}
