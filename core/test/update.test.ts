// NEXUS Update (core/src/update.ts): releases signed and described file by file, and an updater that only believes
// signed indexes, never goes back in version, installs with a saved copy and puts everything back when an update
// fails, does not start healthy, is cut short or the person presses "Deshacer". Everything runs in temporary folders:
// a fake "/" (root), a channel folder served by a fake fetch, ed25519 keys made for the test.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { buildRelease, createUpdater, validManifest, safePath, cmpVersion, verify, sign, scanTree, type RunFn } from "../src/update.ts";

const tmp = (p: string) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));
const keys = () => {
  const k = crypto.generateKeyPairSync("ed25519");
  return { priv: k.privateKey.export({ type: "pkcs8", format: "pem" }).toString(), pub: k.publicKey.export({ type: "spki", format: "pem" }).toString() };
};
const tar = (args: string[], cwd: string) => { execFileSync("tar", args, { cwd, env: { ...process.env, COPYFILE_DISABLE: "1" } }); };
type Spec = Record<string, string | { link: string } | { text: string; mode: number }>;
function writeTree(dir: string, spec: Spec) {
  for (const [p, v] of Object.entries(spec)) {
    const f = path.join(dir, p); fs.mkdirSync(path.dirname(f), { recursive: true });
    if (typeof v === "string") fs.writeFileSync(f, v, { mode: 0o644 });
    else if ("link" in v) fs.symlinkSync(v.link, f);
    else { fs.writeFileSync(f, v.text); fs.chmodSync(f, v.mode); }
  }
}
const read = (root: string, p: string) => fs.readFileSync(path.join(root, p), "utf8");
const exists = (root: string, p: string) => { try { fs.lstatSync(path.join(root, p)); return true; } catch { return false; } };

const V1: Spec = {
  "/usr/lib/nexus/VERSION": "1.0.0\n",
  "/usr/share/nexus/shell/Main.qml": "main v1",
  "/usr/share/nexus/old.txt": "removed in 1.1",
  "/usr/bin/nexus-hello": { text: "#!/bin/sh\necho v1\n", mode: 0o755 },
  "/usr/local/bin/node": { link: "/usr/lib/nexus/node/bin/node" },
  "/etc/nexus/update.conf": "channel=a\n",
  "/etc/xdg/labwc/rc.xml": "<rc v1/>",
};
const V2: Spec = {
  "/usr/lib/nexus/VERSION": "1.1.0\n",
  "/usr/share/nexus/shell/Main.qml": "main v2",
  "/usr/share/nexus/new.txt": "new in 1.1",
  "/usr/bin/nexus-hello": { text: "#!/bin/sh\necho v2\n", mode: 0o755 },
  "/usr/local/bin/node": { link: "/usr/lib/nexus/node/bin/node2" },
  "/etc/nexus/update.conf": "channel=b\n",
  "/etc/xdg/labwc/rc.xml": "<rc v1/>",
};

