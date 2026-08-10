import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, rmSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

const out = resolve('tests/fixtures/wispr-fixture.sqlite');
mkdirSync(resolve('tests/fixtures'), { recursive: true });
for (const suffix of ['', '-wal', '-shm']) rmSync(out + suffix, { force: true });

// Mirrors the real Meetings columns this plugin reads. WAL mode is deliberate:
// the production database is WAL, and that is what forces immutable=1.
//
// This first phase is checkpointed (the sqlite3 CLI checkpoints when the last
// connection closes), so everything created here lands in the main database
// file. The Meetings ROWS deliberately do NOT: they are inserted in phase two
// below and left in the -wal. See the comment there for why that matters.
const sql = `
PRAGMA journal_mode=WAL;
CREATE TABLE Meetings (
  id VARCHAR(36) NOT NULL PRIMARY KEY,
  title VARCHAR(255),
  notes TEXT,
  summary TEXT,
  speakerMap TEXT,
  createdAt DATETIME NOT NULL,
  modifiedAt DATETIME NOT NULL,
  endedAt INTEGER,
  isDeleted TINYINT(1) NOT NULL DEFAULT 0,
  finalized TINYINT(1) NOT NULL DEFAULT 0
);
-- Padding table. Mirrors reality: History is roughly 100 MB of the real
-- 217 MB flow.sqlite. Without this, the fixture is only ~12 KB, and the
-- lazy-paging test's "bytes < file size" assertion is nearly vacuous (an
-- implementation that slurped the whole file would still pass it). Pushing
-- the file well past 2 MB makes the 512 KB ceiling — and a bytes/size ratio
-- check — load-bearing. It also provides enough sortable data to force a
-- real disk-spilling sort, exercising the temp_store=MEMORY regression test.
CREATE TABLE History (
  id INTEGER PRIMARY KEY,
  payload BLOB NOT NULL
);
WITH RECURSIVE seq(x) AS (
  SELECT 1
  UNION ALL
  SELECT x + 1 FROM seq WHERE x < 8000
)
INSERT INTO History (payload)
SELECT randomblob(1000) FROM seq;
`;
execFileSync('sqlite3', [out], { input: sql });

/**
 * Phase two: the meeting rows, committed but LEFT IN THE -wal.
 *
 * This is the whole point of the fixture. A production Wispr Flow database
 * is never a quiescent, fully-checkpointed file: the app holds its
 * connection open for as long as it runs, so recent (and after a schema
 * migration, all) meeting rows sit in the -wal, and the main file alone
 * answers `SELECT count(*) FROM Meetings` with 0. A fixture built by the
 * sqlite3 CLI in one pass reproduces none of that — the CLI checkpoints on
 * exit, so every row lands in the main file and a reader that ignores the
 * WAL entirely still passes. That is exactly the blind spot that let the
 * plugin ship reading zero meetings on a real install while its own
 * "reads rows from a WAL-mode database" test stayed green.
 *
 * Two details make the leftover WAL deterministic rather than lucky:
 *   - `wal_autocheckpoint=0`, so committing does not fold the frames back
 *     into the main file by itself.
 *   - SIGKILL instead of a clean exit, because closing the last connection
 *     is itself a checkpoint. stdin is deliberately left OPEN so the CLI
 *     never reaches end-of-input and exits cleanly out from under us; the
 *     kill happens only after the marker SELECT has printed, which cannot
 *     happen before the COMMIT is durable in the WAL.
 */
const walOnlySql = `
PRAGMA wal_autocheckpoint=0;
BEGIN;
INSERT INTO Meetings VALUES
 ('m-0001','Alpha Meeting','## Notes A','Sum A',
  '{"people":{"p1":{"name":"Ada"}},"assignments":{"1":{"user":"p1"}}}',
  '2026-08-04 06:34:41.421 +00:00','2026-08-04 07:00:00.000 +00:00',1785825566070,0,1),
 ('m-0002','Beta Meeting',':::toggle
## Flow Summary

Body <@speaker:1>.
:::','Sum B',NULL,
  '2026-08-05 06:09:15.012 +00:00','2026-08-05 06:40:00.000 +00:00',1785910712175,0,1),
 ('m-0003','Deleted Meeting','x','y',NULL,
  '2026-08-05 11:44:56.853 +00:00','2026-08-05 11:50:00.000 +00:00',1785930345330,1,1),
 ('m-0004','Unfinalized Meeting','z','w',NULL,
  '2026-08-06 06:51:41.341 +00:00','2026-08-06 06:55:00.000 +00:00',1785999451817,0,0);
COMMIT;
SELECT 'FIXTURE_COMMITTED';
`;

await new Promise((resolvePromise, reject) => {
  const child = spawn('sqlite3', [out]);
  let stdout = '';
  let killed = false;

  child.stdout.on('data', (chunk) => {
    stdout += chunk.toString();
    if (!killed && stdout.includes('FIXTURE_COMMITTED')) {
      killed = true;
      child.kill('SIGKILL');
    }
  });
  child.on('error', reject);
  child.on('exit', () => {
    if (killed) resolvePromise();
    else reject(new Error(`sqlite3 exited before committing: ${stdout}`));
  });

  // No stdin.end(): see the comment above.
  child.stdin.write(walOnlySql);
});

// Fail loudly rather than silently producing a fixture that cannot detect
// the regression it exists for.
const walSize = statSync(`${out}-wal`).size;
if (walSize === 0) throw new Error('fixture -wal is empty; the rows were checkpointed away');

console.log('fixture written:', out, `(-wal: ${walSize} bytes, uncheckpointed)`);
