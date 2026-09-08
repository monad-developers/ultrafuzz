# OWASP SCS pinned-source fixture

`owasp-scs-fefd476b.json.gz` contains unchanged source bytes from
[OWASP Smart Contract Security](https://github.com/OWASP/owasp-scs/tree/fefd476b83074666ada2d816f103436a18e1ece4),
commit `fefd476b83074666ada2d816f103436a18e1ece4`: 156 SCWE Markdown records,
the SCSVS registry, SCWE index, and `License.md`. It also records the complete
Git tree and each selected file's original blob identity. The OWASP Foundation
and OWASP SCS contributors provide this material under
[CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/); their full,
unchanged license is included in the fixture. JSON encoding and gzip compression
are the only transformations. This test data retains its upstream license.

The offline regression checks the shipped reference pin, complete discovered
path set, Git blob identities, 156 records, 11 groups, exact derived catalog and
source aggregate digests, materialization, and selected source bytes. Changing
the shipped pin requires reviewing and updating this fixture and its expected
catalog identities together. The production package does not ship test fixtures.

To regenerate from the upstream Git objects, fetch the exact commit into a
temporary repository, then run the following from the Ultrafuzz repository root
with `OWASP_FIXTURE_REPO` pointing to that temporary repository:

```python
import gzip
import json
import os
import re
import subprocess
from pathlib import Path

repo = os.environ["OWASP_FIXTURE_REPO"]
commit = "fefd476b83074666ada2d816f103436a18e1ece4"
tree = subprocess.check_output(["git", "-C", repo, "ls-tree", "-rz", commit])
files = []
for entry in tree.split(b"\0"):
    if not entry:
        continue
    metadata, name = entry.split(b"\t", 1)
    mode, kind, blob = metadata.decode().split()
    name = name.decode()
    required = name in ["License.md", "docs/SCSVS/scsvs.yaml", "docs/SCWE/index.md"]
    if required or re.fullmatch(r"docs/SCWE/SCSVS-[A-Z]+/SCWE-[0-9]{3}\.md", name):
        data = subprocess.check_output(["git", "-C", repo, "show", f"{commit}:{name}"])
        assert data.decode().encode() == data
        files.append(dict(path=name, mode=mode, type=kind, git_blob=blob, contents=data.decode()))
fixture = dict(repo="OWASP/owasp-scs", commit=commit, files=files, git_tree=tree.decode())
body = (json.dumps(fixture, ensure_ascii=False, separators=(",", ":")) + "\n").encode()
Path("packages/references/test/fixtures/owasp-scs-fefd476b.json.gz").write_bytes(
    gzip.compress(body, compresslevel=9, mtime=0)
)
```