/** A machine on release 1.0.0 and a channel that has 1.0.0 and 1.1.0 (or what `releases` says). */
function lab(o: { releases?: [string, Spec, { debs?: { file: string; package: string; version: string }[]; post?: string }?][]; healthy?: () => Promise<boolean>; dpkgFails?: boolean; boot?: () => string } = {}) {
  const k = keys();
  const channel = tmp("nexus-chan-"), root = tmp("nexus-root-"), state = tmp("nexus-state-"), cache = tmp("nexus-cache-"), work = tmp("nexus-work-");
  const releases = o.releases ?? [["1.0.0", V1], ["1.1.0", V2]];
  for (const [v, spec, extra] of releases) {
    const tree = path.join(work, v); writeTree(tree, spec);
    const debs = (extra?.debs ?? []).map((d) => { const f = path.join(work, `${v}-debs`, d.file); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, `deb ${d.package} ${d.version}`); return { path: f, ...d }; });
    let post: string | undefined;
    if (extra?.post) { post = path.join(work, `${v}-post.sh`); fs.writeFileSync(post, extra.post); }
    buildRelease({ tree, version: v, channel, privateKeyPem: k.priv, notes: [`Novedad de ${v}`], debs, post, tar });
  }
  // the machine: installed exactly as the first release, the image's factory manifest next to it
  writeTree(root, releases[0][1]);
  writeTree(root, { "/usr/lib/os-release": 'PRETTY_NAME="NEXUS OS 1.0.0 (dev)"\nVERSION_ID="1.0.0"\nID=nexus\nIMAGE_ID="nexus-os"\nIMAGE_VERSION="1.0.0"\n' });
  const factory = path.join(root, "usr/lib/nexus/update/factory.json");
  fs.mkdirSync(path.dirname(factory), { recursive: true });
  fs.copyFileSync(path.join(channel, "releases", releases[0][0], "manifest.json"), factory);
  // the first release's packages are already installed, and kept by the updater as the image does
  const pkgs = new Map<string, string>();
  for (const d of releases[0][2]?.debs ?? []) {
    pkgs.set(d.package, d.version);
    fs.mkdirSync(path.join(state, "debs"), { recursive: true });
    fs.copyFileSync(path.join(work, `${releases[0][0]}-debs`, d.file), path.join(state, "debs", d.file));
  }
  const calls = { dpkg: [] as string[], restart: [] as string[][], reboot: 0 };
  const run: RunFn = async (cmd, args, opts) => {
    if (cmd === "tar") { try { execFileSync("tar", args, { cwd: opts?.cwd }); return { code: 0, out: "" }; } catch (e) { return { code: 1, out: String((e as Error).message) }; } }
    if (cmd === "dpkg-query") { const v = pkgs.get(args.at(-1)!); return v ? { code: 0, out: v } : { code: 1, out: "" }; }
    if (cmd === "dpkg") {
      calls.dpkg.push(path.basename(args[1]));
      if (o.dpkgFails) return { code: 1, out: "dpkg: error processing archive" };
      const [, pkg, ver] = fs.readFileSync(args[1], "utf8").split(" "); pkgs.set(pkg, ver); return { code: 0, out: "" };
    }
    if (cmd === "sh") { try { return { code: 0, out: execFileSync("sh", args, { cwd: opts?.cwd, env: { ...process.env, ...opts?.env, ROOT: root } }).toString() }; } catch (e) { return { code: 1, out: String(e) }; } }
    throw new Error(`unexpected command ${cmd}`);
  };
  const fetchFn = (async (u: URL | string) => {
    const f = path.join(channel, new URL(String(u)).pathname);
    return fs.existsSync(f) ? new Response(fs.readFileSync(f)) : new Response("no", { status: 404 });
  }) as typeof fetch;
  let healthy = o.healthy ?? (async () => true);
  let boot = o.boot ?? (() => "boot-1");
  const make = () => createUpdater({
    root, stateDir: state, cacheDir: cache, publicKeyPem: k.pub, factoryManifest: factory,
    channel: () => "http://canal.test/", fetchFn, run, healthy: () => healthy(), healthTries: 2,
    restart: async (changed) => { calls.restart.push(changed); }, bootId: () => boot(), reboot: async () => { calls.reboot++; },
  });
  return { k, channel, root, state, cache, calls, pkgs, make, u: make(),
    setHealthy: (h: () => Promise<boolean>) => { healthy = h; }, setBoot: (b: () => string) => { boot = b; } };
}

test("a release lists every file and link with its sha256 and mode; only /usr and /etc, never .. or another place", () => {
  const t = tmp("nexus-tree-"); writeTree(t, V1);
  const files = scanTree(t);
  const hello = files.find((e) => e.path === "/usr/bin/nexus-hello")!;
  assert.equal(hello.type, "file"); assert.equal(hello.type === "file" && hello.mode, 0o755);
  assert.deepEqual(files.find((e) => e.path === "/usr/local/bin/node"), { path: "/usr/local/bin/node", type: "link", target: "/usr/lib/nexus/node/bin/node" });
  assert.ok(validManifest({ version: "1.0.0", files, debs: [] }));
  for (const bad of ["/home/nexus/.bashrc", "/var/lib/x", "/usr/../etc/shadow", "/usr/share/./x", "usr/bin/x", "/usr", "/etc/x/", "/boot/vmlinuz"]) assert.equal(safePath(bad), false, bad);
  assert.equal(validManifest({ version: "1.0", files: [], debs: [] }), false);
  assert.equal(validManifest({ version: "1.0.0", files: [{ path: "/usr/x", type: "file", sha256: "zz", mode: 420, size: 1 }], debs: [] }), false);
  assert.equal(validManifest({ version: "1.0.0", files: [], debs: [{ package: "labwc; rm -rf /", version: "1", sha256: "a".repeat(64), file: "x.deb" }] }), false);
  assert.ok(cmpVersion("1.10.0", "1.9.9") > 0 && cmpVersion("2.0.0", "2.0.0") === 0 && cmpVersion("0.9.1", "1.0.0") < 0);
});

