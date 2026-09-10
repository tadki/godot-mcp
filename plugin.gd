@tool
extends EditorPlugin

const WebSocketServer := preload("res://addons/godot_mcp/websocket_server.gd")
const CommandRouter := preload("res://addons/godot_mcp/command_router.gd")
const StatusPanel := preload("res://addons/godot_mcp/ui/status_panel.tscn")
const MCPDebuggerPlugin := preload("res://addons/godot_mcp/core/mcp_debugger_plugin.gd")

const GAME_BRIDGE_AUTOLOAD := "MCPGameBridge"
const GAME_BRIDGE_PATH := "res://addons/godot_mcp/game_bridge/mcp_game_bridge.gd"

const SETTING_BIND_MODE := "godot_mcp/bind_mode"
const SETTING_CUSTOM_BIND_IP := "godot_mcp/custom_bind_ip"
const SETTING_PORT_OVERRIDE_ENABLED := "godot_mcp/port_override_enabled"
const SETTING_PORT_OVERRIDE := "godot_mcp/port_override"

const LeaseController := preload("res://addons/godot_mcp/lease_controller.gd")

# SEE-1009 gate: only editors launched by the agent toolchain participate in the
# lease self-exit. start-godot-editor.sh appends this flag to the editor command
# line; a manually-opened editor has no such flag and must never self-exit, or it
# dies ~5min into manual debugging while the game window lives on.
const LEASE_FLAG := "--kol-mcp-lease"

# SEE-1134 idle gate: how long to wait for the editor filesystem to finish its
# initial scan/import before binding the WS port anyway (degrade-gracefully — if
# the scan never settles, bind late rather than hang forever; the proxy's own
# warmup timeout is the backstop). Overridable via project settings for tuning.
# SEE-1152: 120.0 -> 30.0. On a large project the gate was consuming its full
# 120s budget on every cold start (measured 114.6s on 2026-08-20) while the
# proxy was already in RECOVERING at 180s; 30s still lets a warm-import-cache
# boot settle, and on a cold cache we bind early and let the scan finish in the
# background (the addon degrades gracefully either way).
const SETTING_IDLE_GATE_TIMEOUT := "godot_mcp/idle_gate_timeout_sec"
const IDLE_GATE_TIMEOUT_SEC_DEFAULT := 30.0
const IDLE_GATE_POLL_SEC := 0.2

# SEE-1152: kill-switch for the cold-start stage timing lines (default ON).
const SETTING_STAGE_LOG_ENABLED := "godot_mcp/stage_log_enabled"

var _websocket_server: WebSocketServer
var _command_router: CommandRouter
var _status_panel: Control
var _debugger_plugin: MCPDebuggerPlugin
var _restart_timer: Timer
var _lease: LeaseController
var _lease_quit_timer: Timer

var _current_bind_address := MCPConstants.LOCALHOST_BIND_ADDRESS
var _current_bind_mode: MCPEnums.BindMode = MCPEnums.BindMode.LOCALHOST

# SEE-1134: true only during the first _do_restart_server after _enter_tree.
# The idle gate must NOT apply to manual rebinds (_on_config_applied), or a
# user-triggered filesystem scan would needlessly stall a server restart.
var _cold_start_pending := false
# Tracks the EditorFileSystem.filesystem_changed connection made while the idle
# gate is waiting, so it can be disconnected exactly once when the gate clears.
var _idle_gate_fs_connected: EditorFileSystem = null

# SEE-1152: ms-resolution stage timing on the addon's cold-start path. Emits
# one stderr line per call with [stage=<NAME>] [t=+Nms] [ts=<iso8601>] so a
# future cold start's editor-side stages can be grepped out of the editor log
# without parsing free-form messages. Default ON; silence via
# ProjectSettings godot_mcp/stage_log_enabled=false.
var _stage_log_t0_msec := 0


