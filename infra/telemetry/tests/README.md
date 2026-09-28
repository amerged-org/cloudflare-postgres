# PVC namespace regression

Exactly two cases reproduce the observed discovery/resource namespace conflict:
four PVCs with metrics produce no missing-metrics alert, and one absent capacity
series produces one alert attributed to its resource namespace. They retain the
real fifteen-minute alert delay. Fixture names are generic and contain no live
addresses, UIDs or credentials.

Prepare the selected Kubernetes rule as a bare Prometheus rule file. PyYAML
6.0.3 is a development-only parser; install it in an ignored virtual environment
if it is not available in the chosen Python runtime:

```sh
python3 -m venv .env.local.rule-test-venv
.env.local.rule-test-venv/bin/pip install PyYAML==6.0.3
.env.local.rule-test-venv/bin/python - <<'PY'
from pathlib import Path
import shutil
import yaml

output = Path('.env.local.pvc-rule-tests')
output.mkdir(mode=0o755, exist_ok=True)
objects = yaml.safe_load_all(Path('infra/telemetry/targets/platform-rules.yaml').read_text())
rules = next(obj['spec'] for obj in objects if obj['metadata']['name'] == 'pgcf-platform')
(output / 'platform.rules.yaml').write_text(yaml.safe_dump(rules, sort_keys=False))
shutil.copyfile('infra/telemetry/tests/pvc-metrics.test.yaml', output / 'pvc-metrics.test.yaml')
PY
docker run --rm --network none --read-only --cap-drop ALL \
  --security-opt no-new-privileges --platform linux/amd64 \
  --tmpfs /tmp:rw,noexec,nosuid,size=32m \
  --mount "type=bind,source=$PWD/.env.local.pvc-rule-tests,target=/rules,readonly" \
  --workdir /rules --entrypoint /bin/promtool \
  quay.io/prometheus/prometheus@sha256:b2a413d5a03ea6a76782a508d1c7947440bba3b973931a25676e278431891b01 \
  test rules pvc-metrics.test.yaml
```

The selected image is recorded in [the version lock](../versions.lock.json).
Run only this named fixture during iteration. The generated files are public
test data; never put machine configuration or environment credentials there.
These tests do not qualify other namespace-sensitive rules or missing object
discovery.
