// NEXUS devices (the menu bar's Wi-Fi, battery and Control Center): parsers fed with real tool output, and the service
// driven by a fake runner, so no real network, radio or speaker is touched. The Wi-Fi password must never reach argv.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  nmFields, parseWifiList, parseNmDevices, parseKnown, parseVolume, parseBtShow, parseBtDevices, parsePowerProfiles,
  parseBrightness, parseRfkill, parseMedia, readBattery, checkSsid, checkWifiPassword, wifiError, createDevices, DeviceError, bluetoothAdapterPresent,
  type Runner, type RunResult,
} from "../src/devices.ts";

test("nmcli terse fields: escaped colons and backslashes", () => {
  assert.deepEqual(nmFields("*:Casa\\:5G:82:WPA2"), ["*", "Casa:5G", "82", "WPA2"]);
  assert.deepEqual(nmFields("a\\\\b:c"), ["a\\b", "c"]);
  assert.deepEqual(nmFields(" :Bar:40:--"), [" ", "Bar", "40", "--"]);
});

test("Wi-Fi list: strongest per name, hidden skipped, current and known first", () => {
  const out = [
    " :Vecino:91:WPA2", "*:Casa:70:WPA2 WPA3", " :Casa:40:WPA2", " ::55:WPA2", " :Cafetería:30:--", " :Oficina\\:2:65:WPA2", "",
  ].join("\n");
  const l = parseWifiList(out, ["Oficina:2"]);
  assert.deepEqual(l.map((n) => n.ssid), ["Casa", "Oficina:2", "Vecino", "Cafetería"]);
  assert.equal(l[0].current, true); assert.equal(l[0].signal, 70); assert.equal(l[0].bars, 3);
  assert.equal(l[1].known, true);
  const cafe = l.find((n) => n.ssid === "Cafetería")!;
  assert.equal(cafe.secure, false); assert.equal(cafe.bars, 1);
});

test("devices, saved networks, volume, bluetooth, power modes, brightness, rfkill, media", () => {
  assert.deepEqual(parseNmDevices("wlp2s0:wifi:connected:Casa\nenp0s1:ethernet:unavailable:\nlo:loopback:connected (externally):lo\n")[0],
    { device: "wlp2s0", type: "wifi", state: "connected", connection: "Casa" });
  assert.deepEqual(parseKnown("Wired connection 1:802-3-ethernet:1731000000\nCasa:802-11-wireless:1731100000\nBar:802-11-wireless:1731200000\n").map((k) => k.name), ["Bar", "Casa"]);
  assert.deepEqual(parseVolume("Volume: 0.45\n"), { volume: 45, muted: false });
  assert.deepEqual(parseVolume("Volume: 1.00 [MUTED]\n"), { volume: 100, muted: true });
  assert.equal(parseVolume("Could not connect to PipeWire\n"), null);
  assert.deepEqual(parseBtShow("Controller 00:1A:7D:DA:71:13 (public)\n\tName: nexus\n\tAlias: NEXUS de Carlos\n\tPowered: yes\n"), { powered: true, name: "NEXUS de Carlos" });
  assert.equal(parseBtShow("No default controller available\n"), null);
  assert.deepEqual(parseBtDevices("Device 11:22:33:44:55:66 AirPods de Carlos\nDevice aa:bb:cc:dd:ee:ff \n"), [{ mac: "11:22:33:44:55:66", name: "AirPods de Carlos" }, { mac: "AA:BB:CC:DD:EE:FF", name: "aa:bb:cc:dd:ee:ff" }]);
  assert.deepEqual(parsePowerProfiles("  performance:\n    CpuDriver:\tintel_pstate\n    Degraded:   no\n\n* balanced:\n    CpuDriver:\tintel_pstate\n\n  power-saver:\n    CpuDriver:\tintel_pstate\n"),
    { mode: "balanced", modes: ["performance", "balanced", "power-saver"] });
  assert.deepEqual(parseBrightness("intel_backlight,backlight,400,40%,1000\n"), { device: "intel_backlight", percent: 40 });
  assert.equal(parseBrightness(""), null);
  assert.deepEqual(parseRfkill("wlan blocked\nbluetooth blocked\n"), { radios: 2, allBlocked: true });
  assert.deepEqual(parseRfkill("wlan unblocked\nbluetooth blocked\n"), { radios: 2, allBlocked: false });
  assert.deepEqual(parseMedia("spotify\tPlaying\tFlowers\tMiley Cyrus\n"), { player: "spotify", status: "Playing", title: "Flowers", artist: "Miley Cyrus" });
  assert.equal(parseMedia("No players found\n"), null);
});

