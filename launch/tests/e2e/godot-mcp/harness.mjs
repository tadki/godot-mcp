// Test harness: tracks pass/fail counts, prints structured results, exits 1 on any failure.

class TestHarness {
  constructor() {
    this.results = [];
    this.current = null;
  }

  start(suiteName) {
    console.log(`\n========================================`);
    console.log(`SUITE: ${suiteName}`);
    console.log(`========================================`);
    this.current = { suite: suiteName, items: [] };
  }

  record(name, ok, details = "") {
    const status = ok ? "PASS" : "FAIL";
    const detail = details ? ` — ${details}` : "";
    console.log(`  [${status}] ${name}${detail}`);
    this.current.items.push({ name, ok, details });
  }

  expectEq(name, actual, expected) {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    this.record(name, ok, `got=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
    return ok;
  }

  expectTrue(name, actual, details = "") {
    const ok = !!actual;
    this.record(name, ok, details || `value=${JSON.stringify(actual)}`);
    return ok;
  }

  expectGte(name, actual, threshold, details = "") {
    const ok = typeof actual === "number" && actual >= threshold;
    this.record(name, ok, details || `value=${actual} >= ${threshold}`);
    return ok;
  }

  expectLt(name, actual, threshold, details = "") {
    const ok = typeof actual === "number" && actual < threshold;
    this.record(name, ok, details || `value=${actual} < ${threshold}`);
    return ok;
  }

  finishSuite() {
    if (!this.current) return;
    const pass = this.current.items.filter((i) => i.ok).length;
    const total = this.current.items.length;
    console.log(`  -- Suite summary: ${pass}/${total} passed --`);
    this.results.push({ ...this.current, pass, total });
    this.current = null;
  }

  summary() {
    const allPass = this.results.reduce((s, r) => s + r.pass, 0);
    const allTotal = this.results.reduce((s, r) => s + r.total, 0);
    return { pass: allPass, total: allTotal, suites: this.results };
  }

  printSummary() {
    const { pass, total } = this.summary();
    console.log(`\n========================================`);
    console.log(`TOTAL: ${pass}/${total} passed`);
    console.log(`========================================`);
  }

  exitCode() {
    const { pass, total } = this.summary();
    return pass === total ? 0 : 1;
  }
}

export const harness = new TestHarness();
