/* Coach fixtures intentionally use calendar dates in July 2026. The 12-week
 * review window moved past them on 2026-10-13, turning valid "ready" scenarios
 * into empty "nochange" reviews and breaking ten API tests three days after
 * the original all-green run. This test-only clock makes the fixture's calendar
 * reproducible while leaving the real coaching service untouched.
 *
 * It advances at exactly the rate of the wall clock: timeout and expiry tests
 * still measure elapsed time, and a test never hangs on a frozen Date.now().
 * Imported by only the five fixture-dependent suites; all other tests use
 * the actual date. Node's test runner isolates test files in processes.
 */
const RealDate = globalThis.Date;
const fixtureToday = RealDate.parse('2026-10-12T12:00:00.000Z');
const offsetMs = fixtureToday - RealDate.now();

function FixtureDate(...args) {
  if (!new.target) return new RealDate(RealDate.now() + offsetMs).toString();
  // Preserve explicit dates and both constructor overload families.
  if (args.length) return Reflect.construct(RealDate, args, new.target);
  return Reflect.construct(RealDate, [RealDate.now() + offsetMs], new.target);
}
Object.setPrototypeOf(FixtureDate, RealDate);
FixtureDate.prototype = RealDate.prototype;
FixtureDate.now = () => RealDate.now() + offsetMs;
globalThis.Date = FixtureDate;