func _stage_log(stage_name: String, extra: String = "") -> void:
	if not bool(ProjectSettings.get_setting(SETTING_STAGE_LOG_ENABLED, true)):
		return
	if _stage_log_t0_msec == 0:
		_stage_log_t0_msec = Time.get_ticks_msec()
	var rel := Time.get_ticks_msec() - _stage_log_t0_msec
	var iso := Time.get_datetime_string_from_system(true, true)
	var suffix := (" " + extra) if extra != "" else ""
	MCPLog.info("[stage=%s] [t=+%dms] [ts=%s]%s" % [stage_name, rel, iso, suffix])


func _enter_tree() -> void:
	_command_router = CommandRouter.new()
	_command_router.setup(self)

	_websocket_server = WebSocketServer.new()
	_websocket_server.command_received.connect(_on_command_received)
	_websocket_server.client_connected.connect(_on_client_connected)
	_websocket_server.client_disconnected.connect(_on_client_disconnected)
	add_child(_websocket_server)

	_status_panel = StatusPanel.instantiate()
	add_control_to_bottom_panel(_status_panel, "MCP")

	_debugger_plugin = MCPDebuggerPlugin.new()
	add_debugger_plugin(_debugger_plugin)

	_restart_timer = Timer.new()
	_restart_timer.one_shot = true
	_restart_timer.timeout.connect(_do_restart_server)
	add_child(_restart_timer)

	_ensure_game_bridge_autoload()
	_ensure_bind_settings()
	_setup_bind_ui()
	_setup_version_display()
	_cold_start_pending = true  # SEE-1134: arm the idle gate for the first bind.
	_apply_bind_settings(true)
	_setup_lease()
	MCPLog.info("Plugin initialized")


func _exit_tree() -> void:
	if _lease_quit_timer:
		_lease_quit_timer.stop()
		_lease_quit_timer.queue_free()
		_lease_quit_timer = null
	_lease = null

	if _restart_timer:
		_restart_timer.stop()
		_restart_timer.queue_free()

	if _status_panel:
		remove_control_from_bottom_panel(_status_panel)
		_status_panel.queue_free()

	if _websocket_server:
		_websocket_server.stop_server()
		_websocket_server.queue_free()

	if _debugger_plugin:
		remove_debugger_plugin(_debugger_plugin)
		_debugger_plugin = null

	if _command_router:
		_command_router = null  # RefCounted - freed automatically

	MCPLog.info("Plugin disabled")


func _ensure_bind_settings() -> void:
	if not ProjectSettings.has_setting(SETTING_BIND_MODE):
		ProjectSettings.set_setting(SETTING_BIND_MODE, MCPEnums.BindMode.LOCALHOST)
	if not ProjectSettings.has_setting(SETTING_CUSTOM_BIND_IP):
		ProjectSettings.set_setting(SETTING_CUSTOM_BIND_IP, "")
	if not ProjectSettings.has_setting(SETTING_PORT_OVERRIDE_ENABLED):
		ProjectSettings.set_setting(SETTING_PORT_OVERRIDE_ENABLED, false)
	if not ProjectSettings.has_setting(SETTING_PORT_OVERRIDE):
		ProjectSettings.set_setting(SETTING_PORT_OVERRIDE, WebSocketServer.DEFAULT_PORT)
	if not ProjectSettings.has_setting(SETTING_IDLE_GATE_TIMEOUT):
		ProjectSettings.set_setting(SETTING_IDLE_GATE_TIMEOUT, IDLE_GATE_TIMEOUT_SEC_DEFAULT)
	# SEE-1117: NO ProjectSettings.save() here. This was the P0 root cause —
	# every plugin load persisted project.godot, and Godot's serializer dropped
	# the in-section `#` comment sentinels the Phase 1 marker scheme relied on,
	# destroying the marker so port_override_enabled fell back to false and the
	# addon listened on 6550 instead of the per-agent port. These set_setting
	# calls populate the in-memory defaults the getters read; they do NOT need
	# to persist (the per-agent port now comes from the sidecar lease — see
	# _get_listen_port / _load_lease_sidecar). The only legitimate persistence
	# path is _on_config_applied (manual UI save), which still calls save().


