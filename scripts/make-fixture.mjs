import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

const out = resolve('tests/fixtures/wispr-fixture.sqlite');
mkdirSync(resolve('tests/fixtures'), { recursive: true });
for (const suffix of ['', '-wal', '-shm']) rmSync(out + suffix, { force: true });

// Mirrors the real Meetings columns this plugin reads. WAL mode is deliberate:
// the production database is WAL, and that is what forces immutable=1.
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
console.log('fixture written:', out);
