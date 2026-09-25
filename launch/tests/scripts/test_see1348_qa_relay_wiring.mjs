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

function assert(cond, msg) {
    if (!cond) {
        throw new Error(`qa relay wiring broken: ${msg}`);
    }
}
