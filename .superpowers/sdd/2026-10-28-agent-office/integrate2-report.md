# integrate2 report (2026-10-28)

Merges into main (all --no-ff, no conflicts, config.json merged automatically with every new key):
- fix2/1 -> 6aee966 (npm test 225/225)
- fix2/2 -> ff2cd40 (233/233)
- fix2/4 -> a6e88f0 (235/235)
- fix2/3 -> de5c38a (243/243)

Seam fix (group 1 open finding): frozen run cache key `run:<dir>` never matched Poller.#dropState prefix (`<sessionDir>\`), so frozen meta arrays leaked after a session ended. Key is now join(dir, 'run') in server/agents.mjs. Test added in tests/round2-poller.test.mjs (every cache key lies under the session dir; each settled run is frozen).

Final npm test: 244/244 pass.

cross_group notes (group 4 override reach): no action needed, no caller passes overrides.
Open / accepted: 30-agent overlap not fully removable (worst 0.45 of a character box); clip limits not overridable at load time (commented).
Not run: real-home CPU, headless capture (not requested in this step).
