/* Shared namespace. Modules register their exports on it; it is also exposed
 * on window for debugging from the console and for automated tests. */
export const FL = (window.FL = window.FL || {});

/** Santimetre değeri, bir ondalık, Türkçe ondalık virgülü (kayan nokta sınırında tutarlı yuvarlama) */
FL.fmtCm = function (v) {
  return (Math.round(v * 10 + 1e-6) / 10).toLocaleString('tr-TR', { maximumFractionDigits: 1 });
};