test("battery from /sys: percent, mains power, time to full and empty, health; none on a desktop", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-ps-"));
  const put = (d: string, f: Record<string, string>) => { fs.mkdirSync(path.join(root, d)); for (const [k, v] of Object.entries(f)) fs.writeFileSync(path.join(root, d, k), v + "\n"); };
  assert.equal(readBattery(root), null);
  put("AC", { type: "Mains", online: "1" });
  put("BAT0", { type: "Battery", status: "Charging", capacity: "73", energy_now: "36500000", energy_full: "50000000", energy_full_design: "56000000", power_now: "13500000", cycle_count: "212" });
  put("hidpp_battery_0", { type: "Battery", scope: "Device", capacity: "10", status: "Discharging" });   // a mouse: not the laptop
  const b = readBattery(root)!;
  assert.equal(b.percent, 73); assert.equal(b.onAc, true); assert.equal(b.minutesToFull, 60); assert.equal(b.minutesToEmpty, null);
  assert.equal(b.healthPercent, 89); assert.equal(b.cycles, 212);
  fs.writeFileSync(path.join(root, "AC", "online"), "0\n"); fs.writeFileSync(path.join(root, "BAT0", "status"), "Discharging\n");
  const d = readBattery(root)!;
  assert.equal(d.onAc, false); assert.equal(d.minutesToEmpty, 162); assert.equal(d.minutesToFull, null);
  fs.rmSync(root, { recursive: true, force: true });
});

test("inputs: SSID and WPA password rules; nmcli errors in Spanish", () => {
  assert.equal(checkSsid("Casa 5G"), "Casa 5G");
  assert.throws(() => checkSsid(""), DeviceError);
  assert.throws(() => checkSsid("x".repeat(33)), DeviceError);
  assert.throws(() => checkSsid("a\nb"), DeviceError);
  assert.throws(() => checkWifiPassword("corta"), /al menos 8/);
  assert.throws(() => checkWifiPassword("x".repeat(64)), /demasiado larga/);
  assert.equal(checkWifiPassword("f".repeat(64)), "f".repeat(64));   // a raw 64-hex key
  assert.equal(wifiError({ code: 4, out: "Password: ", err: "Error: Connection activation failed: Secrets were required, but not provided.\n" }), "la contraseña no es correcta");
  assert.equal(wifiError({ code: 10, out: "Password: ", err: "Error: No network with SSID 'Bar' found.\n" }), "esa red ya no está al alcance");
  assert.equal(wifiError({ code: 4, out: "", err: "Error: Connection activation failed: The Wi-Fi network could not be found\n" }), "esa red ya no está al alcance");
  assert.equal(wifiError({ code: 1, out: "Password: ", err: "Error: Not authorized to control networking.\n" }), "NEXUS no tiene permiso para cambiar la red");
  assert.equal(wifiError({ code: 124, out: "", err: "", timedOut: true }), "la red no ha respondido a tiempo");
});

// a fake system: each command answers from a table, and every call is recorded
function fake(table: Record<string, RunResult | ((args: string[], input?: string) => RunResult)>) {
  const calls: { cmd: string; args: string[]; input?: string }[] = [];
  const run: Runner = async (cmd, args, opts = {}) => {
    calls.push({ cmd, args, input: opts.input });
    const key = Object.keys(table).find((k) => `${cmd} ${args.join(" ")}`.startsWith(k));
    if (!key) return { code: 127, out: "", err: "missing", missing: true };
    const v = table[key];
    return typeof v === "function" ? v(args, opts.input) : v;
  };
  return { run, calls };
}
const ok = (out = ""): RunResult => ({ code: 0, out, err: "" });

