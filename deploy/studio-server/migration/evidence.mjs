// Shared by the ledger verifier and its bounded CI history preparation.
// These identities describe the reviewed, non-squashed subtree import.
export const migrationEvidence = Object.freeze({
  version: 1,
  sourceCommit: 'fed8964eb86e9db134e7a2742a4ef26d271f6439',
  sourceTree: 'dff081c4d11d2fbda113967006b3fad9efb54509',
  importCommit: '860d549b91001f8a282063ff097fd05e4318efb0',
  importPrefix: '_import/studio-server',
  migrationCommit: 'e2136da480fe4bcd830acb16a5f08763da70f389',
});

// Read the raw commit header, not `git show`: even --no-patch can prefetch
// historical diff blobs in partial clones. Message text is not ancestry.
export function migrationCommitParents(commit) {
  return commit
    .split('\n\n', 1)[0]
    .split('\n')
    .filter((line) => /^parent [a-f0-9]{40}$/.test(line))
    .map((line) => line.slice(7));
}
