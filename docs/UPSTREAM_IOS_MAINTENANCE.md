# Maintaining openGym iOS alongside the upstream project

This fork's `main` carries a Capacitor iOS implementation on top of
[DuarteSantos8/openGym](https://github.com/DuarteSantos8/openGym). Our features
include ActivityKit's Lock Screen and Dynamic Island workout/rest Live Activity,
App Intent rest/set controls, native notifications/haptics, and iPhone UI fixes.

**An upstream release does not remove our native iOS support.** Upstream may
change React workout state, Capacitor dependencies, mobile file layout or the
Xcode project, though, so bringing over upstream commits is a change requiring
review and testing.

## Safe update process (whenever upstream releases or you want to sync)

1. Look at the upstream release notes and identify the version/commit to import.
   Note that upstream may rewrite branch history, so do not blindly reset this
   fork's `main` or select "discard my commits" in the Sync Fork UI.
2. In a local clone (Windows + Git works for the source merge, no Mac required):

   ```bash
   git remote add upstream https://github.com/DuarteSantos8/openGym.git
   # If upstream already exists, skip the previous line.
   git fetch origin
   git fetch upstream
   git switch main
   git pull --ff-only origin main
   git switch -c sync/upstream-YYYYMMDD
   git merge upstream/main
   ```

   If Git reports conflicts, resolve the *source* changes intentionally rather
   than choosing all of "ours" or all of "theirs". Keep the iOS bridge, WidgetKit
   extension, App Intents and native mobile persistence. You may need to adapt
   the JS workout events to upstream's new React store shape.
3. On the review branch, run:

   ```bash
   cd frontend
   npm ci
   npm test
   npm run build
   ```

   For backend changes, also run `cd ../api && npm ci && npm test`.
4. Push the sync branch to the fork and open a PR into `main`. The existing
   `.github/workflows/ios.yml` builds a *test unsigned IPA* on pull requests
   that change `frontend/**`. Check its Xcode archive, embedded app widget
   and App Intents metadata as well as the frontend/API tests.
5. Install that PR artifact on an iPhone before merging if upstream changed
   the workout timer, rest events, navigation, ActivityKit state, notifications,
   storage format, or Capacitor plugins. Verify the lock screen with/without
   Spotify, timers and Complete Set. A green compiler is **not** a device test.
6. Merge the PR only after conflicts and regressions are resolved. Each push to
   the fork's `main` now triggers a new unsigned IPA artifact (Actions →
   **iOS app (.ipa)** → the latest `main` run → Artifacts). No Apple paid
   Developer membership is required for this unsigned build; sideloading still
   requires signing.

For a release, it is safer to merge one upstream release at a time than to
cherry-pick individual React changes. If the upstream project later ships
official iOS, compare both native implementations and choose one deliberately;
do not overwrite this fork's widget extension automatically.

## Current upstream state (checked 2026-10-15)

At the time this maintenance guide was created, the upstream `main` branch
had diverged from the original fork point; its newest difference was primarily
CLA/contribution documentation and workflows. We deliberately did **not**
merge that unrelated upstream work during the iOS consolidation/build task.

## Keeping a record

Keep all ongoing custom iOS work in a feature branch/PR. Merge to `main`
only after tests and, for native changes, an unsigned IPA build and on-device
validation. The official upstream remains configured as the `upstream` remote;
our fork's `origin/main` is the preserved distribution branch.
