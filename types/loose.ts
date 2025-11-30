// Central escape hatch for messy or dynamic types.
// Use sparingly but guilt-free when TS becomes more work than it’s worth.

export type Loose = any;
export type LooseRecord = Record<string, any>;
export type LooseArray = any[];