func _setup_bind_ui() -> void:
	if not _status_panel:
		return
	if _status_panel.has_method("set_config"):
		_status_panel.set_config(
			_get_bind_mode(),
			_get_custom_bind_ip(),
			_get_port_override_enabled(),
			_get_port_override()
		)
	if (
		_status_panel.has_signal("config_applied")
		and not _status_panel.config_applied.is_connected(_on_config_applied)
	):
		_status_panel.config_applied.connect(_on_config_applied)


func _get_bind_mode() -> MCPEnums.BindMode:
	return (
		ProjectSettings.get_setting(SETTING_BIND_MODE, MCPEnums.BindMode.LOCALHOST)
		as MCPEnums.BindMode
	)


func _get_custom_bind_ip() -> String:
	return str(ProjectSettings.get_setting(SETTING_CUSTOM_BIND_IP, ""))


func _get_port_override_enabled() -> bool:
	return bool(ProjectSettings.get_setting(SETTING_PORT_OVERRIDE_ENABLED, false))


func _get_port_override() -> int:
	var raw_value := ProjectSettings.get_setting(
		SETTING_PORT_OVERRIDE, WebSocketServer.DEFAULT_PORT
	)
	var port := int(raw_value)
	if port < MCPConstants.PORT_MIN or port > MCPConstants.PORT_MAX:
		MCPLog.warn(
			(
				"Invalid port override '%s'; falling back to default port %d"
				% [str(raw_value), WebSocketServer.DEFAULT_PORT]
			)
		)
		return WebSocketServer.DEFAULT_PORT
	return port


func _get_listen_port() -> int:
	# SEE-1117 Direction 3: port resolution priority (highest first):
	#   1. sidecar lease (state=active) — per-worktree authoritative source
	#   2. KOL_MCP_PORT env var — launch-time channel from the launcher
	#   3. legacy ProjectSettings override — manual UI save (priority 3 only)
	#   4. default 6550
	# The sidecar is the SSOT: even if project.godot still carries a stale
	# port_override_enabled=false, an active sidecar wins. project.godot no
	# longer carries lease state (addon never writes it — see
	# _ensure_bind_settings).
	var lease := _load_lease_sidecar()
	if not lease.is_empty() and str(lease.get("state", "")) == "active":
		var lease_port := int(lease.get("port", 0))
		if lease_port >= MCPConstants.PORT_MIN and lease_port <= MCPConstants.PORT_MAX:
			return lease_port
		MCPLog.warn(
			"sidecar lease state=active but port %d is out of range; falling through" % lease_port
		)

	# §4.5.3 T2 / K5: canonical port env is GODOT_MCP_PORT; KOL_MCP_PORT is kept
	# as a backward-compat of the same value, read FIRST so pre-T2 launchers that
	# still export it keep working unmodified (alias precedence: KOL wins).
	var env_port_str := OS.get_environment("KOL_MCP_PORT")
	if env_port_str.is_empty():
		env_port_str = OS.get_environment("GODOT_MCP_PORT")
	if not env_port_str.is_empty():
		var env_port := int(env_port_str)
		if env_port >= MCPConstants.PORT_MIN and env_port <= MCPConstants.PORT_MAX:
			return env_port
		MCPLog.warn(
			(
				"%s='%s' is not a valid port; falling through"
				% ["KOL_MCP_PORT/GODOT_MCP_PORT", env_port_str]
			)
		)

	if _get_port_override_enabled():
		return _get_port_override()

	return WebSocketServer.DEFAULT_PORT


