// App and API gates must interpret the same CLI coordinates. A typo must fail,
// never silently turn a shard into a full-suite run or omit part of the suite.
export function selectTestShard(files, shardIndex, shardCount) {
  if (!Number.isSafeInteger(shardCount) || shardCount < 1) {
    throw new Error('shardCount must be a positive integer.');
  }
  if (!Number.isSafeInteger(shardIndex) || shardIndex < 0 || shardIndex >= shardCount) {
    throw new Error(`shardIndex must be between 0 and ${shardCount - 1}.`);
  }
  return files.filter((_file, index) => index % shardCount === shardIndex);
}

export function parseTestShardOptions(args) {
  const options = { shardIndex: 0, shardCount: 1, check: false };
  const seen = new Set();
  // Yarn preserves a leading argument separator when forwarding script flags.
  for (let index = args[0] === '--' ? 1 : 0; index < args.length; index += 1) {
    const flag = args[index];
    if (!['--shard-index', '--shard-count', '--check'].includes(flag)) {
      throw new Error(`Unknown test option: ${flag}`);
    }
    if (seen.has(flag)) throw new Error(`Duplicate test option: ${flag}`);
    seen.add(flag);
    if (flag === '--check') {
      options.check = true;
      continue;
    }
    const rawValue = args[++index];
    const value = Number(rawValue);
    if (!/^-?\d+$/.test(rawValue ?? '') || !Number.isSafeInteger(value)) {
      throw new Error(`${flag} must be a safe integer.`);
    }
    options[flag === '--shard-index' ? 'shardIndex' : 'shardCount'] = value;
  }
  selectTestShard([], options.shardIndex, options.shardCount);
  return options;
}
