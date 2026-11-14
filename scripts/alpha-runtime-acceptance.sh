#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$ROOT"
: "${DOCKER_HOST:?set DOCKER_HOST to the supported local Docker socket}"
STAMP=$(date +%Y%m%d-%H%M%S)
PROJECT="a11y-alpha-runtime-${STAMP}-$$"
RUN_DIR=${A11Y_ALPHA_ACCEPTANCE_DIR:-"${TMPDIR:-/tmp}/${PROJECT}"}
ENV_FILE="$RUN_DIR/.env.alpha"
API_PORT=${ALPHA_API_HOST_PORT:-}
WEB_PORT=${ALPHA_WEB_HOST_PORT:-}
VALIDATOR_IMAGE="${PROJECT}-pdf-validator"
APP_IMAGE="${PROJECT}-app"
mkdir -p "$RUN_DIR"
chmod 700 "$RUN_DIR"

free_port() {
  node -e "const n=require('net').createServer();n.listen(0,'127.0.0.1',()=>{console.log(n.address().port);n.close()})"
}
[ -n "$API_PORT" ] || API_PORT=$(free_port)
[ -n "$WEB_PORT" ] || WEB_PORT=$(free_port)
if [ "$API_PORT" = "$WEB_PORT" ]; then WEB_PORT=$(free_port); fi
export ALPHA_API_HOST_PORT="$API_PORT" ALPHA_WEB_HOST_PORT="$WEB_PORT" ALPHA_APP_IMAGE="$APP_IMAGE"

compose() {
  docker compose --env-file "$ENV_FILE" -p "$PROJECT" -f docker-compose.alpha.yml -f scripts/alpha-runtime-acceptance.override.yml "$@"
}

cleanup() {
  local code=$? cleanup_failed=0
  compose logs --no-color >"$RUN_DIR/compose.log" 2>&1 || true
  if ! compose down -v --remove-orphans >"$RUN_DIR/down.log" 2>&1; then cleanup_failed=1; fi
  # Keep locally cached images. The acceptance cleanup contract covers the
  # uniquely labelled containers, networks, and volumes created by this run.
  {
    docker ps -aq --filter "label=com.docker.compose.project=$PROJECT"
    docker network ls -q --filter "label=com.docker.compose.project=$PROJECT"
    docker volume ls -q --filter "label=com.docker.compose.project=$PROJECT"
  } >"$RUN_DIR/leftovers.txt"
  rm -f "$ENV_FILE"
  if [ -s "$RUN_DIR/leftovers.txt" ]; then cleanup_failed=1; fi
  printf '{"project":"%s","apiPort":%s,"webPort":%s,"commandExit":%s,"cleanupExit":%s}\n' \
    "$PROJECT" "$API_PORT" "$WEB_PORT" "$code" "$cleanup_failed" >"$RUN_DIR/run-summary.json"
  if [ "$code" -ne 0 ] || [ "$cleanup_failed" -ne 0 ]; then
    echo "alpha runtime acceptance failed; evidence retained at $RUN_DIR" >&2
    exit 1
  fi
  echo "alpha runtime acceptance passed; evidence retained at $RUN_DIR"
}
trap cleanup EXIT

node scripts/create-alpha-env.mjs "$ENV_FILE" >"$RUN_DIR/env-generation.log"
printf 'project=%s\napi_port=%s\nweb_port=%s\n' "$PROJECT" "$API_PORT" "$WEB_PORT" >"$RUN_DIR/runtime.txt"

# Rendered topology is evidence, but generated credentials are not.
compose config --format json | node -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const x=JSON.parse(s);for(const v of Object.values(x.services||{})){if(v.environment){for(const k of Object.keys(v.environment)){if(/PASSWORD|TOKEN|DATABASE_URL/i.test(k))v.environment[k]="[REDACTED]"}}}process.stdout.write(JSON.stringify(x,null,2)+"\n")})
' >"$RUN_DIR/compose-config.redacted.json"

docker build -t "$VALIDATOR_IMAGE" -f infra/alpha-acceptance/Dockerfile infra/alpha-acceptance >"$RUN_DIR/validator-build.log" 2>&1
docker build -t "$APP_IMAGE" -f infra/alpha/Dockerfile . >"$RUN_DIR/app-build.log" 2>&1
compose build pdf-renderer browser smokescreen >"$RUN_DIR/sidecar-build.log" 2>&1
compose up -d --no-build --wait >"$RUN_DIR/compose-up.log" 2>&1

