import assert from 'node:assert/strict';

/** Inspect or cooperatively stop one nonce-bound CPU fixture, never a PID alone. */
export function proxyFixtureProcessCommand(item, { stop = false } = {}) {
  assert.match(item.marker, /^\/tmp\/rivet-hpa-load-[a-f0-9-]+\.json$/);
  assert.match(item.stop, /^\/tmp\/rivet-hpa-stop-[a-f0-9-]+$/);
  assert.ok(Number.isInteger(item.pid) && item.pid > 1);
  assert.match(item.startTicks, /^\d+$/);
  const inspect = `pid="$3"
read_ticks() {
  if stat=$(cat /proc/"$pid"/stat 2>/dev/null); then
    case "\${stat##*) }" in Z\\ *|X\\ *) return 0;; esac
    ticks=$(printf '%s\\n' "\${stat##*) }" | awk '{print $20}')
    case "$ticks" in ''|*[!0-9]*) return 1;; esac
    printf '%s\\n' "$ticks"
  else
    test ! -e /proc/"$pid"/stat
  fi
}
ticks=$(read_ticks)
`;
  const action = stop
    ? `if [ "$ticks" = "$4" ]; then
  if ! grep -Fq -- "$1" /proc/"$pid"/cmdline; then
    test "$(read_ticks)" != "$4"
    exit
  fi
  # Recheck after inspecting cmdline. Never signal or write for a reused PID.
  if [ "$(read_ticks)" = "$4" ]; then test -e "$2" || : > "$2"; fi
fi`
    : 'printf \'%s\\n\' "$ticks"';
  return ['sh', '-ec', inspect + action, 'owned-fixture', item.marker, item.stop, String(item.pid), item.startTicks];
}
