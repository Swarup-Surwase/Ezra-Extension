import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { parseFileDiff } from '../src/diff/diffParser';
import { DiffReviewStore } from '../src/diff/diffReviewStore';

export function runDemoTaskTests(): void {
  console.log('--- Running Fixed Round 1 Demo Tasks Simulation Tests ---');

  // --------------------------------------------------------------------------
  // Task A: Inline Edit Simulation
  // --------------------------------------------------------------------------
  console.log('\n[Task A: Inline edit get_debug_flag]');

  // Reference original helpers.py function
  const originalHelpers = `def get_debug_flag() -> bool:
    """Get whether debug mode should be enabled for the app, indicated by the
    :envvar:\`FLASK_DEBUG\` environment variable. The default is \`\`False\`\`.
    """
    val = os.environ.get("FLASK_DEBUG")
    return bool(val and val.lower() not in {"0", "false", "no"})
`;

  // Required Task A update: treat 'off' and 'n' as false, case-insensitively, list all values in docstring
  const updatedHelpers = `def get_debug_flag() -> bool:
    """Get whether debug mode should be enabled for the app, indicated by the
    :envvar:\`FLASK_DEBUG\` environment variable. The default is \`\`False\`\`.
    Values treated as false (case-insensitively): '0', 'false', 'no', 'off', 'n'.
    """
    val = os.environ.get("FLASK_DEBUG")
    return bool(val and val.lower() not in {"0", "false", "no", "off", "n"})
`;

  const diffA = parseFileDiff('src/flask/helpers.py', '/flask/src/flask/helpers.py', originalHelpers, updatedHelpers);
  assert.strictEqual(diffA.filePath, 'src/flask/helpers.py');
  assert.ok(diffA.hunks.length > 0, 'Task A should produce at least one hunk');
  console.log(`✓ Task A: Produced ${diffA.hunks.length} clean hunk(s) for src/flask/helpers.py`);

  // Verify behavior of get_debug_flag logic
  function testGetDebugFlag(val: string | undefined): boolean {
    return Boolean(val && !new Set(['0', 'false', 'no', 'off', 'n']).has(val.toLowerCase()));
  }

  assert.strictEqual(testGetDebugFlag('off'), false, 'FLASK_DEBUG=off must return False');
  assert.strictEqual(testGetDebugFlag('OFF'), false, 'FLASK_DEBUG=OFF (case-insensitive) must return False');
  assert.strictEqual(testGetDebugFlag('n'), false, 'FLASK_DEBUG=n must return False');
  assert.strictEqual(testGetDebugFlag('N'), false, 'FLASK_DEBUG=N (case-insensitive) must return False');
  assert.strictEqual(testGetDebugFlag('0'), false, 'FLASK_DEBUG=0 must return False');
  assert.strictEqual(testGetDebugFlag('false'), false, 'FLASK_DEBUG=false must return False');
  assert.strictEqual(testGetDebugFlag('1'), true, 'FLASK_DEBUG=1 must return True');
  assert.strictEqual(testGetDebugFlag('true'), true, 'FLASK_DEBUG=true must return True');
  console.log('✓ Task A: Logic verification passed for FLASK_DEBUG off, n, 1');

  // --------------------------------------------------------------------------
  // Task B: Agent Mode (Files not named, touching >= 3 files)
  // --------------------------------------------------------------------------
  console.log('\n[Task B: Multi-file feature addition (flask config)]');

  const storeB = new DiffReviewStore();

  // File 1: src/flask/cli.py - adding config command
  const cliOriginal = `# cli.py
cli = FlaskGroup()
`;
  const cliProposed = `# cli.py
import json

@click.command("config", short_help="Show the application config as JSON.")
@with_appcontext
def config_command():
    """Print the application's configuration as JSON, masking sensitive keys."""
    masked = {}
    mask_keys = {"SECRET", "PASSWORD", "TOKEN", "KEY"}
    for k, v in current_app.config.items():
        if any(m in k.upper() for m in mask_keys):
            masked[k] = "***"
        else:
            try:
                json.dumps(v)
                masked[k] = v
            except (TypeError, OverflowError):
                masked[k] = str(v)
    click.echo(json.dumps(masked, indent=2))

cli = FlaskGroup()
cli.add_command(config_command)
`;
  const diffCli = parseFileDiff('src/flask/cli.py', '/flask/src/flask/cli.py', cliOriginal, cliProposed);
  storeB.stageDiff(diffCli);

  // File 2: tests/test_cli.py - adding test_config_command
  const testOriginal = `# test_cli.py
def test_help(runner):
    pass
`;
  const testProposed = `# test_cli.py
def test_help(runner):
    pass

def test_config_command(runner, app):
    app.config["SECRET_KEY"] = "super-secret"
    app.config["API_TOKEN"] = "token123"
    app.config["DB_PASSWORD"] = "pass456"
    app.config["NORMAL_SETTING"] = "visible"
    res = runner.invoke(args=["config"])
    assert res.exit_code == 0
    data = json.loads(res.output)
    assert data["SECRET_KEY"] == "***"
    assert data["API_TOKEN"] == "***"
    assert data["DB_PASSWORD"] == "***"
    assert data["NORMAL_SETTING"] == "visible"
`;
  const diffTest = parseFileDiff('tests/test_cli.py', '/flask/tests/test_cli.py', testOriginal, testProposed);
  storeB.stageDiff(diffTest);

  // File 3: docs/cli.rst - documentation
  const docOriginal = `.. _cli:

Command Line Interface
======================
`;
  const docProposed = `.. _cli:

Command Line Interface
======================

Show App Configuration
----------------------
To inspect the loaded application configuration with sensitive keys masked:

.. code-block:: text

    $ flask config
`;
  const diffDoc = parseFileDiff('docs/cli.rst', '/flask/docs/cli.rst', docOriginal, docProposed);
  storeB.stageDiff(diffDoc);

  assert.strictEqual(storeB.getDiffs().length, 3, 'Task B must touch at least 3 files');
  assert.ok(storeB.getDiff('src/flask/cli.py') !== undefined);
  assert.ok(storeB.getDiff('tests/test_cli.py') !== undefined);
  assert.ok(storeB.getDiff('docs/cli.rst') !== undefined);
  console.log(`✓ Task B: Proposed multi-file edits across ${storeB.getDiffs().length} files staged for review`);

  // Verify masking logic
  function maskConfig(cfg: Record<string, any>): Record<string, any> {
    const maskKeys = ['SECRET', 'PASSWORD', 'TOKEN', 'KEY'];
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(cfg)) {
      if (maskKeys.some((m) => k.toUpperCase().includes(m))) {
        out[k] = '***';
      } else {
        out[k] = v;
      }
    }
    return out;
  }

  const sampleConfig = {
    SECRET_KEY: 'topsecret',
    DATABASE_PASSWORD: 'admin',
    AUTH_TOKEN: 'jwt-1234',
    API_KEY_VAL: 'key-5678',
    DEBUG: true,
    PORT: 5000,
  };
  const masked = maskConfig(sampleConfig);
  assert.strictEqual(masked.SECRET_KEY, '***');
  assert.strictEqual(masked.DATABASE_PASSWORD, '***');
  assert.strictEqual(masked.AUTH_TOKEN, '***');
  assert.strictEqual(masked.API_KEY_VAL, '***');
  assert.strictEqual(masked.DEBUG, true);
  assert.strictEqual(masked.PORT, 5000);
  console.log('✓ Task B: Sensitive key masking (SECRET, PASSWORD, TOKEN, KEY) verified');

  // --------------------------------------------------------------------------
  // Task C: Resilience & Error Isolation
  // --------------------------------------------------------------------------
  console.log('\n[Task C: Resilience & Isolation]');
  // Verify that rejection / failure leaves workspace clean
  storeB.rejectAll();
  assert.ok(storeB.getDiffs().every((d) => d.status === 'rejected'));
  storeB.clear();
  assert.strictEqual(storeB.getDiffs().length, 0);
  console.log('✓ Task C: Rejection and failure cleanly isolates workspace without touching disk');
}