test("check → download → install: new files in place, removed ones gone, links and modes right, the history says so", async () => {
  const L = lab();
  assert.equal(L.u.status().installed, "1.0.0");
  const s = await L.u.check();
  assert.equal(s.state, "available"); assert.equal(s.available!.version, "1.1.0"); assert.deepEqual(s.available!.notes, ["Novedad de 1.1.0"]);
  const all = JSON.parse(fs.readFileSync(path.join(L.channel, "latest.json"), "utf8")).bundles;
  assert.equal(s.available!.size, all.find((b: { from: string }) => b.from === "1.0.0").size, "the bundle made from 1.0.0 is the one offered");
  const listed = execFileSync("tar", ["-tf", path.join(L.channel, "bundles", "nexus-1.1.0-from-1.0.0.tar")]).toString();
  assert.ok(listed.includes("files/usr/share/nexus/shell/Main.qml") && !listed.includes("files/etc/xdg/labwc/rc.xml"), "it carries only what changed");
  assert.equal((await L.u.download()).state, "ready");
  const done = await L.u.install();
  assert.equal(done.state, "idle", done.message); assert.equal(done.installed, "1.1.0"); assert.match(done.message!, /1\.1\.0 instalada/);
  assert.equal(read(L.root, "/usr/share/nexus/shell/Main.qml"), "main v2");
  assert.equal(read(L.root, "/usr/share/nexus/new.txt"), "new in 1.1");
  assert.equal(exists(L.root, "/usr/share/nexus/old.txt"), false);
  assert.equal(fs.statSync(path.join(L.root, "/usr/bin/nexus-hello")).mode & 0o777, 0o755);
  assert.equal(fs.readlinkSync(path.join(L.root, "/usr/local/bin/node")), "/usr/lib/nexus/node/bin/node2");
  assert.match(read(L.root, "/usr/lib/os-release"), /^IMAGE_VERSION="1\.1\.0"$/m);
  assert.match(read(L.root, "/usr/lib/os-release"), /^PRETTY_NAME="NEXUS OS 1\.1\.0 \(dev\)"$/m);
  assert.match(read(L.root, "/usr/lib/os-release"), /^ID=nexus$/m);
  assert.equal(read(L.root, "/etc/xdg/labwc/rc.xml"), "<rc v1/>", "unchanged files are not touched");
  assert.ok(L.calls.restart[0].includes("/usr/share/nexus/shell/Main.qml"), "the services that use the changed files restart");
  assert.equal(L.u.history()[0].result, "installed"); assert.equal(L.u.history()[0].from, "1.0.0");
  assert.deepEqual(done.canUndo, { version: "1.0.0" });
  assert.equal(fs.readdirSync(L.cache).length, 0, "the download is cleaned up");
  // and then it is up to date
  assert.match((await L.u.check()).message!, /Estás al día: NEXUS OS 1\.1\.0/);
});

test("only signed indexes are believed: a changed latest.json or a key that is not NEXUS's installs nothing", async () => {
  const L = lab();
  const f = path.join(L.channel, "latest.json");
  fs.writeFileSync(f, fs.readFileSync(f, "utf8").replace("Novedad de 1.1.0", "Instala esto"));
  const s = await L.u.check();
  assert.equal(s.state, "idle"); assert.equal(s.available, undefined); assert.match(s.message!, /firma del canal no es válida/);
  const other = keys();
  fs.writeFileSync(path.join(L.channel, "latest.json.sig"), sign(fs.readFileSync(f, "utf8"), other.priv));
  assert.match((await L.u.check()).message!, /firma del canal no es válida/);
  assert.equal(verify("x", sign("x", other.priv), L.k.pub), false);
  await assert.rejects(L.u.download(), /No hay ninguna actualización/);
});

test("a bundle that does not match its signed sha256 is thrown away before it is even opened", async () => {
  const L = lab();
  await L.u.check();
  const b = fs.readdirSync(path.join(L.channel, "bundles")).find((n) => n.includes("from-1.0.0"))!;
  const f = path.join(L.channel, "bundles", b), buf = fs.readFileSync(f); buf[buf.length - 1] ^= 1; fs.writeFileSync(f, buf);
  const s = await L.u.download();
  assert.equal(s.state, "error"); assert.match(s.message!, /no coincide con la firmada/);
  assert.equal(fs.readdirSync(L.cache).length, 0);
  assert.equal(read(L.root, "/usr/share/nexus/shell/Main.qml"), "main v1");
});