node - "$API_PORT" "$WEB_PORT" <<'NODE' >"$RUN_DIR/http-reachability.json"
const [apiPort, webPort] = process.argv.slice(2);
async function wait(url) {
  let last;
  for (let i = 0; i < 90; i++) {
    try { const r = await fetch(url); const body = Buffer.from(await r.arrayBuffer()); if (r.ok) return { url, status: r.status, bytes: body.length }; last = `HTTP ${r.status}`; }
    catch (e) { last = e.message; }
    await new Promise(r => setTimeout(r, 1000));
  }
  throw new Error(`${url} not ready: ${last}`);
}
console.log(JSON.stringify({ api: await wait(`http://127.0.0.1:${apiPort}/healthz`), web: await wait(`http://127.0.0.1:${webPort}/`) }, null, 2));
NODE

IDS=($(compose ps -q postgres redis api pdf-renderer web worker browser smokescreen))
printf '%s\n' "${IDS[@]}" >"$RUN_DIR/container-ids.txt"
docker inspect "${IDS[@]}" | node -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const a=JSON.parse(s);for(const x of a){if(x.Config?.Env)x.Config.Env=x.Config.Env.map(v=>/PASSWORD|TOKEN|DATABASE_URL/i.test(v.split("=")[0])?`${v.split("=")[0]}=[REDACTED]`:v)}process.stdout.write(JSON.stringify(a,null,2)+"\n")})
' >"$RUN_DIR/inspect.redacted.json"

node - "$RUN_DIR/inspect.redacted.json" <<'NODE' >"$RUN_DIR/topology-validation.json"
const fs = require('fs');
const all = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const byService = Object.fromEntries(all.map(x => [x.Config.Labels['com.docker.compose.service'], x]));
const fail = m => { throw new Error(m); };
const networks = s => Object.keys(byService[s].NetworkSettings.Networks).sort();
for (const service of ['postgres','redis','browser','smokescreen','pdf-renderer']) {
  if (Object.keys(byService[service].NetworkSettings.Ports || {}).some(k => (byService[service].NetworkSettings.Ports[k] || []).length)) fail(`${service} has a published port`);
}
const api = byService.api;
if (api.Config.User !== 'node' && api.Config.User !== '1000') fail(`API user is ${api.Config.User}`);
if (!api.HostConfig.ReadonlyRootfs) fail('API root is writable');
if (api.HostConfig.Privileged) fail('API is privileged');
if (!(api.HostConfig.SecurityOpt || []).includes('no-new-privileges:true')) fail('API lacks no-new-privileges');
if (!(api.HostConfig.CapDrop || []).includes('ALL')) fail('API does not drop all capabilities');
if ((api.HostConfig.CapAdd || []).length) fail(`API adds capabilities: ${api.HostConfig.CapAdd}`);
if (api.HostConfig.PidsLimit !== 256 || api.HostConfig.Memory !== 805306368 || api.HostConfig.NanoCpus !== 1000000000) fail('API resource bounds differ');
const renderer = byService['pdf-renderer'];
if (renderer.Config.User !== 'pwuser') fail(`renderer user is ${renderer.Config.User}`);
if (!renderer.HostConfig.ReadonlyRootfs || renderer.HostConfig.Privileged) fail('renderer filesystem or privilege boundary differs');
if (!(renderer.HostConfig.SecurityOpt || []).includes('no-new-privileges:true')) fail('renderer lacks no-new-privileges');
if (!(renderer.HostConfig.CapDrop || []).includes('ALL') || JSON.stringify(renderer.HostConfig.CapAdd || []) !== JSON.stringify(['CAP_SYS_CHROOT'])) fail('renderer capability boundary differs');
if (renderer.HostConfig.PidsLimit !== 512 || renderer.HostConfig.Memory !== 1073741824 || renderer.HostConfig.NanoCpus !== 2000000000 || renderer.HostConfig.IpcMode === 'host') fail('renderer resource or IPC boundary differs');
const expected = {
  api: ['app_internal','local_access','pdf_control'], web: ['app_internal','local_access'],
  worker: ['app_internal','browser_control'], browser: ['browser_control'], 'pdf-renderer': ['pdf_control']
};
for (const [service, suffixes] of Object.entries(expected)) {
  const actual = networks(service).map(n => n.replace(/^.*?_/, '')).sort();
  if (JSON.stringify(actual) !== JSON.stringify([...suffixes].sort())) fail(`${service} networks ${actual}`);
}
for (const service of ['api','web']) {
  const bindings = Object.values(byService[service].HostConfig.PortBindings || {}).flat();
  if (!bindings.length || bindings.some(b => b.HostIp !== '127.0.0.1')) fail(`${service} is not loopback-only`);
}
console.log(JSON.stringify({ uid: api.Config.User, readOnly: api.HostConfig.ReadonlyRootfs, networks: Object.fromEntries(Object.keys(expected).map(s => [s, networks(s)])), unpublished: ['postgres','redis','browser','smokescreen'] }, null, 2));
NODE