# SEE-1117: load the per-worktree MCP lease sidecar at
# <project_dir>/.godot/mcp-lease.json. Returns {} when the file is absent,
# unreadable, malformed, or belongs to a different worktree (defensive — the
# file should never move between worktrees, but a stale copy under a relocated
# project dir is ignored rather than honored). Never logs an error for the
# common "no lease yet" case; only warns on malformed / cross-worktree files.
func _load_lease_sidecar() -> Dictionary:
	var project_dir := ProjectSettings.globalize_path("res://")
	var sidecar_path := project_dir.path_join(".godot/mcp-lease.json")
	if not FileAccess.file_exists(sidecar_path):
		return {}
	var f := FileAccess.open(sidecar_path, FileAccess.READ)
	if f == null:
		return {}
	var text := f.get_as_text()
	f.close()
	var parsed: Variant = JSON.parse_string(text)
	if typeof(parsed) != TYPE_DICTIONARY:
		MCPLog.warn("mcp-lease.json malformed (not a JSON object); ignoring: %s" % sidecar_path)
		return {}
	var parsed_dict := parsed as Dictionary
	# Sanity (R1/R2): only honor a sidecar written for THIS worktree. An empty
	# worktree field (older / hand-written file) is tolerated; a mismatched one
	# is ignored so a relocated or copied project dir never binds a stale port.
	#
	# SEE-1117 Suite B defect 1: paths are NORMALIZED before comparison. The
	# shell writes `worktree` as a Linux path (`/home/...`), but on a WSL +
	# Windows-Godot link this addon's `globalize_path("res://")` returns a UNC
	# form (`//wsl.localhost/<distro>/home/.../`). A raw `!=` is always false,
	# so the sidecar is ignored and the editor falls back to 6550. Normalization
	# strips trailing separators and collapses the `//wsl.localhost/<distro>`
	# UNC prefix back to `/` so both forms compare equal. (The sidecar's LOCATION
	# under res://.godot/ already scopes it to this worktree; the field is only
	# a defensive hint — see Archi doc R1/R2.)
	var sidecar_worktree := _normalize_worktree_path(str(parsed_dict.get("worktree", "")))
	if (
		not sidecar_worktree.is_empty()
		and sidecar_worktree != _normalize_worktree_path(project_dir)
	):
		MCPLog.warn(
			(
				"mcp-lease.json belongs to a different worktree (%s != %s); ignoring."
				% [sidecar_worktree, _normalize_worktree_path(project_dir)]
			)
		)
		return {}
	return parsed_dict


# SEE-1117 Suite B defect 1: normalize a worktree path string so a Linux path
# and its WSL UNC form compare equal. Trims trailing separators; if the path
# starts with `//wsl.localhost/<distro>/` (Windows Godot view of a WSL path),
# that prefix is replaced with `/`. Empty input stays empty. Returns the
# normalized path.
func _normalize_worktree_path(p: String) -> String:
	var s := p.strip_edges()
	if s.is_empty():
		return s
	# Collapse backslashes to forward slashes (defensive; Windows Godot may
	# emit mixed separators), then strip a single trailing separator.
	s = s.replace("\\", "/")
	if s.ends_with("/") and s.length() > 1:
		s = s.substr(0, s.length() - 1)
	# UNC WSL form: `//wsl.localhost/<distro>/...` -> `/...`
	if s.begins_with("//wsl.localhost/"):
		var rest := s.substr("//wsl.localhost/".length())
		var slash := rest.find("/")
		if slash >= 0:
			s = rest.substr(slash)
		else:
			s = "/"
	return s


func _resolve_bind_address() -> String:
	match _get_bind_mode():
		MCPEnums.BindMode.WSL:
			var ip := _get_wsl_vethernet_ipv4()
			if ip.is_empty():
				(
					MCPLog
					. warn(
						(
							"WSL bind mode selected but vEthernet (WSL) IPv4 was not found; falling back to %s"
							% MCPConstants.LOCALHOST_BIND_ADDRESS
						)
					)
				)
				return MCPConstants.LOCALHOST_BIND_ADDRESS
			return ip
		MCPEnums.BindMode.CUSTOM:
			var ip := _get_custom_bind_ip().strip_edges()
			if ip.is_empty():
				MCPLog.warn(
					(
						"Custom bind mode selected but no IP was configured; falling back to %s"
						% MCPConstants.LOCALHOST_BIND_ADDRESS
					)
				)
				return MCPConstants.LOCALHOST_BIND_ADDRESS
			if not _is_valid_ipv4(ip):
				(
					MCPLog
					. warn(
						(
							"Custom bind mode selected but IP '%s' is not a valid IPv4 address; falling back to %s"
							% [ip, MCPConstants.LOCALHOST_BIND_ADDRESS]
						)
					)
				)
				return MCPConstants.LOCALHOST_BIND_ADDRESS
			return ip
		_:
			return MCPConstants.LOCALHOST_BIND_ADDRESS


