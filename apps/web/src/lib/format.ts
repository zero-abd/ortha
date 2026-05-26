/** Money is integer cents in the contract; the UI shows dollars (DESIGN.md). */
export function dollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export function ms(value: number): string {
  return `${Math.round(value)}ms`;
}
