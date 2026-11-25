# Test image for the Docker integration test. It is not the worker image.
# It has Bun, Git and a fake OpenCode command, so a run calls no model and needs no real key.
# The Docker executor builds it the same way as the real Dockerfile: the build
# context holds this file, dist/worker.js and plugins/.
FROM oven/bun:1.4.4-slim

RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git \
    && rm -rf /var/lib/apt/lists/*

RUN useradd --create-home --uid 10001 --shell /usr/sbin/nologin ultrafuzz

COPY <<'EOF' /usr/local/bin/opencode
#!/bin/sh
# Fake OpenCode CLI for tests. It reads the prompt, prints JSON events and writes files.
# The model name selects the behaviour: a name with "slow" waits for a stop signal.
if [ "$1" = "--version" ]; then echo "0.0.0-test"; exit 0; fi
[ "$1" = "run" ] || exit 2
model=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--model" ]; then model="$2"; fi
  shift
done
cat > /dev/null
# The worker sets HOME to <run root>/state/home.
raw="$HOME/../../outputs/raw"
echo '{"type":"step_start","sessionID":"ses_dockertest"}'
case "$model" in
  *slow*)
    echo "started" > "$raw/notes.md"
    trap 'exit 143' TERM INT
    sleep 3600 &
    wait "$!"
    ;;
  *)
    {
      echo "# Test report"
      echo
      echo "Solidity files: $(find . -name '*.sol' | wc -l)"
      echo
      ls
    } > "$raw/report.md"
    # A link that points out of the outputs. Collection must drop it and record it.
    ln -s /etc/hostname "$raw/outside-link"
    echo '{"type":"step_finish","sessionID":"ses_dockertest","part":{"id":"step-1","cost":0,"tokens":{"input":1,"output":1}}}'
    ;;
esac
EOF
RUN chmod 755 /usr/local/bin/opencode

# The same lines as in the real Dockerfile. They prove that the build context holds the worker runtime.
COPY dist/worker.js /opt/ultrafuzz/worker.js
COPY plugins/ /opt/ultrafuzz/plugins/
WORKDIR /run-data
