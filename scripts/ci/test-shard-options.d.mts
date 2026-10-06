export function selectTestShard<T>(files: T[], shardIndex: number, shardCount: number): T[];
export function parseTestShardOptions(args: string[]): { shardIndex: number; shardCount: number; check: boolean };