func _is_valid_ipv4(ip: String) -> bool:
	var s := ip.strip_edges()
	if s.is_empty():
		return false
	var parts := s.split(".")
	if parts.size() != 4:
		return false
	for p in parts:
		if p.is_empty() or not p.is_valid_int():
			return false
		var n := int(p)
		if n < 0 or n > 255:
			return false
	return true


func _is_valid_bind_address(ip: String) -> bool:
	if ip == "0.0.0.0" or ip == "127.0.0.1" or ip == "::" or ip == "::1":
		return true

	var local_ips := IP.get_local_addresses()
	return ip in local_ips


func _get_wsl_vethernet_ipv4() -> String:
	# Autodetect "vEthernet (WSL)" IPv4 via PowerShell (Windows only).
	if OS.get_name() != "Windows":
		return ""

	var output := []
	# Use ErrorAction Stop + catch so failures return an empty string and don't emit noisy errors.
	# Match any adapter alias that contains "WSL" to be resilient to name variations.
	# Note: The wildcard pattern 'vEthernet*WSL*' provides flexibility but may match
	# unexpected adapters in custom network configurations. Document expected adapter names.
	# SECURITY NOTE: Keep this PowerShell command as fixed string literals only. Do NOT
	# concatenate user input, project settings, environment variables, or any other external
	# data into it, as that could introduce command injection vulnerabilities. If dynamic
	# behavior is needed, implement strict validation and avoid direct string interpolation.
	# The split below is fixed-literal concatenation (no external data) to satisfy line length.
	var cmd := (
		"try { $ip = (Get-NetIPAddress -AddressFamily IPv4 -ErrorAction Stop "
		+ "| Where-Object { $_.InterfaceAlias -like 'vEthernet*WSL*' } "
		+ "| Select-Object -First 1 -ExpandProperty IPAddress); "
		+ "if ($ip) { $ip } else { '' } } catch { '' }"
	)
	var args := ["-NoProfile", "-Command", cmd]
	var code := OS.execute("powershell", args, output, false)
	if code != 0 or output.is_empty():
		return ""

	var text := String(output[0]).replace("\r", "")
	for line in text.split("\n"):
		var candidate := String(line).strip_edges()
		if _is_valid_ipv4(candidate):
			return candidate
	return ""


func _restart_server() -> void:
	# Debounce: stop any pending restart and schedule a new one
	if _websocket_server:
		_websocket_server.stop_server()
	_restart_timer.start(0.1)


func _do_restart_server() -> void:
	if not is_inside_tree() or not _websocket_server:
		return

	var bind := _resolve_bind_address()

	# Verify IP is local
	if not _is_valid_bind_address(bind):
		MCPLog.error(
			"IP '%s' is not assigned to any local network interface. Aborting bind." % bind
		)
		MCPLog.warn("Please check your IP configuration and local network interfaces.")
		_update_status("Error: IP %s not found on this machine" % bind)
		return

	# SEE-1134 cold-start idle gate: do NOT bind the WS port until the editor
	# filesystem has finished its initial scan/import. The proxy declares "warm"
	# the instant it sees the port listening; if we bind while resources are
	# still importing, runtime tools (step/digest) hit a main thread choked by
	# import work and time out. Gate only on cold start — manual rebinds from
	# _on_config_applied must not stall on a user-triggered scan.
	if _cold_start_pending:
		_cold_start_pending = false
		_stage_log(
			"IDLE_GATE_BEGIN",
			(
				"timeout_sec=%.0f"
				% float(
					ProjectSettings.get_setting(
						SETTING_IDLE_GATE_TIMEOUT, IDLE_GATE_TIMEOUT_SEC_DEFAULT
					)
				)
			)
		)
		var idle_gate_t0 := Time.get_ticks_msec()
		await _await_editor_idle()
		_stage_log("IDLE_GATE_END", "dt_ms=%d" % (Time.get_ticks_msec() - idle_gate_t0))

	var port := _get_listen_port()
	_current_bind_address = bind
	_current_bind_mode = _get_bind_mode()
	var mode_name := MCPEnums.get_mode_name(_current_bind_mode)

	_stage_log("WS_BIND_ATTEMPT", "port=%d bind=%s" % [port, bind])
	var err := _websocket_server.start_server(port, bind)
	if err != OK:
		_update_status("Failed to bind %s:%d (%s)" % [bind, port, error_string(err)])
		_stage_log("WS_BIND_FAIL", "err=%s" % error_string(err))
		return

	_update_status("Waiting for connection... (bind %s:%d [%s])" % [bind, port, mode_name])
	_stage_log("WS_BIND_OK", "port=%d bind=%s" % [port, bind])
	MCPLog.info("Server listening on %s:%d [%s]" % [bind, port, mode_name])