test("a check that cannot reach the channel says so in words, and the next good check clears it", async () => {
  const L = lab();
  let down = true;
  const u = createUpdater({
    root: L.root, stateDir: L.state, cacheDir: L.cache, publicKeyPem: L.k.pub, factoryManifest: path.join(L.root, "usr/lib/nexus/update/factory.json"),
    channel: () => "http://canal.test/",
    fetchFn: (async (url: URL | string) => {
      if (down) throw new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } });
      const f = path.join(L.channel, new URL(String(url)).pathname);
      return new Response(fs.readFileSync(f));
    }) as typeof fetch,
    run: async () => ({ code: 0, out: "" }), healthy: async () => true, restart: async () => {}, bootId: () => "b",
  });
  const bad = await u.check();
  assert.equal(bad.state, "idle"); assert.equal(bad.checkFailed, true);
  assert.equal(bad.message, "No se ha podido buscar actualizaciones: no hay conexión con el canal de actualizaciones.");
  down = false;
  const good = await u.check();
  assert.equal(good.state, "available"); assert.equal(good.checkFailed, undefined);
});

test("operations wait their turn: an install asked while the download is finishing is not lost", async () => {
  const L = lab();
  await L.u.check();
  const [, inst] = await Promise.all([L.u.download(), L.u.install(), L.u.check()]);
  assert.equal(inst.installed, "1.1.0");
  assert.equal(read(L.root, "/usr/share/nexus/shell/Main.qml"), "main v2");
});

test("never an older or the same version, whatever the channel says", async () => {
  const L = lab({ releases: [["1.0.0", V1]] });
  assert.match((await L.u.check()).message!, /Estás al día/);
  const Old = lab({ releases: [["0.9.0", V1]] });
  fs.writeFileSync(path.join(Old.state, "installed.json"), JSON.stringify({ version: "1.0.0", files: [], debs: [] }));
  const u = Old.make();
  const s = await u.check();
  assert.equal(s.state, "idle"); assert.equal(s.available, undefined);
});

test("an update that does not start healthy is undone by itself: every file back as it was", async () => {
  const L = lab({ healthy: async () => false });
  await L.u.check(); await L.u.download();
  const s = await L.u.install();
  assert.equal(s.state, "error"); assert.match(s.message!, /no arrancaba bien, así que se ha deshecho sola/);
  assert.equal(s.installed, "1.0.0");
  assert.equal(read(L.root, "/usr/share/nexus/shell/Main.qml"), "main v1");
  assert.equal(read(L.root, "/usr/share/nexus/old.txt"), "removed in 1.1");
  assert.equal(exists(L.root, "/usr/share/nexus/new.txt"), false, "files the update created are removed again");
  assert.equal(fs.readlinkSync(path.join(L.root, "/usr/local/bin/node")), "/usr/lib/nexus/node/bin/node");
  assert.match(read(L.root, "/usr/lib/os-release"), /^IMAGE_VERSION="1\.0\.0"$/m);
  assert.equal(L.u.history()[0].result, "rolled-back");
  assert.equal(L.calls.restart.length, 2, "restarted on the new version, then again on the old one");
  assert.equal(s.available!.version, "1.1.0", "it is still offered: the person decides whether to try again");
});

test("a version undone by itself is remembered: still offered, never downloaded by itself again", async () => {
  const L = lab({ healthy: async () => false });
  await L.u.check(); await L.u.download();
  const undone = await L.u.install();
  assert.equal(undone.available?.failedBefore, true, "Ajustes knows at once");
  const again = await L.make().check();
  assert.equal(again.state, "available"); assert.equal(again.available?.version, "1.1.0"); assert.equal(again.available?.failedBefore, true);
  const fresh = lab();
  assert.equal((await fresh.u.check()).available?.failedBefore, undefined);
});

test("'Deshacer' after a good update goes back to the previous version", async () => {
  const L = lab();
  await L.u.check(); await L.u.download(); await L.u.install();
  const s = await L.u.undo();
  assert.equal(s.installed, "1.0.0"); assert.equal(s.canUndo, undefined);
  assert.equal(read(L.root, "/usr/share/nexus/shell/Main.qml"), "main v1");
  assert.equal(read(L.root, "/usr/bin/nexus-hello"), "#!/bin/sh\necho v1\n");
  assert.equal(L.u.history()[0].result, "undone");
  assert.equal(s.state, "available"); assert.match(s.message!, /Has vuelto a NEXUS OS 1\.0\.0/);
  await assert.rejects(L.u.undo(), /No hay ninguna actualización que deshacer/);
});

