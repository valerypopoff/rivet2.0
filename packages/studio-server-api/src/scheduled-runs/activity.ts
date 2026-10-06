let active = 0;
export function getActiveScheduledRunCount() {
  return active;
}
export function beginScheduledActivity() {
  active++;
  let released = false;
  return () => {
    if (!released) {
      released = true;
      active--;
    }
  };
}