func _apply_bind_settings(restart: bool) -> void:
	_current_bind_address = _resolve_bind_address()
	_current_bind_mode = _get_bind_mode()
	if restart:
		_restart_server()
	else:
		_update_status(
			(
				"Waiting for connection... (bind %s:%d [%s])"
				% [
					_current_bind_address,
					_get_listen_port(),
					MCPEnums.get_mode_name(_current_bind_mode)
				]
			)
		)


# SEE-1134: wait for EditorFileSystem to be idle (not scanning, not importing)
# before returning. Polls on a short timer so the engine keeps getting idle
# frames to actually do the import work (a busy-loop would freeze the editor and
# starve the very scan we're waiting on). Also reacts to filesystem_changed so
# we resume promptly when the scan completes, instead of waiting up to the next
# poll tick. Bounds the wait by the idle-gate timeout so a stuck scan degrades
# gracefully (bind late) rather than hanging forever — the proxy's warmup
# timeout remains the backstop. Never throws if EditorInterface is unavailable.
func _await_editor_idle() -> void:
	var fs: EditorFileSystem = null
	if Engine.is_editor_hint():
		fs = EditorInterface.get_resource_filesystem()
	if fs == null:
		return  # Headless / non-editor build: nothing to wait on, bind immediately.

	var timeout_sec := float(
		ProjectSettings.get_setting(SETTING_IDLE_GATE_TIMEOUT, IDLE_GATE_TIMEOUT_SEC_DEFAULT)
	)
	if timeout_sec <= 0.0:
		return  # Explicitly disabled via setting.

	var started_msec := Time.get_ticks_msec()
	var logged_waiting := false
	# Hook filesystem_changed so we re-check the moment the scan signals done,
	# not just on the next poll interval. Tracked for exact-once disconnect.
	_connect_fs_changed(fs, true)

	while _fs_is_busy(fs):
		if not logged_waiting:
			(
				MCPLog
				. info(
					"SEE-1134 idle gate: waiting for editor scan/import to settle before binding WS port."
				)
			)
			_update_status("Waiting for editor to finish importing resources...")
			logged_waiting = true
		var elapsed := float(Time.get_ticks_msec() - started_msec) / 1000.0
		if elapsed >= timeout_sec:
			MCPLog.warn("SEE-1134 idle gate: still busy after %.0fs; binding anyway." % timeout_sec)
			break
		await get_tree().create_timer(IDLE_GATE_POLL_SEC).timeout

	_connect_fs_changed(fs, false)
	if logged_waiting:
		var waited := float(Time.get_ticks_msec() - started_msec) / 1000.0
		MCPLog.info("SEE-1134 idle gate cleared after %.1fs; binding WS port." % waited)


