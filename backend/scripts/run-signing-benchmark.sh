#!/usr/bin/env bash
#
# Measure the incremental signing lifecycle under a real 512 MiB limit.
#
# Three processes, deliberately separated:
#   1. fake-gcs-server, in its own container, holds the bytes.
#   2. `--prepare` runs on the HOST and writes a source of the requested size.
#      Fixture construction is not part of what is measured.
#   3. `--run` runs inside a Podman container capped at 512 MiB with swap
#      disabled, built from the Dockerfile's `build` stage so `tsx` and the
#      sources are present. That is the same Node, the same dependencies and
#      the same code as production; only the layer that strips dev tooling is
#      skipped, because `scripts/` is not compiled into `dist/`.
#
# Usage: scripts/run-signing-benchmark.sh 100 500
#        BENCHMARK_CONCURRENCY=6 scripts/run-signing-benchmark.sh 100
#
# `BENCHMARK_CONCURRENCY` runs that many signing operations at once inside the
# one capped container, which is how the per-instance slot count in
# `transferSlot.ts` is chosen rather than assumed.
# Prints one JSON line per size. A killed container prints an EXIT line with
# code 137, which is the OOM answer and is a result, not an error in this script.
set -euo pipefail

cd "$(dirname "$0")/.."

SIZES=("$@")
if [ ${#SIZES[@]} -eq 0 ]; then SIZES=(100 500 2048); fi

# Named and ported so this runner never collides with another benchmark
# container already published on the usual emulator port. Override either with
# the environment when two runs really do have to share a machine.
GCS_NAME="${BENCHMARK_GCS_NAME:-paralegix-signing-benchmark-gcs}"
# The proxy is what everything talks to; the emulator sits behind it. See
# `scripts/gcs-path-proxy.ts` for why one is needed at all.
PROXY_PORT="${BENCHMARK_GCS_PORT:-4553}"
GCS_PORT="${BENCHMARK_GCS_UPSTREAM_PORT:-4554}"
BUCKET="lawfirms"
IMAGE="paralegix-benchmark:local"

# A throwaway service account. cert() validates the shape of the key and the
# emulator never checks a signature, so any well-formed RSA key will do.
KEY_DIR="$(mktemp -d)"
openssl genrsa -out "$KEY_DIR/key.pem" 2048 2>/dev/null
PRIVATE_KEY="$(awk 'BEGIN{ORS="\\n"} {print}' "$KEY_DIR/key.pem")"
SERVICE_ACCOUNT="{\"type\":\"service_account\",\"project_id\":\"benchmark\",\"client_email\":\"bench@benchmark.iam.gserviceaccount.com\",\"private_key\":\"${PRIVATE_KEY}\"}"

PROXY_PID=""
cleanup() {
  if [ -n "$PROXY_PID" ]; then kill "$PROXY_PID" 2>/dev/null || true; fi
  podman rm -f "$GCS_NAME" >/dev/null 2>&1 || true
  rm -f "$KEY_DIR/key.pem"
}
trap cleanup EXIT

podman rm -f "$GCS_NAME" >/dev/null 2>&1 || true
# A FILESYSTEM backend, not the default in-memory one. The lifecycle produces
# a stamped copy and two sealed artifacts, so a 2 GiB source means roughly 8 GiB
# of objects; held in the emulator's heap that exhausts the machine and the run
# dies with a socket hang up that looks like a bug in the code under test.
podman run -d --name "$GCS_NAME" -p "127.0.0.1:${GCS_PORT}:4443" \
  docker.io/fsouza/fake-gcs-server:latest \
  -scheme http -port 4443 -backend filesystem -filesystem-root /storage >/dev/null

# Wait for the emulator to answer.
for _ in $(seq 1 30); do
  if curl -fsS "http://localhost:${GCS_PORT}/storage/v1/b" >/dev/null 2>&1; then break; fi
  sleep 1
done
curl -fsS -X POST "http://localhost:${GCS_PORT}/storage/v1/b" \
  -H 'Content-Type: application/json' -d "{\"name\":\"${BUCKET}\"}" >/dev/null

# The path-rewriting proxy, on all interfaces, because the measured container
# reaches it through `host.containers.internal`.
# Somewhere findable: when a run fails, the proxy's own error is what says
# whether the harness or the code under test gave way.
PROXY_LOG="${BENCHMARK_PROXY_LOG:-/tmp/paralegix-signing-benchmark-proxy.log}"
: > "$PROXY_LOG"
npx tsx scripts/gcs-path-proxy.ts --listen "$PROXY_PORT" --upstream "$GCS_PORT" >/dev/null 2>>"$PROXY_LOG" &
PROXY_PID=$!
for _ in $(seq 1 30); do
  if curl -fsS "http://localhost:${PROXY_PORT}/b" >/dev/null 2>&1; then break; fi
  sleep 1
done

podman build --target build -t "$IMAGE" . >/dev/null

for SIZE in "${SIZES[@]}"; do
  ID="bench-${SIZE}mb"
  PREPARED="$(STORAGE_EMULATOR_HOST="http://localhost:${PROXY_PORT}" \
    FIREBASE_SERVICE_ACCOUNT_KEY="$SERVICE_ACCOUNT" GCS_BUCKET="$BUCKET" \
    npx tsx scripts/benchmark-signing.ts --prepare --size-mb "$SIZE" --id "$ID")"
  GENERATION="$(printf '%s' "$PREPARED" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const l=s.trim().split("\n").pop();process.stdout.write(JSON.parse(l).generation)})')"

  set +e
  podman run --rm \
    --memory=512m --memory-swap=512m \
    -e STORAGE_EMULATOR_HOST="http://host.containers.internal:${PROXY_PORT}" \
    -e FIREBASE_SERVICE_ACCOUNT_KEY="$SERVICE_ACCOUNT" \
    -e GCS_BUCKET="$BUCKET" \
    -e SIGNING_BENCHMARK_ID="$ID" \
    -e SIGNING_BENCHMARK_GENERATION="$GENERATION" \
    -e SIGNING_BENCHMARK_CONCURRENCY="${BENCHMARK_CONCURRENCY:-1}" \
    "$IMAGE" npx tsx scripts/benchmark-signing.ts --run --size-mb "$SIZE"
  CODE=$?
  set -e
  echo "EXIT size_mb=${SIZE} code=${CODE}"
done
