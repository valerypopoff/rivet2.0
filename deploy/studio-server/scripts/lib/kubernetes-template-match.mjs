import { isDeepStrictEqual } from 'node:util';

// Match every desired field while accepting API defaults. Named arrays are
// keyed sets; command/argument arrays remain ordered. Empty literal env values
// may be omitted by Kubernetes, but real changes are never ignored.
export function matchesKubernetesTemplate(actual, desired) {
  if (desired && typeof desired.name === 'string' && actual?.valueFrom !== undefined && desired.valueFrom === undefined)
    return false;
  if ((desired === '' || desired === null) && actual === undefined) return true;
  if (
    actual === undefined &&
    desired &&
    typeof desired === 'object' &&
    !Array.isArray(desired) &&
    Object.keys(desired).length === 0
  )
    return true;
  if (Array.isArray(desired)) {
    if (!Array.isArray(actual) || actual.length < desired.length) return false;
    if (desired.every((v) => v && typeof v === 'object' && typeof v.name === 'string')) {
      const used = new Set();
      return desired.every((v) => {
        const index = actual.findIndex((a, i) => !used.has(i) && a.name === v.name && matchesKubernetesTemplate(a, v));
        if (index < 0) return false;
        used.add(index);
        return true;
      });
    }
    return actual.length === desired.length && desired.every((v, i) => matchesKubernetesTemplate(actual[i], v));
  }
  if (desired && typeof desired === 'object')
    return (
      actual &&
      typeof actual === 'object' &&
      Object.entries(desired).every(([k, v]) => matchesKubernetesTemplate(actual[k], v))
    );
  return isDeepStrictEqual(actual, desired);
}
