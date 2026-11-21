const legacy = {
  readableEncodings: ['identity', 'gzip'],
  writableEncodings: ['identity', 'gzip'],
  coordinationProtocol: 0,
};
const encodings = ['identity', 'gzip', 'br'];

export function recordingStorageContract(value) {
  if (value === undefined) return { ...legacy };
  const normalize = (items) => {
    if (
      !Array.isArray(items) ||
      !items.length ||
      new Set(items).size !== items.length ||
      items.some((item) => !encodings.includes(item))
    )
      throw Error('Invalid recording storage encodings.');
    return encodings.filter((item) => items.includes(item));
  };
  const readableEncodings = normalize(value.readableEncodings),
    writableEncodings = normalize(value.writableEncodings);
  if (
    ![0, 1].includes(value.coordinationProtocol) ||
    writableEncodings.some((item) => !readableEncodings.includes(item))
  )
    throw Error('Invalid recording storage capability contract.');
  return { readableEncodings, writableEncodings, coordinationProtocol: value.coordinationProtocol };
}

/** Gzip-only peers must retire before any Brotli writer is admitted. */
export function assertRecordingStorageUpgrade(installed, candidate, { maintenance = false } = {}) {
  const old = recordingStorageContract(installed),
    next = recordingStorageContract(candidate);
  if (old.writableEncodings.some((encoding) => !next.readableEncodings.includes(encoding)))
    throw Error('Candidate cannot read recordings written by the installed release.');
  if (!maintenance && next.writableEncodings.some((encoding) => !old.readableEncodings.includes(encoding)))
    throw Error('Recording codec upgrade requires a reader-first release or a drained maintenance cutover.');
  // Once historical conversion is permitted, reverting to tooling that does
  // not coordinate with it is unsafe, even if its readers understand Brotli.
  if (old.coordinationProtocol > next.coordinationProtocol)
    throw Error('Candidate removes recording maintenance coordination.');
}

export function assertRecordingCheckpointReaders(requiredEncodings, readers) {
  const available = recordingStorageContract(readers).readableEncodings;
  if (
    !Array.isArray(requiredEncodings) ||
    requiredEncodings.some((encoding) => !encodings.includes(encoding) || !available.includes(encoding))
  )
    throw Error('Restore target cannot read the checkpoint recording encodings.');
}
