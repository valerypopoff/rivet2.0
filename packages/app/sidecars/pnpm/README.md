# pnpm Tauri Sidecars

Rivet tracks these `pnpm` binaries intentionally because the desktop app uses Tauri sidecars to install package plugins without depending on a user-installed `pnpm`.

Runtime consumers:

- `packages/app/src-tauri/tauri.conf.json` lists `../sidecars/pnpm/pnpm` in `bundle.externalBin`.
- `packages/app/src/hooks/useLoadPackagePlugin.ts` starts `../sidecars/pnpm/pnpm` through the Tauri sidecar shell API.

Current policy:

- Keep the binaries in Git until the release pipeline has a checksum-verified download or Git LFS replacement.
- Treat these files as vendored binary artifacts, not generated source.
- Keep `SHA256SUMS` updated whenever any sidecar binary changes.
- Keep `.gitattributes` marking this directory as binary and vendored.

Current sidecar version:

- All supported target binaries report `8.8.0`.
- `pnpm-aarch64-apple-darwin` is the official `pnpm-macos-arm64` v8.8.0 binary (SHA-256 `25aa33415e3b6895e3cf90ce2ed67ce648155fe4623b9f7595520c5b57f19c45`).
- `pnpm-x86_64-apple-darwin` is the matching Intel macOS binary. Rivet ships separate native Mac installers; do not add a falsely universal sidecar by copying either file under another target name.

Update checklist:

1. When upgrading pnpm, replace all target sidecar binaries together from their upstream release assets.
2. On macOS, use `lipo -archs` to confirm each binary's architecture before accepting it. A target suffix is not proof of its contents.
3. Run every sidecar with `--version` and update this file if the version changes.
4. Regenerate checksums from the repository root:

   ```powershell
   Get-ChildItem packages/app/sidecars/pnpm -File |
     Where-Object { $_.Name -like 'pnpm-*' } |
     Get-FileHash -Algorithm SHA256 |
     Sort-Object Path |
     ForEach-Object {
       '{0}  {1}' -f $_.Hash.ToLowerInvariant(), (Resolve-Path -Relative $_.Path).TrimStart('.\').Replace('\', '/')
     }
   ```

5. Replace `packages/app/sidecars/pnpm/SHA256SUMS` with the regenerated output.
6. Verify the signed, packaged Tauri app can still start the sidecar and install a package plugin.

Future improvement:

- Move these artifacts to Git LFS or a checksum-verified release-artifact download step once the release pipeline can guarantee offline-safe packaging from a clean checkout.