# SEE-1134: the editor filesystem is "busy" (i.e. not safe to bind yet) while
# either a scan or an import pass is in flight. Extracted to a helper so the
# busy predicate is unit-testable without a live EditorInterface. Untyped arg
# so a mock object duck-typing is_scanning()/is_importing() is accepted.
# NOTE: Godot 4.6 EditorFileSystem has is_scanning() but NOT is_importing()
# (the method was removed); is_scanning() stays true through the import pass
# that follows a scan, so on 4.6 it alone covers the window. has_method guards
# the import check so engines that still expose it (or future re-additions)
# contribute, while 4.6 does not throw a nonexistent-method script error.
static func _fs_is_busy(fs) -> bool:
	return fs.is_scanning() or (fs.has_method("is_importing") and fs.is_importing())


func _connect_fs_changed(fs: EditorFileSystem, enable: bool) -> void:
	if enable:
		if (
			_idle_gate_fs_connected == null
			and not fs.filesystem_changed.is_connected(_on_fs_changed_during_gate)
		):
			fs.filesystem_changed.connect(_on_fs_changed_during_gate)
			_idle_gate_fs_connected = fs
	else:
		if (
			_idle_gate_fs_connected != null
			and _idle_gate_fs_connected.filesystem_changed.is_connected(_on_fs_changed_during_gate)
		):
			_idle_gate_fs_connected.filesystem_changed.disconnect(_on_fs_changed_during_gate)
		_idle_gate_fs_connected = null


# No-op signal handler: the await loop re-checks is_scanning()/is_importing() on
# the next iteration regardless. The connection exists only to wake the await
# promptly when the scan completes (filesystem_changed fires on the main thread,
# unblocking the timer-based await). Kept empty intentionally.
func _on_fs_changed_during_gate() -> void:
	pass


func _on_config_applied(config: Dictionary) -> void:
	ProjectSettings.set_setting(
		SETTING_BIND_MODE, config.get("bind_mode", MCPEnums.BindMode.LOCALHOST)
	)
	ProjectSettings.set_setting(SETTING_CUSTOM_BIND_IP, str(config.get("custom_ip", "")))
	ProjectSettings.set_setting(
		SETTING_PORT_OVERRIDE_ENABLED, bool(config.get("port_override_enabled", false))
	)
	ProjectSettings.set_setting(
		SETTING_PORT_OVERRIDE, int(config.get("port_override", WebSocketServer.DEFAULT_PORT))
	)
	# SEE-1117: this is the ONLY path that persists godot_mcp settings to
	# project.godot. It is a manual save from the MCP status panel, so writing
	# the file is correct and expected here (unlike _ensure_bind_settings, which
	# must NOT save). Note this persists port_override_enabled/port_override to
	# project.godot but does NOT influence the active lease: the per-agent port
	# comes from the sidecar (state=active wins — see _get_listen_port priority
	# 1). This manual override only takes effect when no active sidecar lease
	# and no KOL_MCP_PORT env are present (priority 3).
	ProjectSettings.save()
	_apply_bind_settings(true)


func _ensure_game_bridge_autoload() -> void:
	if not ProjectSettings.has_setting("autoload/" + GAME_BRIDGE_AUTOLOAD):
		# SEE-1117 Suite B defect 2: we intentionally do NOT auto-add the
		# autoload here. Calling ProjectSettings.save() to persist a newly-added
		# autoload would serialize EVERY in-memory setting — including the
		# transient port_override_enabled/port_override defaults populated by
		# _ensure_bind_settings — back into project.godot, resurrecting the
		# Phase 1 marker shape (no BEGIN/END sentinels) we removed. save()
		# cannot be scoped to one key, so the safe path is to warn and let a
		# human add the autoload line manually. The bridge is expected to be
		# present in a correctly-configured project (see project.godot [autoload]).
		var msg := (
			"MCPGameBridge autoload is missing from project.godot. Add it manually to [autoload] "
			+ '(e.g. MCPGameBridge="*%s"); godot-mcp will not auto-persist it.' % GAME_BRIDGE_PATH
		)
		MCPLog.warn(msg)


func get_debugger_plugin() -> MCPDebuggerPlugin:
	return _debugger_plugin


func _on_command_received(id: String, command: String, params: Dictionary) -> void:
	var response = await _command_router.handle_command(command, params)
	response["id"] = id
	_websocket_server.send_response(response)


