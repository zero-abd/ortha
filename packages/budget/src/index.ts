// @ortha/budget — a BudgetPolicy implementation over an injectable spend-store
// port. checkEstimate gates on the soft session cap + hard workspace cap;
// reserve→settle/refund is an auth/capture lifecycle against the monthly cap.
// The workspace cap is enforced atomically by the store (D1 in prod), so
// concurrent overspend is impossible.
export { createBudgetPolicy, type BudgetPolicyDeps, type BudgetSettings, type SpendStorePort } from "./policy.js";
export { InMemorySpendStore, type SpendStore } from "./store.js";