test("state: a laptop on Wi-Fi with sound, bluetooth and power modes; a VM without any of it", async () => {
  const f = fake({
    "nmcli -t -f WIFI-HW,WIFI radio": ok("enabled:enabled\n"),
    "nmcli -t -f DEVICE,TYPE,STATE,CONNECTION device": ok("wlp2s0:wifi:connected:Casa\nenp3s0:ethernet:unavailable:\n"),
    "nmcli -t -f IN-USE,SSID,SIGNAL,SECURITY device wifi list --rescan no": ok("*:Casa:70:WPA2\n :Vecino:50:WPA2\n"),
    "bluetoothctl show": ok("Controller 00:1A:7D:DA:71:13 (public)\n\tPowered: yes\n"),
    "bluetoothctl devices Paired": ok("Device 11:22:33:44:55:66 AirPods\n"),
    "bluetoothctl devices Connected": ok("Device 11:22:33:44:55:66 AirPods\n"),
    "rfkill": ok("wlan unblocked\nbluetooth unblocked\n"),
    "wpctl get-volume": ok("Volume: 0.62\n"),
    "brightnessctl -m": ok("amdgpu_bl0,backlight,128,50%,255\n"),
    "powerprofilesctl list": ok("* balanced:\n\n  power-saver:\n"),
    "playerctl metadata": { code: 1, out: "", err: "No players found\n" },
  });
  const s = await createDevices({ run: f.run, sysRoot: "/nonexistent", hasBluetooth: () => true, interfaces: () => ({ lo: [], enp3s0: [] }) }).state();
  assert.equal(s.wifi.available, true); assert.equal(s.wifi.on, true); assert.equal(s.wifi.hardware, true);
  assert.equal(s.wifi.current!.ssid, "Casa"); assert.equal(s.wifi.ethernet!.connected, false);
  assert.deepEqual(s.bluetooth, { available: true, on: true, devices: [{ mac: "11:22:33:44:55:66", name: "AirPods", connected: true }] });
  assert.deepEqual(s.airplane, { available: true, on: false });
  assert.deepEqual(s.sound, { available: true, volume: 62, muted: false });
  assert.deepEqual(s.brightness, { available: true, value: 50 });
  assert.deepEqual(s.power, { available: true, mode: "balanced", modes: ["balanced", "power-saver"] });
  assert.equal(s.battery, null); assert.equal(s.media, null);

  const vm = await createDevices({ run: fake({}).run, sysRoot: "/nonexistent", interfaces: () => ({ enp0s1: [{ family: "IPv4", internal: false, address: "192.168.64.8" } as any] }) }).state();
  assert.deepEqual(vm.wifi.ethernet, { device: "enp0s1", connected: true, address: "192.168.64.8" });
  assert.equal(vm.wifi.available, false); assert.equal(vm.bluetooth.available, false); assert.equal(vm.airplane.available, false);
  assert.equal(vm.sound.available, false); assert.equal(vm.brightness.available, false); assert.equal(vm.power.available, false);

  // no Bluetooth adapter: bluetoothctl is not even asked (it waits seconds for a controller, which slowed every reading)
  const slow = fake({ "bluetoothctl show": ok("Controller 00:1A:7D:DA:71:13 (public)\n\tPowered: yes\n") });
  const nobt = await createDevices({ run: slow.run, sysRoot: "/nonexistent", hasBluetooth: () => false, interfaces: () => ({}) }).state();
  assert.equal(nobt.bluetooth.available, false);
  assert.ok(!slow.calls.some((c) => c.cmd === "bluetoothctl"));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-bt-"));
  assert.equal(bluetoothAdapterPresent(dir), false);
  fs.mkdirSync(path.join(dir, "hci0"));
  assert.equal(bluetoothAdapterPresent(dir), true);
  assert.equal(bluetoothAdapterPresent(path.join(dir, "missing")), false);
  fs.rmSync(dir, { recursive: true });
});

const wifiBase = {
  "nmcli -t -f WIFI-HW,WIFI radio": ok("enabled:enabled\n"),
  "nmcli -t -f DEVICE,TYPE,STATE,CONNECTION device": ok("wlan0:wifi:disconnected:\n"),
  "nmcli -t -f IN-USE,SSID,SIGNAL,SECURITY device wifi list ifname wlan0": ok(" :Bar:66:WPA2\n :Libre:20:--\n :Nueva:70:WPA3\n :Uni:80:WPA2 802.1X\n :Vieja:40:WEP\n :Casa:50:WPA2\n"),
  "nmcli connection delete": ok(""),
  "nmcli connection modify": ok(""),
};

