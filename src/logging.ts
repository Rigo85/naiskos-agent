const SENSITIVE_FIELD =
  /(authorization|cookie|password|secret|token|api[_-]?key)/i;

function safeThrownValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (
    value === null ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint" ||
    typeof value === "undefined" ||
    typeof value === "symbol" ||
    typeof value === "function"
  ) {
    return String(value);
  }

  const visited = new WeakSet<object>();
  try {
    return JSON.stringify(value, (key, item: unknown) => {
      if (SENSITIVE_FIELD.test(key)) return "[REDACTED]";
      if (typeof item === "bigint") return item.toString();
      if (typeof item === "object" && item !== null) {
        if (visited.has(item)) return "[Circular]";
        visited.add(item);
      }
      return item;
    });
  } catch {
    return Object.prototype.toString.call(value);
  }
}

/**
 * Pino serializa stack, tipo, mensaje y `cause` cuando el valor está en `err`.
 * JavaScript también permite rechazar promesas con valores que no son Error;
 * éstos se convierten sin perder su contenido ni exponer campos sensibles.
 */
export function errorForLog(value: unknown): Error {
  if (value instanceof Error) return value;
  return new Error(`Valor lanzado que no es Error: ${safeThrownValue(value)}`);
}
