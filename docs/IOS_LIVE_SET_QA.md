# iOS Live Activity: Complete Set review

This branch is stacked on `feature/ios-workout-live-activity`, which is itself based on
`fix/ios-native-plugins-registration`. Do **not** cherry-pick just this branch's final
commit onto `main`: both earlier iOS fixes are required.

## Status (2026-10-15)

- User authorized CI/build verification; the draft PR is open to trigger the iOS and frontend test workflows.

- Source updated. No GitHub Actions / IPA workflow has been run for this branch.
- Source-level checks completed; Swift compilation and physical iPhone testing still required.
- The existing Lock Screen rest controls (pause/resume, ±15 seconds and skip) remain separate.
- The Complete Set button is available on iOS 17+ for rep-based sets only, in the Lock
  Screen card and *expanded* Dynamic Island. Compact/minimal layouts cannot hold buttons.

## How it works, and an important limitation

1. `RestCompleteSetIntent` (app process) checks that a live workout and an eligible set
   are present, then writes a unique command and the exact set identity to UserDefaults.
2. The card shows **Queued — open openGym to save** and disables repeated presses.
3. When iOS lets the WebView run again, Capacitor redelivers the command.
4. `ActiveWorkout` checks the session ID, exercise, row, side, and fingerprint against
   the current source-of-truth workout. It then calls the *same* `toggle` used by in-app
   set checkboxes, preserving normal progression/rest/superset logic.
5. The command is acknowledged **only after** both localStorage and the mobile
   filesystem mirror have been written. An unacknowledged ID survives a process kill
   and is safely redelivered. Duplicate callbacks do not toggle the set off again.
6. Mismatched/stale targets are rejected rather than applied to a different row.

**This does not immediately persist the set while the WebView is suspended.** It queues
the action in native storage and completes it when the app returns. This is deliberate:
writing just the `done` flag directly into the mobile mirror from Swift would bypass the
React workout flow, including supersets, per-side logging, rest timers and progression.
Making that fully background-native requires a shared, thoroughly tested workout state
engine or an authoritative native-to-web transaction layer.

## Real-device QA before merge

1. Start a workout, lock the phone, expand the Island and tap Complete Set. Verify
   **Queued — open openGym to save** appears and a second tap cannot queue a second set.
2. Unlock and return to openGym: the same target is ticked, an appropriate rest starts,
   and the pending label clears. Confirm the completed set survives force-quit/relaunch.
3. Repeat from the Lock Screen (not just the expanded Dynamic Island).
4. Tick multiple sets in supersets and verify the correct member/round is chosen;
   compare against the in-app checkbox behavior.
5. Test a unilateral rep set: first Left, then Right; completed-set progress must count
   sides separately and never tick both from a single press.
6. Lock the phone, tap Complete Set, then change/remove/reorder the target before
   the command is handed to JS. The stale command must be rejected without toggling
   a different row.
7. Test network-offline mode and relaunch. Local saved workout should remain correct.
8. Verify the direct action does *not* appear for cardio or timed sets; their log/timer
   semantics cannot be safely inferred from the widget.
9. Let a rest expire while locked and verify Complete Set is offered from the Ready
   card; its press must clear the stale rest before the next rest gets booked.
   Pause a rest before it expires and ensure Complete Set does not become active.
10. Confirm rest Pause, Resume, -15s, +15s and Skip still work from both surfaces.
11. Check that iOS's Live Activities and notification permissions can be independently
    enabled/disabled without breaking the workout screen.

## Known follow-ups

- True locked-screen background *persistence* without reopening the WebView (larger
  architectural change; current behavior is deliberately explicit).
- Immediate post-set rest countdown on the Lock Screen while the WebView is suspended:
  currently rest follows the existing React toggle on resume.
- Localization of the new Swift-only Complete Set and pending labels across all
  openGym languages.
- Instrumented on-device verification of AppIntent execution, widget layout at different
  Dynamic Island sizes and ActivityKit lifetime on long workouts.

The new branch has no PR specifically to avoid triggering the fork's `ios.yml`
`pull_request` workflow. Only create a PR or dispatch a build after user approval.