test("Wi-Fi connect: the profile (password included) goes through stdin, never argv; wrong passwords fail fast and leave nothing", async () => {
  let saved = "";
  const f = fake({
    ...wifiBase,
    "nmcli -t -f NAME,TYPE,TIMESTAMP connection show": ok("Casa:802-11-wireless:1731100000\n"),
    "nmcli connection edit type wifi con-name": (_a, input) => { saved = input ?? ""; return ok(""); },
    "nmcli --wait 30 connection up id Bar ifname wlan0": () => /psk contraseña-buena\n/.test(saved) ? ok("Connection successfully activated\n")
      // an access point that just ignores a wrong password (NetworkManager's own hotspots do; seen in the lab VM 09-11)
      : /psk punto-mudo-1\n/.test(saved) ? { code: 4, out: "", err: "Error: Connection activation failed: The Wi-Fi network could not be found\n" }
      : { code: 4, out: "", err: "Error: Connection activation failed: Secrets were required, but not provided\n" },
    "nmcli --wait 30 connection up id Libre ifname wlan0": ok("ok\n"),
    "nmcli --wait 30 connection up id Nueva ifname wlan0": ok("ok\n"),
    "nmcli --wait 30 connection up id Casa ifname wlan0": ok("Connection successfully activated\n"),
  });
  const d = createDevices({ run: f.run, interfaces: () => ({}) });
  assert.deepEqual(await d.connectWifi("Bar", "contraseña-buena"), { ok: true, ssid: "Bar" });
  assert.equal(saved, "set 802-11-wireless.ssid Bar\nset 802-11-wireless-security.key-mgmt wpa-psk\nset 802-11-wireless-security.psk contraseña-buena\nset connection.autoconnect no\nsave\nquit\n");
  assert.ok(f.calls.every((c) => !c.args.join(" ").includes("contraseña")), "the password never reaches argv");
  assert.ok(f.calls.some((c) => c.args.join(" ") === "connection modify id Bar connection.autoconnect yes"), "autoconnect only after it worked");

  f.calls.length = 0;
  await assert.rejects(d.connectWifi("Bar", "contraseña-mala"), (e: DeviceError) => e.status === 401 && e.message === "la contraseña no es correcta");
  assert.ok(f.calls.some((c) => c.args.join(" ") === "connection delete id Bar"), "a wrong password leaves no profile behind");
  assert.ok(!f.calls.some((c) => c.args.includes("modify")));
  await assert.rejects(d.connectWifi("Bar", "punto-mudo-1"), (e: DeviceError) => e.status === 401 && e.message === "no se ha podido conectar: revisa la contraseña");

  // open network: no password asked; WPA3-only: SAE; a saved network comes up from its profile
  await d.connectWifi("Libre");
  assert.ok(!/key-mgmt|psk/.test(saved));
  await d.connectWifi("Nueva", "otra-clave-9");
  assert.match(saved, /key-mgmt sae\n/);
  f.calls.length = 0;
  await d.connectWifi("Casa");
  assert.ok(!f.calls.some((c) => c.args[0] === "connection" && c.args[1] === "edit"), "a saved network is not written again");

  await assert.rejects(d.connectWifi("Bar"), (e: DeviceError) => e.status === 401 && /tiene contraseña/.test(e.message));
  await assert.rejects(d.connectWifi("Uni", "12345678"), /802\.1X/);
  await assert.rejects(d.connectWifi("Vieja", "12345678"), /WEP/);
  await assert.rejects(d.connectWifi("Bar", "corta"), /al menos 8/);
  await assert.rejects(d.connectWifi("", "contraseña-buena"), /no es válido/);
});

