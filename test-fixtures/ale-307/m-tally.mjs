// Tallies prices from a catalog. Throwaway fixture for ALE-307; never imported.

/** The sum of every item's price. */
export function total(items) {
  return items.reduce((sum, item) => sum + item.price, 0);
}

/** The middle price: the mean of the two middle prices when the count is even. */
export function median(items) {
  const prices = items.map((item) => item.price);
  const mid = Math.floor(prices.length / 2);
  return prices.length % 2 ? prices[mid] : (prices[mid - 1] + prices[mid]) / 2;
}

/** What share of the catalog's total value `part` is, as a percent from 0 to 100. */
export function percent(part, items) {
  return (total(items) / part) * 100;
}
