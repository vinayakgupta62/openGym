# iPhone workout UX fixes — review checklist

This branch stacks on `feature/ios-lockscreen-complete-set-review`. Its ancestor
branches contain the existing ActivityKit Live Activity and native plugin fixes.

## Changes prepared (no IPA build run on this branch)

- **iOS Shake to Undo:** `AppDelegate` disables the application-only shake
  gesture. The dialog was a system text-edit prompt triggered by gym movement;
  it was not openGym asking to undo a set. It does not affect explicit text editing.
- **Lock Screen exercise title:** smaller one-line type with tail truncation,
  padding, and reduced minimum width; keeps the rest buttons visible. Apple's
  Now Playing card can change how several Live Activities stack, so overlapping
  music-card geometry still requires device testing.
- **Dynamic Island (Option 1):** compact leading says SET while exercising and
  REST while resting (including paused/finished rest). Compact trailing renders
  exactly one clock: workout duration, a running/frozen rest timer, or Ready once
  rest ends. No duplicate green stopwatches or redundant DONE badge. The minimal
  layout remains available when Spotify shares the Island; iOS positions both
  compact surfaces around the camera by design.
  A Live Activity must support both Island and Lock Screen presentations.
- **Automatic next exercise:** checking the last set of the selected unit
  selects the next unfinished unit in Cards, Focus, List, and Compact. A superset
  advances only when the whole superset finishes, not after each member. No
  auto-advance on partial sets, backfill edits or repeated old progress; Focus
  avoids double-advancing via its own callback.
- **Keep session additions in routine:** workouts deliberately store their
  exercise list separately from their reusable routines. Finish Summary now
  offers an explicit button to copy new exercises back into their original
  routine. Saved workouts in History have an additional button, so workouts
  recorded with an earlier build can be updated retroactively.
  No change to original planned slots, saved historical sets, or the training
  history unless the user confirms; second use cannot duplicate entries.
  Combined sessions use each exercise's own routine id.

## On-device QA to run after an authorized build

1. Move the phone around with a numeric set input open/just blurred. The native
   Undo Typing alert should not appear on the app.
2. Start a long-name lift: the title should truncate within the Lock Screen card.
   Verify with Spotify playing and paused and with two Live Activities.
3. On the Home Screen, compact Island shows REST + countdown, then REST + Ready,
   never two identical timer symbols. During work it shows SET + elapsed. Check
   paused rest and Spotify simultaneously; the system decides their spacing.
4. Complete a singleton exercise's last set in Cards; the next exercise
   appears without tapping Next. Repeat in Focus/List/Compact.
5. Complete a two-member superset and verify the app follows round-major
   order and only advances to the next unit after the final member's final set.
6. Finish the last exercise and verify the normal Finish sheet still opens,
   without jumping to another exercise. Recheck old completed sets; do not
   unexpectedly navigate.
7. Start a single-exercise planned routine, add two extra exercises, complete
   them, finish, and use the Finish Summary button to add the two to the plan.
   Next time, the source routine should now contain three exercises.
8. For an already finished session, open History > that session > **Add new
   exercises to original routine**, confirm, and verify the plan updates
   without creating a duplicate routine. The button should disappear.
9. Retry the saved-routine action, test a workout with two original routines,
   and test duplicate movements; additions should not be duplicated or assigned
   to the wrong source routine.

## Remaining limits

- iOS chooses the vertical placement of stacked Lock Screen widgets and the
  two endpoints of a compact Dynamic Island. Our code cannot merge the endpoints,
  move Spotify's card, or offer a Lock Screen-only ActivityKit experience.
- A Lock Screen Complete Set while the WebView is suspended remains queued
  until openGym comes to the foreground, as documented in IOS_LIVE_SET_QA.md.
- New UI copy uses English fallbacks until all locale packs are updated.
- No native compilation, automated test run or device testing has happened
  for **this new branch**; existing successful IPA results were from its parent.