test("switches and sliders: argv shapes, clamping, and a missing tool says what is missing", async () => {
  const f = fake({ "nmcli radio wifi": ok(), "bluetoothctl power": ok("Changing power on succeeded\n"), "rfkill": ok(), "wpctl": ok("Volume: 0.30\n"),
    "brightnessctl -q": ok(), "powerprofilesctl set": ok(), "playerctl": ok() });
  const d = createDevices({ run: f.run });
  await d.setWifi(false); await d.setBluetooth(true); await d.setAirplane(true);
  await d.setSound({ volume: 140 }); await d.setSound({ muted: true });
  assert.deepEqual(await d.setBrightness(0), { value: 3 });
  await d.setPowerMode("power-saver"); await d.mediaAction("next");
  const lines = f.calls.map((c) => `${c.cmd} ${c.args.join(" ")}`);
  for (const l of ["nmcli radio wifi off", "bluetoothctl power on", "rfkill block all", "wpctl set-volume -l 1.0 @DEFAULT_AUDIO_SINK@ 1",
    "wpctl set-mute @DEFAULT_AUDIO_SINK@ 1", "brightnessctl -q -c backlight set 3%", "powerprofilesctl set power-saver", "playerctl next"]) assert.ok(lines.includes(l), l);
  await assert.rejects(d.setPowerMode("turbo"), /no válido/);
  await assert.rejects(d.mediaAction("rm"), /no válida/);

  const none = createDevices({ run: fake({}).run });
  await assert.rejects(none.setWifi(true), (e: DeviceError) => e.status === 409 && /NetworkManager/.test(e.message));
  await assert.rejects(none.setSound({ volume: 10 }), /PipeWire/);
  await assert.rejects(none.wifiList(), /NetworkManager/);
});