compose exec -T api id >"$RUN_DIR/api-id.txt"
test "$(compose exec -T api id -u | tr -d '\r')" = 1000

SEED=$(compose exec -T worker pnpm tsx /acceptance/alpha-runtime-seed.ts)
printf '%s\n' "$SEED" >"$RUN_DIR/seed.json"
SCAN_ID=$(node -e 'console.log(JSON.parse(process.argv[1]).scanId)' "$SEED")

curl --fail --silent --show-error --dump-header "$RUN_DIR/native-pdf.headers" \
  "http://127.0.0.1:${API_PORT}/scans/${SCAN_ID}/report?format=pdf" -o "$RUN_DIR/native-report.pdf"
node - "$RUN_DIR/native-pdf.headers" "$RUN_DIR/native-report.pdf" <<'NODE' >"$RUN_DIR/native-pdf-http.json"
const fs=require('fs'),crypto=require('crypto');const h=fs.readFileSync(process.argv[2],'utf8'),b=fs.readFileSync(process.argv[3]);
if(!/^HTTP\/\S+ 200/m.test(h)||!/^content-type: application\/pdf/im.test(h)||!/^content-disposition: attachment;.*\.pdf/im.test(h)||b.subarray(0,5).toString()!=='%PDF-'||b.length<10000)throw new Error('native PDF response validation failed');
console.log(JSON.stringify({bytes:b.length,sha256:crypto.createHash('sha256').update(b).digest('hex')},null,2));
NODE

docker run --rm --network none -v "$RUN_DIR:/work" "$VALIDATOR_IMAGE" sh -ceu \
  'pdfinfo /work/native-report.pdf > /work/pdfinfo.txt; pdftoppm -png -r 96 /work/native-report.pdf /work/native-page > /work/pdftoppm.stdout 2> /work/pdftoppm.stderr'
node - "$RUN_DIR" <<'NODE' >"$RUN_DIR/pdf-pixel-validation.json"
const fs=require('fs'),path=require('path'),sharp=require('sharp');
(async()=>{
  const dir=process.argv[2];const info=fs.readFileSync(path.join(dir,'pdfinfo.txt'),'utf8');const pages=Number(info.match(/^Pages:\s+(\d+)/m)?.[1]);
  const expectedPages=3; // Fixed acceptance fixture under the isolated Playwright renderer image.
  if(pages!==expectedPages)throw new Error(`expected exactly ${expectedPages} PDF pages, got ${pages}`);
  const files=fs.readdirSync(dir).filter(x=>/^native-page-\d+\.png$/.test(x)).sort();if(files.length!==pages)throw new Error(`raster count ${files.length} != pages ${pages}`);
  let matches=0;for(const file of files){const {data,info}=await sharp(path.join(dir,file)).removeAlpha().raw().toBuffer({resolveWithObject:true});for(let i=0;i<data.length;i+=info.channels){if(data[i]>220&&data[i+1]<45&&data[i+2]>220)matches++;}}
  if(matches<1000)throw new Error(`marker pixel count too low: ${matches}`);console.log(JSON.stringify({pages,rasters:files,markerPixels:matches},null,2));
})().catch(error=>{console.error(error);process.exitCode=1});
NODE

compose exec -d web sh -c 'node /acceptance/pdf-request-canary.mjs >/tmp/a11y-pdf-canary.log 2>&1'
for _ in {1..30}; do
  if compose exec -T web node -e "const s=require('net').connect(3999,'127.0.0.1');s.on('connect',()=>{s.end();process.exit(0)});s.on('error',()=>process.exit(1))"; then break; fi
  sleep 1
done
compose exec -T api pnpm tsx /acceptance/alpha-runtime-pdf-canary.ts >"$RUN_DIR/request-canary-result.json"
CANARY_COUNT=$(compose exec -T web cat /tmp/a11y-pdf-canary-count | tr -d '\r\n')
test "$CANARY_COUNT" = 0
printf '{"completedRequests":%s}\n' "$CANARY_COUNT" >"$RUN_DIR/request-canary-count.json"

compose logs --no-color api >"$RUN_DIR/api.log" 2>&1
compose logs --no-color pdf-renderer >"$RUN_DIR/pdf-renderer.log" 2>&1
if grep -Eiq -- '--no-sandbox|chromiumSandbox[^[:alnum:]]*false|sandbox.*(failed|disabled)' "$RUN_DIR/pdf-renderer.log"; then
  echo 'forbidden sandbox fallback or failure found in PDF renderer log' >&2
  exit 1
fi

git diff --check
printf 'PASS project=%s scan=%s api=%s web=%s evidence=%s\n' "$PROJECT" "$SCAN_ID" "$API_PORT" "$WEB_PORT" "$RUN_DIR"
