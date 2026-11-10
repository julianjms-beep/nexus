// The first-boot assistant's rules (core/src/setup.ts): account checks, keyboards, Wi-Fi list parsing, first login.
import test from "node:test";
import assert from "node:assert/strict";
import {
  KEYBOARDS, keyboardById, keyboardFile, xkbEnv, isAppleKeyboard, suggestUsername, checkAccount, checkClaudeKey,
  checkTimezone, nmcliFields, parseWifiList, checkSsid, checkWifiPassword, firstLoginConfig,
} from "../src/setup.ts";

test("a suggested user name is the first name in plain lowercase letters", () => {
  assert.equal(suggestUsername("Ana García López"), "ana");
  assert.equal(suggestUsername("  Íñigo  "), "inigo");
  assert.equal(suggestUsername("Zoë"), "zoe");
  assert.equal(suggestUsername("123 Ana"), "usuario");
  assert.equal(suggestUsername(""), "usuario");
});

test("the account rules: name, login name, password, repeated password", () => {
  const good = { fullName: "Ana García", username: "ana", password: "pista-larga-7", password2: "pista-larga-7" };
  assert.deepEqual(checkAccount(good), { ok: true });
  assert.equal((checkAccount({ ...good, fullName: "  " }) as { field: string }).field, "fullName");
  assert.equal((checkAccount({ ...good, fullName: "a:b" }) as { field: string }).field, "fullName");
  for (const bad of ["Carlos", "1carlos", "car los", "carlós", "", "a".repeat(32)]) {
    assert.equal((checkAccount({ ...good, username: bad }) as { field: string }).field, "username", bad);
  }
  for (const reserved of ["root", "_greetd", "nexus", "nexus-engine", "sudo"]) {
    assert.equal((checkAccount({ ...good, username: reserved }) as { field: string }).field, "username", reserved);
  }
  assert.equal((checkAccount(good, new Set(["ana"])) as { field: string }).field, "username");
  assert.equal((checkAccount({ ...good, password: "12345", password2: "12345" }) as { field: string }).field, "password");
  assert.equal((checkAccount({ ...good, password: "ana", password2: "ana" }) as { field: string }).field, "password");
  assert.equal((checkAccount({ ...good, password: "a\nbcdefg", password2: "a\nbcdefg" }) as { field: string }).field, "password");
  assert.equal((checkAccount({ ...good, password2: "otra-cosa" }) as { field: string }).field, "password2");
  assert.equal((checkAccount({ ...good, username: 7 as unknown as string }) as { field: string }).field, "username");
});

test("keyboards: Debian's /etc/default/keyboard and labwc's XKB lines, Apple keyboards type like on macOS", () => {
  assert.equal(KEYBOARDS[0].id, "es");
  const cat = keyboardById("es-cat")!;
  assert.match(keyboardFile(cat), /^XKBLAYOUT="es"$/m);
  assert.match(keyboardFile(cat), /^XKBVARIANT="cat"$/m);
  assert.equal(xkbEnv(keyboardById("us")!, false), "XKB_DEFAULT_LAYOUT=us\n");
  assert.equal(xkbEnv(cat, true), "XKB_DEFAULT_LAYOUT=es\nXKB_DEFAULT_VARIANT=cat\nXKB_DEFAULT_OPTIONS=lv3:lalt_switch\n");
  assert.equal(keyboardById("klingon"), undefined);
  assert.equal(keyboardById({ toString: () => "es" }), undefined);
  assert.ok(isAppleKeyboard('I: Bus=0003 Vendor=05ac\nN: Name="Apple Inc. Virtual USB Keyboard"\n'));
  assert.ok(!isAppleKeyboard('N: Name="AT Translated Set 2 keyboard"\nN: Name="Apple Inc. Magic Trackpad"\n'));
});

test("time zones must be real ones from the list", () => {
  const list = ["Europe/Madrid", "Atlantic/Canary", "America/Argentina/Buenos_Aires"];
  assert.ok(checkTimezone("Europe/Madrid", list));
  assert.ok(checkTimezone("America/Argentina/Buenos_Aires", list));
  assert.ok(!checkTimezone("Europe/Paris", list));
  assert.ok(!checkTimezone("../../etc/passwd", ["../../etc/passwd"]));
  assert.ok(!checkTimezone(42, list));
});

test("Claude keys follow the engine's rule", () => {
  assert.ok(checkClaudeKey("sk-ant-api03-" + "a".repeat(40)));
  assert.ok(!checkClaudeKey("sk-live-123"));
  assert.ok(!checkClaudeKey("sk-ant-short"));
});

test("nmcli's terse lines: escaped ':' and '\\' stay inside the field", () => {
  assert.deepEqual(nmcliFields("*:Casa\\:5G:72:WPA2"), ["*", "Casa:5G", "72", "WPA2"]);
  assert.deepEqual(nmcliFields(" :a\\\\b:10:"), [" ", "a\\b", "10", ""]);
});

test("the Wi-Fi list: one entry per network, the connected one first, then by signal, hidden ones left out", () => {
  const out = [
    " :Vecino:40:WPA2",
    " :Casa:55:WPA2",
    "*:Casa:81:WPA2",
    " ::90:WPA2",
    " :Bar Libre:67:--",
    " :Vecino:62:WPA1 WPA2",
    "",
  ].join("\n");
  assert.deepEqual(parseWifiList(out), [
    { ssid: "Casa", signal: 81, secure: true, active: true },
    { ssid: "Bar Libre", signal: 67, secure: false, active: false },
    { ssid: "Vecino", signal: 62, secure: true, active: false },
  ]);
});

test("Wi-Fi names and passwords nmcli can take safely", () => {
  assert.ok(checkSsid("Casa 5G"));
  assert.ok(!checkSsid(""));
  assert.ok(!checkSsid("a".repeat(33)));
  assert.ok(!checkSsid("a\nb"));
  assert.ok(checkWifiPassword(""));
  assert.ok(checkWifiPassword("12345678"));
  assert.ok(!checkWifiPassword("1234567"));
  assert.ok(checkWifiPassword("ab".repeat(32)));
  assert.ok(!checkWifiPassword("x".repeat(64)));
});

test("the first login after setup: greetd's usual configuration plus one automatic login of the new person", () => {
  const base = '[terminal]\nvt = 1\n\n[default_session]\ncommand = "/usr/bin/nexus-greeter-session"\nuser = "_greetd"\n';
  const cfg = firstLoginConfig(base, "carlos");
  assert.match(cfg, /\[default_session\]\ncommand = "\/usr\/bin\/nexus-greeter-session"/);
  assert.match(cfg, /\[initial_session\]\ncommand = "\/usr\/bin\/nexus-session"\nuser = "carlos"\n$/);
  // an older initial_session (the dev image's) is replaced, never doubled
  const twice = firstLoginConfig(base + '\n[initial_session]\ncommand = "x"\nuser = "nexus"\n', "ana");
  assert.equal(twice.match(/\[initial_session\]/g)?.length, 1);
  assert.match(twice, /user = "ana"/);
  assert.throws(() => firstLoginConfig(base, 'x"\n[evil]'));
});
