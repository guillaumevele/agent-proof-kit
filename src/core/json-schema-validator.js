export function validateJsonSchema(value, schema) {
  const issues = [];
  validateNode(value, schema, "$", schema, issues);
  return issues;
}

function validateNode(value, schema, location, rootSchema, issues) {
  if (!schema) return;
  if (schema.$ref) {
    validateNode(value, resolveRef(schema.$ref, rootSchema), location, rootSchema, issues);
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
    value.forEach((item, index) => validateNode(item, schema.items, `${location}[${index}]`, rootSchema, issues));
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

    if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
      for (const [key, childValue] of Object.entries(value)) {
        if (!Object.hasOwn(schema.properties ?? {}, key)) {
          validateNode(childValue, schema.additionalProperties, `${location}.${key}`, rootSchema, issues);
        }
      }
    }
  }
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