test("an install cut short (power cut) is undone at the next start", async () => {
  const L = lab();
  await L.u.check(); await L.u.download(); await L.u.install();
  // simulate a cut in the middle of the next install: journal still says "installing", files half replaced
  fs.writeFileSync(path.join(L.state, "journal.json"), JSON.stringify({ phase: "installing", version: "1.1.0", from: "1.0.0" }));
  fs.writeFileSync(path.join(L.root, "/usr/share/nexus/shell/Main.qml"), "half written?");
  const s = await L.make().recover();
  assert.equal(s.installed, "1.0.0"); assert.match(s.message!, /se cortó a medias/);
  assert.equal(read(L.root, "/usr/share/nexus/shell/Main.qml"), "main v1");
  assert.equal(fs.existsSync(path.join(L.state, "journal.json")), false);
});

test("/etc: a setting the person changed is kept, NEXUS's new version goes next to it", async () => {
  const L = lab();
  fs.writeFileSync(path.join(L.root, "/etc/nexus/update.conf"), "channel=mine\n");
  await L.u.check(); await L.u.download();
  const s = await L.u.install();
  assert.equal(read(L.root, "/etc/nexus/update.conf"), "channel=mine\n");
  assert.equal(read(L.root, "/etc/nexus/update.conf.nexus-nuevo"), "channel=b\n");
  assert.match(s.message!, /conservado tus cambios en \/etc\/nexus\/update\.conf/);
  await L.u.undo();
  assert.equal(exists(L.root, "/etc/nexus/update.conf.nexus-nuevo"), false);
  assert.equal(read(L.root, "/etc/nexus/update.conf"), "channel=mine\n");
});

test("/etc: a setting the person already changed to exactly NEXUS's new version is no conflict", async () => {
  const L = lab();
  fs.writeFileSync(path.join(L.root, "/etc/nexus/update.conf"), "channel=b\n");
  await L.u.check(); await L.u.download();
  const s = await L.u.install();
  assert.equal(read(L.root, "/etc/nexus/update.conf"), "channel=b\n");
  assert.equal(exists(L.root, "/etc/nexus/update.conf.nexus-nuevo"), false);
  assert.doesNotMatch(s.message ?? "", /conservado/);
});

test("packages: installed with dpkg and kept; labwc needs a restart, checked after it; a failed one changes nothing", async () => {
  const deb = (v: string) => ({ file: `labwc_${v}_arm64.deb`, package: "labwc", version: v });
  const rel: [string, Spec, { debs: ReturnType<typeof deb>[] }][] = [["1.0.0", V1, { debs: [deb("0.8.3-1+nexus1")] }], ["1.1.0", V2, { debs: [deb("0.8.3-1+nexus2")] }]];
  const L = lab({ releases: rel });
  await L.u.check(); await L.u.download();
  const s = await L.u.install();
  assert.equal(s.state, "reboot"); assert.match(s.message!, /Reinicia el ordenador para terminar/);
  assert.deepEqual(L.calls.dpkg, ["labwc_0.8.3-1+nexus2_arm64.deb"]);
  assert.equal(L.pkgs.get("labwc"), "0.8.3-1+nexus2");
  assert.ok(fs.existsSync(path.join(L.state, "debs", "labwc_0.8.3-1+nexus2_arm64.deb")), "kept for a later Deshacer");
  // the daemon restarting on the same boot keeps waiting for the restart of the computer
  assert.equal((await L.make().recover()).state, "reboot");
  // after the restart, healthy: done
  L.setBoot(() => "boot-2");
  const after = await L.make().recover();
  assert.equal(after.state, "idle"); assert.equal(after.installed, "1.1.0"); assert.equal(L.u.history()[0].result, "installed");
  // Deshacer reinstalls the previous package from the updater's own copy
  await L.make().undo();
  assert.equal(L.pkgs.get("labwc"), "0.8.3-1+nexus1");

  const F = lab({ releases: rel, dpkgFails: true });
  await F.u.check(); await F.u.download();
  const f = await F.u.install();
  assert.equal(f.state, "error"); assert.match(f.message!, /No se ha podido instalar NEXUS OS 1\.1\.0: no se ha podido instalar labwc/);
  assert.equal(read(F.root, "/usr/share/nexus/shell/Main.qml"), "main v1");
  assert.equal(F.u.history()[0].result, "failed");
});

