/** Bounded observations only. Settle every started read before returning or
 * throwing, so a failed guard cannot leave work running beside a later write. */
export async function readConcurrently(reads) {
  const values = new Array(reads.length);
  let next = 0;
  let failed = false;
  let failure;
  await Promise.all(
    Array.from({ length: Math.min(4, reads.length) }, async () => {
      while (!failed) {
        const index = next++;
        if (index >= reads.length) return;
        try {
          values[index] = await reads[index]();
        } catch (error) {
          if (!failed) failure = error;
          failed = true;
        }
      }
    }),
  );
  if (failed) throw failure;
  return values;
}
