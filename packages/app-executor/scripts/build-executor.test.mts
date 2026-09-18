import assert from 'node:assert/strict';
import test from 'node:test';

const { resolveDesktopTarget, resolveExecutorBuildPlan } = await import('./build-executor.cjs');

void test('prefers a non-empty explicit target and falls back to Tauri target propagation', () => {
  assert.equal(
    resolveDesktopTarget({
      rivetDesktopTarget: 'aarch64-apple-darwin',
      tauriTargetTriple: 'x86_64-apple-darwin',
    }),
    'aarch64-apple-darwin',
  );
  assert.equal(
    resolveDesktopTarget({
      rivetDesktopTarget: ' ',
      tauriTargetTriple: 'aarch64-apple-darwin',
    }),
    'aarch64-apple-darwin',
  );
});

void test('creates a native Apple Silicon executor plan', () => {
  assert.deepEqual(
    resolveExecutorBuildPlan({
      platform: 'darwin',
      desktopTarget: 'aarch64-apple-darwin',
    }),
    {
      pkgTarget: 'node18-macos-arm64',
      source: 'dist/rivet-app-executor',
      destination: 'dist/app-executor-aarch64-apple-darwin',
      targetTriple: 'aarch64-apple-darwin',
    },
  );
});

void test('creates a native Intel macOS executor plan', () => {
  assert.deepEqual(
    resolveExecutorBuildPlan({
      platform: 'darwin',
      desktopTarget: 'x86_64-apple-darwin',
    }),
    {
      pkgTarget: 'node18-macos-x64',
      source: 'dist/rivet-app-executor',
      destination: 'dist/app-executor-x86_64-apple-darwin',
      targetTriple: 'x86_64-apple-darwin',
    },
  );
});

void test('rejects falsely universal macOS executor packaging', () => {
  assert.throws(
    () =>
      resolveExecutorBuildPlan({
        platform: 'darwin',
        desktopTarget: 'universal-apple-darwin',
      }),
    /Build separate aarch64-apple-darwin or x86_64-apple-darwin packages/,
  );
});

void test('only packages explicitly supported Linux targets', () => {
  assert.deepEqual(
    resolveExecutorBuildPlan({
      platform: 'linux',
      desktopTarget: 'aarch64-unknown-linux-gnu',
    }),
    {
      pkgTarget: 'node18-linux-arm64',
      source: 'dist/rivet-app-executor',
      destination: 'dist/app-executor-aarch64-unknown-linux-gnu',
      targetTriple: 'aarch64-unknown-linux-gnu',
    },
  );
  assert.throws(
    () =>
      resolveExecutorBuildPlan({
        platform: 'linux',
        desktopTarget: 'riscv64gc-unknown-linux-gnu',
      }),
    /Unsupported Linux desktop target/,
  );
});

void test('uses the Rust host target outside explicit desktop packaging', () => {
  assert.deepEqual(
    resolveExecutorBuildPlan({
      platform: 'win32',
      rustHostTarget: 'x86_64-pc-windows-msvc',
    }),
    {
      pkgTarget: 'node18-win-x64',
      source: 'dist/rivet-app-executor.exe',
      destination: 'dist/app-executor-x86_64-pc-windows-msvc.exe',
      targetTriple: 'x86_64-pc-windows-msvc',
    },
  );
});