func _on_client_connected() -> void:
	if _lease:
		_apply_lease_decision(_lease.on_client_connected())
	var host_info := ""
	if _websocket_server.get_connected_host():
		host_info = (
			" from %s:%d"
			% [_websocket_server.get_connected_host(), _websocket_server.get_connected_port()]
		)
	var bind_info := (
		"(%s: %s:%d)"
		% [MCPEnums.get_mode_name(_current_bind_mode), _current_bind_address, _get_listen_port()]
	)
	_update_status("Connected%s %s" % [host_info, bind_info])
	MCPLog.info("Client connected%s %s" % [host_info, bind_info])


func _on_client_disconnected() -> void:
	if _lease:
		_apply_lease_decision(_lease.on_client_disconnected())
	_update_status("Disconnected")
	if _status_panel and _status_panel.has_method("clear_server_version"):
		_status_panel.clear_server_version()
	MCPLog.info("Client disconnected")


func _update_status(status: String) -> void:
	if _status_panel and _status_panel.has_method("set_status"):
		_status_panel.set_status(status)


func _setup_version_display() -> void:
	if _status_panel and _status_panel.has_method("set_addon_version"):
		_status_panel.set_addon_version(_get_addon_version())


func _setup_lease() -> void:
	# Event-driven lease (SEE-1009): the editor self-exits when no MCP client
	# has been connected for the grace window. See lease_controller.gd.
	if not LEASE_FLAG in OS.get_cmdline_args():
		MCPLog.info(
			(
				"Lease disabled: editor launched without %s; manual launch will not self-exit."
				% LEASE_FLAG
			)
		)
		return
	_lease = LeaseController.new()
	_lease_quit_timer = Timer.new()
	_lease_quit_timer.one_shot = true
	_lease_quit_timer.timeout.connect(_on_lease_quit)
	add_child(_lease_quit_timer)
	_apply_lease_decision(_lease.start_initial_grace())


func _apply_lease_decision(decision: Dictionary) -> void:
	if decision.get("action", "") == "start":
		_lease_quit_timer.start(float(decision.get("delay", LeaseController.QUIT_DELAY_SEC)))
		MCPLog.info("Lease: editor self-exit scheduled in %.0fs." % float(decision["delay"]))
	elif decision.get("action", "") == "stop":
		_lease_quit_timer.stop()
		MCPLog.info("Lease: editor self-exit cancelled.")


# SEE-1134 Q2: release the WS port before an editor restart quits the process.
# EditorInterface.restart_editor() relaunches the editor in a new process, which
# rebinds the port at startup. Leaving the old listening socket bound until the
# old process actually dies can surface "address already in use" in the new one;
# stopping the listener (and dropping the stale client peer) explicitly shrinks
# that bind window to near zero.
func release_ws_server() -> void:
	if _websocket_server:
		_websocket_server.stop_server()


func _on_lease_quit() -> void:
	if _lease and _lease.consume_timeout():
		MCPLog.warn(
			"Lease: no MCP client for the grace window; exiting editor to release the port."
		)
		# SEE-1134 Q3: stop a playing game BEFORE quitting the editor, or it would
		# outlive the editor and keep running as an orphan. stop_playing_scene() is
		# a synchronous kill (the game's main loop terminates within this call), so
		# the quit below never races it. Only lease-armed editors reach here — the
		# --kol-mcp-lease gate in _setup_lease() means a user-pulled editor never
		# takes this auto-exit path (SEE-1009).
		if EditorInterface.is_playing_scene():
			EditorInterface.stop_playing_scene()
		if get_tree():
			get_tree().quit()


func _get_addon_version() -> String:
	var config := ConfigFile.new()
	var err := config.load("res://addons/godot_mcp/plugin.cfg")
	if err == OK:
		return config.get_value("plugin", "version", "")
	return ""


func on_server_version_received(version: String) -> void:
	if _status_panel and _status_panel.has_method("set_server_version"):
		_status_panel.set_server_version(version)