test("at start, a NEXUS package that is not the manifest's version is put back from the updater's own copy", async () => {
  const deb = (v: string) => ({ file: `labwc_${v}_arm64.deb`, package: "labwc", version: v });
  const L = lab({ releases: [["1.0.0", V1, { debs: [deb("0.8.3-1+nexus1")] }], ["1.1.0", V2]] });
  L.pkgs.set("labwc", "0.8.3-1");   // the image was built with Debian's labwc
  const s = await L.u.recover();
  assert.deepEqual(L.calls.dpkg, ["labwc_0.8.3-1+nexus1_arm64.deb"]);
  assert.equal(L.pkgs.get("labwc"), "0.8.3-1+nexus1");
  assert.equal(L.u.history()[0].result, "repaired"); assert.match(L.u.history()[0].detail!, /^labwc no era la versión de NEXUS.*próximo inicio de sesión/);
  assert.equal(s.state, "idle");
  // right already: nothing to do; and a copy that does not match its manifest is never installed
  await L.make().recover(); assert.equal(L.calls.dpkg.length, 1);
  L.pkgs.set("labwc", "0.8.3-1");
  fs.writeFileSync(path.join(L.state, "debs", "labwc_0.8.3-1+nexus1_arm64.deb"), "tampered");
  await L.make().recover(); assert.equal(L.calls.dpkg.length, 1); assert.equal(L.pkgs.get("labwc"), "0.8.3-1");
});

test("a restart that never comes back healthy: one more try, then the previous version and another restart", async () => {
  const deb = (v: string) => ({ file: `labwc_${v}_arm64.deb`, package: "labwc", version: v });
  const L = lab({ releases: [["1.0.0", V1, { debs: [deb("1")] }], ["1.1.0", V2, { debs: [deb("2")] }]] });
  await L.u.check(); await L.u.download(); await L.u.install();
  L.setHealthy(async () => false);
  L.setBoot(() => "boot-2");
  const first = await L.make().recover();
  assert.match(first.message!, /se vuelve a intentar con otro reinicio/); assert.equal(L.calls.reboot, 1);
  L.setBoot(() => "boot-3");
  const second = await L.make().recover();
  assert.equal(second.installed, "1.0.0"); assert.match(second.message!, /se ha deshecho sola/);
  assert.equal(L.pkgs.get("labwc"), "1"); assert.equal(L.calls.reboot, 2, "back to the old labwc needs a restart too");
});

test("the release's final script runs once, as part of the install, with both versions", async () => {
  const post = 'printf "%s->%s" "$NEXUS_UPDATE_FROM" "$NEXUS_UPDATE_TO" > "$ROOT/usr/share/nexus/post-ran"\n';
  const L = lab({ releases: [["1.0.0", V1], ["1.1.0", V2, { post }]] });
  await L.u.check(); await L.u.download();
  await L.u.install();
  assert.equal(read(L.root, "/usr/share/nexus/post-ran"), "1.0.0->1.1.0");
});

test("skipping versions: from 1.0.0 straight to 1.2.0 with its own bundle; from an unknown version, the full one", async () => {
  const V3: Spec = { ...V2, "/usr/lib/nexus/VERSION": "1.2.0\n", "/usr/share/nexus/shell/Main.qml": "main v3" };
  const L = lab({ releases: [["1.0.0", V1], ["1.1.0", V2], ["1.2.0", V3]] });
  const s = await L.u.check();
  assert.equal(s.available!.version, "1.2.0");
  await L.u.download(); await L.u.install();
  assert.equal(read(L.root, "/usr/share/nexus/shell/Main.qml"), "main v3");
  const latest = JSON.parse(fs.readFileSync(path.join(L.channel, "latest.json"), "utf8"));
  assert.deepEqual(latest.bundles.map((b: { from: string }) => b.from), ["1.0.0", "1.1.0", "*"]);
  // a machine the channel does not know (say a dev build) gets the bundle with everything
  const M = lab({ releases: [["1.0.0", V1], ["1.1.0", V2]] });
  fs.writeFileSync(path.join(M.state, "installed.json"), JSON.stringify({ version: "0.5.0", files: [], debs: [] }));
  const u = M.make();
  await u.check(); await u.download();
  assert.equal((await u.install()).installed, "1.1.0");
  assert.equal(read(M.root, "/usr/share/nexus/new.txt"), "new in 1.1");
});