test("sessiond /devices routes: state, connect with the password in the body, Spanish errors with their status", async () => {
  const { createSession } = await import("../src/sessiond.ts");
  let last = "";
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-dev-"));
  const f = fake({
    "nmcli -t -f WIFI-HW,WIFI radio": ok("enabled:enabled\n"),
    "nmcli -t -f DEVICE,TYPE,STATE,CONNECTION device": ok("wlan0:wifi:disconnected:\n"),
    "nmcli -t -f NAME,TYPE,TIMESTAMP connection show": ok(""),
    "nmcli -t -f IN-USE,SSID,SIGNAL,SECURITY device wifi list": ok(" :Bar:66:WPA2\n :Libre:20:--\n"),
    "nmcli connection edit": (_a, input) => { last = input ?? ""; return ok(""); },
    "nmcli --wait 30 connection up id Bar": () => /psk 12345678\n/.test(last) ? ok("ok\n") : { code: 4, out: "", err: "Error: Secrets were required, but not provided.\n" },
    "nmcli connection delete": ok(""), "nmcli connection modify": ok(""),
  });
  const sess = createSession({ engineUrl: "http://127.0.0.1:9", engineToken: () => "x", runtimeDir: path.join(dir, "run"), configDir: path.join(dir, "cfg"), port: 0,
    homeDir: dir, dataDir: path.join(dir, "data"), agencyTickMs: 0, devicesRun: f.run, powerSupplyDir: path.join(dir, "none"),
    spawnFn: () => ({ pid: 1, onExit: () => {} }), focusFn: async () => false, listFn: async () => [], windowPollMs: 60_000,
    fetchJson: async () => ({}), weatherEveryMs: 3_600_000, reconfigureFn: () => {}, displayFn: () => {}, updateSocket: path.join(dir, "no.sock") } as any);
  const port = await sess.start();
  const call = async (method: string, p: string, body?: unknown) => {
    const r = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers: { authorization: `Bearer ${sess.token}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, json: await r.json() as any };
  };
  try {
    const st = await call("GET", "/devices");
    assert.equal(st.status, 200); assert.equal(st.json.wifi.on, true); assert.equal(st.json.wifi.current, null); assert.equal(st.json.sound.available, false);
    const list = await call("GET", "/devices/wifi?rescan=1");
    assert.deepEqual(list.json.networks.map((n: any) => [n.ssid, n.secure]), [["Bar", true], ["Libre", false]]);
    assert.equal((await call("POST", "/devices/wifi/connect", { ssid: "Bar", password: "12345678" })).status, 200);
    const bad = await call("POST", "/devices/wifi/connect", { ssid: "Bar", password: "87654321" });
    assert.equal(bad.status, 401); assert.equal(bad.json.error, "la contraseña no es correcta");
    assert.equal((await call("POST", "/devices/power", { mode: "x" })).status, 400);
    assert.equal((await call("POST", "/devices/sound", { volume: 20 })).status, 409);
    assert.equal((await call("GET", "/devices/nada")).status, 404);
    const noAuth = await fetch(`http://127.0.0.1:${port}/devices`);
    assert.equal(noAuth.status, 401);
  } finally { await sess.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("two Wi-Fi cards, one sharing the connection as a hotspot: the computer's own card is used and named on connect", async () => {
  const f = fake({
    "nmcli -t -f WIFI-HW,WIFI radio": ok("enabled:enabled\n"),
    "nmcli -t -f DEVICE,TYPE,STATE,CONNECTION device": ok("wlan1:wifi:connected:Hotspot\nwlan0:wifi:disconnected:\n"),
    "nmcli -g 802-11-wireless.mode connection show id Hotspot": ok("ap\n"),
    "nmcli -t -f NAME,TYPE,TIMESTAMP connection show": ok("Hotspot:802-11-wireless:1\n"),
    "nmcli -t -f IN-USE,SSID,SIGNAL,SECURITY device wifi list ifname wlan0": ok(" :Bar:66:WPA2\n"),
    "nmcli connection edit": ok(""), "nmcli connection modify": ok(""),
    "nmcli --wait 30 connection up id Bar ifname wlan0": ok("ok\n"),
  });
  const d = createDevices({ run: f.run, interfaces: () => ({}) });
  assert.equal((await d.state()).wifi.device, "wlan0");
  await d.connectWifi("Bar", "12345678");
  assert.ok(f.calls.some((c) => c.args.join(" ") === "--wait 30 connection up id Bar ifname wlan0"));
});

test("first-boot setup joins Wi-Fi the same way (it used `passwd-file`, which `nmcli device wifi connect` rejects)", async () => {
  const { startSetupd } = await import("../src/setupd.ts");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-setupd-"));
  let profile = "";
  const calls: string[] = [];
  const run = async (cmd: string, args: string[], input?: string) => {
    const line = `${cmd} ${args.join(" ")}`; calls.push(line);
    if (line.startsWith("nmcli -t -f IN-USE,SSID,SIGNAL,SECURITY device wifi list")) return { code: 0, stdout: " :Casa:80:WPA2\n :Libre:30:--\n", stderr: "" };
    if (line.startsWith("nmcli connection edit")) { profile = input ?? ""; return { code: 0, stdout: "", stderr: "" }; }
    if (line === "nmcli --wait 30 connection up id Casa") return /psk clave-de-casa\n/.test(profile) ? { code: 0, stdout: "ok", stderr: "" } : { code: 4, stdout: "", stderr: "Error: Connection activation failed: Secrets were required, but not provided\n" };
    if (line === "nmcli --wait 30 connection up id Libre") return { code: 0, stdout: "ok", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
  const s = startSetupd({ port: 0, runDir: path.join(dir, "run"), stateDir: path.join(dir, "state"), run, log: () => {} });
  await new Promise((r) => s.server.once("listening", r));
  const port = (s.server.address() as any).port;
  const post = async (b: unknown) => (await fetch(`http://127.0.0.1:${port}/wifi`, { method: "POST", headers: { authorization: `Bearer ${s.token}` }, body: JSON.stringify(b) })).json() as any;
  try {
    assert.deepEqual(await post({ ssid: "Casa", password: "otra-cosa-1" }), { error: "No se ha podido conectar: revisa la contraseña." });
    assert.deepEqual(await post({ ssid: "Casa", password: "clave-de-casa" }), { ok: true });
    assert.deepEqual(await post({ ssid: "Casa" }), { error: "Esta red tiene contraseña: escríbela." });
    assert.deepEqual(await post({ ssid: "Libre" }), { ok: true });
    assert.ok(calls.every((c) => !/clave-de-casa|otra-cosa/.test(c)), "no password on any command line");
    assert.ok(!calls.some((c) => c.includes("passwd-file")));
    assert.ok(calls.includes("nmcli connection modify id Casa connection.autoconnect yes"));
  } finally { s.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
