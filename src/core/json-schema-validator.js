import { isDeepStrictEqual } from "node:util";

export function validateJsonSchema(value, schema) {
  const issues = [];
  validateNode(value, schema, "$", schema, issues);
  return issues;
}

function validateNode(value, schema, location, rootSchema, issues) {
  if (schema === true || schema === undefined || schema === null) return;
  if (schema === false) {
    issues.push({ location, message: "Value is denied by the schema." });
    return;
  }
  if (schema.$ref) {
    validateNode(value, resolveRef(schema.$ref, rootSchema), location, rootSchema, issues);
    return;
  }

  for (const childSchema of schema.allOf ?? []) {
    validateNode(value, childSchema, location, rootSchema, issues);
  }

  if (schema.anyOf) {
    const matched = schema.anyOf.some((childSchema) =>
      schemaMatches(value, childSchema, location, rootSchema)
    );
    if (!matched) issues.push({ location, message: "Expected at least one anyOf branch to match." });
  }

  if (schema.oneOf) {
    const matches = schema.oneOf.filter((childSchema) =>
      schemaMatches(value, childSchema, location, rootSchema)
    ).length;
    if (matches !== 1) {
      issues.push({ location, message: `Expected exactly one oneOf branch to match; received ${matches}.` });
    }
  }

  if (schema.not && schemaMatches(value, schema.not, location, rootSchema)) {
    issues.push({ location, message: "Value matches a denied schema branch." });
  }

  if (schema.if) {
    const branch = schemaMatches(value, schema.if, location, rootSchema)
      ? schema.then
      : schema.else;
    if (branch !== undefined) validateNode(value, branch, location, rootSchema, issues);
  }

  if (Object.hasOwn(schema, "const") && !constantMatches(value, schema.const)) {
    issues.push({ location, message: `Expected constant value: ${JSON.stringify(schema.const)}.` });
    return;
  }

  if (schema.enum && !schema.enum.includes(value)) {
    issues.push({ location, message: `Expected one of: ${schema.enum.join(", ")}.` });
    return;
  }

  if (schema.type && !matchesType(value, schema.type)) {
    issues.push({ location, message: `Expected ${schema.type}.` });
    return;
  }

  if (schema.type === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      issues.push({ location, message: `Expected string length >= ${schema.minLength}.` });
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      issues.push({ location, message: `Expected string length <= ${schema.maxLength}.` });
    }
    if (schema.pattern !== undefined && !new RegExp(schema.pattern, "u").test(value)) {
      issues.push({ location, message: `Expected string to match ${schema.pattern}.` });
    }
    return;
  }

  if (schema.type === "integer" || schema.type === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) {
      issues.push({ location, message: `Expected value >= ${schema.minimum}.` });
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      issues.push({ location, message: `Expected value <= ${schema.maximum}.` });
    }
    return;
  }

  if (schema.type === "array") {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      issues.push({ location, message: `Expected at least ${schema.minItems} items.` });
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      issues.push({ location, message: `Expected at most ${schema.maxItems} items.` });
    }
    const prefixItems = schema.prefixItems ?? [];
    prefixItems.forEach((itemSchema, index) => {
      if (index < value.length) {
        validateNode(value[index], itemSchema, `${location}[${index}]`, rootSchema, issues);
      }
    });
    if (schema.items !== undefined) {
      for (let index = prefixItems.length; index < value.length; index += 1) {
        validateNode(value[index], schema.items, `${location}[${index}]`, rootSchema, issues);
      }
    }
    return;
  }

  if (schema.type === "object") {
    for (const key of schema.required ?? []) {
      if (!Object.hasOwn(value, key)) {
        issues.push({ location: `${location}.${key}`, message: "Missing required property." });
      }
    }

    for (const [key, childSchema] of Object.entries(schema.properties ?? {})) {
      if (Object.hasOwn(value, key)) {
        validateNode(value[key], childSchema, `${location}.${key}`, rootSchema, issues);
      }
    }

    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!Object.hasOwn(schema.properties ?? {}, key)) {
          issues.push({ location: `${location}.${key}`, message: "Unknown property." });
        }
      }
    }

    if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
      for (const [key, childValue] of Object.entries(value)) {
        if (!Object.hasOwn(schema.properties ?? {}, key)) {
          validateNode(childValue, schema.additionalProperties, `${location}.${key}`, rootSchema, issues);
        }
      }
    }
  }
}

function schemaMatches(value, schema, location, rootSchema) {
  const branchIssues = [];
  validateNode(value, schema, location, rootSchema, branchIssues);
  return branchIssues.length === 0;
}

function constantMatches(value, expected) {
  return isDeepStrictEqual(value, expected);
}

function matchesType(value, type) {
  if (type === "integer") return Number.isInteger(value);
  if (type === "number") return typeof value === "number" && !Number.isNaN(value);
  if (type === "array") return Array.isArray(value);
  if (type === "object") return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  return typeof value === type;
}

function resolveRef(ref, rootSchema) {
  if (!ref.startsWith("#/")) {
    throw new Error(`Unsupported schema ref: ${ref}`);
  }

  return ref
    .slice(2)
    .split("/")
    .reduce((node, segment) => node?.[segment], rootSchema);
}
