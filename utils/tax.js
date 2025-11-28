export const resolveTaxRate = (sources, fallback = 0) => {
  const tryNormalize = (input) => {
    if (input === undefined || input === null) return undefined;
    const numeric = Number(input);
    if (!Number.isFinite(numeric)) return undefined;
    const clamped = Math.max(0, numeric);
    if (clamped === 0) return 0;
    const decimal = clamped > 1 ? clamped / 100 : clamped;
    return Number(decimal.toFixed(6));
  };

  const list = Array.isArray(sources) ? sources : [sources];
  for (const candidate of list) {
    const normalized = tryNormalize(candidate);
    if (normalized !== undefined) {
      return normalized;
    }
  }

  const fallbackNormalized = tryNormalize(fallback);
  return fallbackNormalized !== undefined ? fallbackNormalized : 0;
};

export const resolveTaxPercent = (sources, fallback = 0) => {
  const rate = resolveTaxRate(sources, fallback);
  return Number((rate * 100).toFixed(2));
};
