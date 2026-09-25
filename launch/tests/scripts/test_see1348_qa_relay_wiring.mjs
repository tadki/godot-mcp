// SEE-1348 F-QA-1 rework gate: godot_qa relay-chain wiring.
//
// The QA batch proved the WORST failure mode of this stack: the server tool
// and the game-bridge dispatch both landed, but the editor-side relay leg
// (command router registration + commands/qa_commands.gd) was never written —
// every real call answered [UNKNOWN_COMMAND] while all 19 server unit tests
// stayed green, because the mocked sendCommand never crosses layers.
//
// This harness pins the WIRING, statically, at the exact seams that failed:
//   server qa.ts  ──sendCommand(name)──▶  command_router.gd registration
//                                         ──▶ commands/qa_commands.gd relay
//                                         ──▶ game_bridge dispatch arm
//                                         ──▶ mcp_qa.gd handle_*/response key
// It cannot prove runtime behavior (that is the live-editor tier's job), but
// it makes "tool exists in two layers and not the third" a red test instead
// of a silent hole.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..', '..');

const QA_ACTIONS = ['qa_assert_property', 'qa_wait_for_signal', 'qa_assert_layout', 'qa_screenshot_node'];

const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

test('qa relay chain: all four actions agree across all layers (F-QA-1)', () => {
    const serverTool = read('server/src/tools/qa.ts');
    const router = read('command_router.gd');
    const relay = read('commands/qa_commands.gd');
    const bridge = read('game_bridge/mcp_game_bridge.gd');
    const qaNode = read('game_bridge/mcp_qa.gd');

    for (const action of QA_ACTIONS) {
        // 1. server tool sends the command by name...
        assert(serverTool.includes(`'${action}'`), `server qa.ts must sendCommand('${action}')`);

        // 2. ...the addon relay registers + forwards the same name...
        assert(relay.includes(`"${action}"`), `commands/qa_commands.gd must register ${action}`);
        assert(
            relay.includes(`_relay("${action}"`),
            `commands/qa_commands.gd ${action} must forward its own msg_type (response key = command name)`
        );

        // 3. ...the bridge dispatches it to the qa node...
        assert(
            bridge.includes(`"${action}":`) && bridge.includes('_qa.handle_'),
            `mcp_game_bridge.gd must dispatch "${action}" to _qa.handle_*`
        );

        // 4. ...and the qa node answers under the SAME msg_type key.
        assert(
            qaNode.includes(`"${action}"`),
            `mcp_qa.gd must answer under "${action}" (plugin keys responses by msg_type)`
        );
    }

    // 5. The relay leg is REGISTERED on the router — the F-QA-1 root cause.
    assert(
        router.includes('_register_handler(MCPQACommands.new(), plugin)'),
        'command_router.gd must register MCPQACommands (F-QA-1 root cause was the missing registration)'
    );
    assert(relay.includes('class_name MCPQACommands'), 'qa_commands.gd must declare class_name MCPQACommands');
});

test('qa relay chain: long actions take the pushed relay budget with call_id correlation', () => {
    const relay = read('commands/qa_commands.gd');
    // exec-style correlation: late responses from a timed-out call are discarded.
    assert(relay.includes('call_id'), 'relay must correlate via call_id');
    assert(relay.includes('relay_timeout_ms'), 'relay must honor the server-pushed relay budget');
    // wait/screenshot get the long fallback; the sync asserts stay on BASE.
    assert(/qa_wait_for_signal[\s\S]*?_relay_timeout/.test(relay), 'wait_for_signal must use the pushed relay budget');
    assert(/qa_screenshot_node[\s\S]*?_relay_timeout/.test(relay), 'screenshot_node must use the pushed relay budget');
});

test('qa relay chain: bridge qa node reuses the sampler resolver + waits resolve via sampler signal', () => {
    const qaNode = read('game_bridge/mcp_qa.gd');
    const sampler = read('game_bridge/mcp_runtime_state_sampler.gd');
    assert(qaNode.includes('sampler.resolve_node'), 'qa node must reuse the sampler resolver (one path resolution)');
    assert(
        sampler.includes('signal qa_wait_finished'),
        'sampler must own the one-shot wait completion signal'
    );
    assert(
        sampler.includes('start_signal_wait'),
        'sampler must expose start_signal_wait (watch-machinery reuse, per decision §3-M3)'
    );
});

// F-QA-6: the wait timeout tick must live BEFORE the sampling early-returns in
// the sampler's _process — a wait-only session has _active=false for its whole
// life, and the old early-return starved the wall-clock accumulation until the
// relay killed the call ([TIMEOUT] instead of the documented emitted:false).
test('qa wait timeout: wall-clock tick precedes the _active early-return (F-QA-6)', () => {
    const sampler = read('game_bridge/mcp_runtime_state_sampler.gd');
    const fn = sampler.slice(sampler.indexOf('func _process('), sampler.indexOf('func collect('));
    const waitTick = fn.indexOf('_wait_elapsed_ms += delta');
    const activeReturn = fn.indexOf('if not _active:');
    assert(waitTick !== -1, 'sampler _process must tick the wait wall clock');
    assert(activeReturn !== -1, 'sampler _process keeps the sampling _active gate');
    assert(waitTick < activeReturn, 'wait tick must run BEFORE the _active early-return (F-QA-6)');
    // watch_stop resolves a pending wait too (no starved relay after teardown).
    const stop = sampler.slice(sampler.indexOf('func stop()'), sampler.indexOf('func is_active()'));
    assert(
        /_wait_active[\s\S]*?_finish_wait\(\)/.test(stop),
        'stop() must resolve a pending wait via _finish_wait (teardown path)'
    );
    // _finish_wait flips _wait_active BEFORE emitting (re-entrancy safety).
    const finish = sampler.slice(sampler.indexOf('func _finish_wait()'), sampler.indexOf('func _teardown_wait()'));
    assert(
        finish.indexOf('_wait_active = false') < finish.indexOf('qa_wait_finished.emit'),
        '_finish_wait must flip the active flag before emitting the result'
    );
});

// F-QA-8: concurrent waits are refused with the documented typed error, and
// completions funnel through a single deferred queue so a same-frame second
// wait cannot race the slot flip.
test('qa wait mutex: wait_already_pending refusal + single deferred completion funnel (F-QA-8)', () => {
    const qaNode = read('game_bridge/mcp_qa.gd');
    assert(
        qaNode.includes('wait_already_pending'),
        'second concurrent wait must be refused with the documented error'
    );
    assert(
        qaNode.includes('_finish_wait_queue') && qaNode.includes('_drain_finish_queue'),
        'completions must funnel through the deferred queue (no direct _send from the signal handler)'
    );
    const handler = qaNode.slice(
        qaNode.indexOf('func _on_wait_finished'),
        qaNode.indexOf('func _drain_finish_queue')
    );
    assert(
        !handler.includes('_send('),
        '_on_wait_finished must not _send directly — only the funnel may answer'
    );
});

function assert(cond, msg) {
    if (!cond) {
        throw new Error(`qa relay wiring broken: ${msg}`);
    }
}
