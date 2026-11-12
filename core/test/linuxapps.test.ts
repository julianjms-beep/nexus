// NEXUS Store → Linux apps (core/src/linuxapps.ts): the catalogue is text from strangers, an app id is the only thing
// that reaches a command line, and what an app can reach is said in plain words.
import test from "node:test";
import assert from "node:assert/strict";
import { LinuxApps, checkAppId, explainPermissions, humanSize, parseInstalled, FLATHUB_REPO } from "../src/linuxapps.ts";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
function setup(routes: Record<string, unknown>, run?: (argv: string[], onLine?: (l: string) => void) => { code: number; out: string }) {
  const asked: { url: string; body?: string }[] = [];
  const ran: string[][] = [];
  let changes = 0;
  const apps = new LinuxApps({
    arch: "aarch64",
    fetchFn: (async (url: string, init?: RequestInit) => {
      asked.push({ url: String(url), body: init?.body as string | undefined });
      const key = Object.keys(routes).find((k) => String(url).includes(k));
      return key ? json(routes[key]) : json({ detail: "Not found" }, 404);
    }) as typeof fetch,
    run: async (argv, onLine) => { ran.push(argv); return run ? run(argv, onLine) : { code: 0, out: "" }; },
    onChange: () => { changes++; },
  });
  return { apps, asked, ran, changes: () => changes };
}

test("an app id is a reverse-domain name and nothing else", () => {
  assert.equal(checkAppId("org.gimp.GIMP"), "org.gimp.GIMP");
  assert.equal(checkAppId("io.github.some_one.App-2"), "io.github.some_one.App-2");
  for (const bad of ["", "gimp", "org.gimp", "org.gimp.GIMP; rm -rf ~", "--user", "org.gimp.GIMP --delete-data", "org..GIMP", "org.gimp.GIMP\n", "../../etc/passwd", "a".repeat(130) + ".b.c", null, undefined, 7])
    assert.throws(() => checkAppId(bad), /no existe/);
});

test("permissions in plain words, the most serious first", () => {
  const gimp = explainPermissions({ sockets: ["fallback-x11", "wayland"], devices: ["all"], shared: ["ipc", "network"], filesystems: ["xdg-config/GIMP:create", "/tmp", "host"] });
  assert.equal(gimp[0].level, "alto");
  assert.ok(gimp.some((p) => p.text === "Puede leer y cambiar todos los archivos del equipo"));
  assert.ok(gimp.some((p) => /cámara/.test(p.text)));
  assert.ok(gimp.some((p) => p.text === "Puede usar Internet" && p.level === "medio"));
  assert.match(explainPermissions({ filesystems: ["home:ro"] })[0].text, /leer toda tu carpeta personal/);
  assert.deepEqual(explainPermissions({ filesystems: ["xdg-download", "xdg-pictures:ro"], shared: ["network"] }).map((p) => p.text), ["Puede usar tus carpetas: Descargas, Imágenes", "Puede usar Internet"]);
  assert.equal(explainPermissions({ "session-bus": { talk: ["org.freedesktop.Flatpak"] } })[0].level, "alto");
  assert.deepEqual(explainPermissions({ sockets: ["wayland"] }), [{ level: "bajo", text: "No pide nada fuera de su propio espacio" }]);
  // whatever arrives instead of the expected object, it never throws
  for (const odd of [null, undefined, "host", 3, { filesystems: "host" }, { devices: [{}] }]) assert.ok(explainPermissions(odd).length >= 1);
});

test("sizes and the installed list", () => {
  assert.equal(humanSize(269117952), "257 MB");
  assert.equal(humanSize(3 * 1024 ** 3), "3,0 GB");
  assert.equal(humanSize(0), "");
  const list = parseInstalled("org.videolan.VLC\tVLC\t3.0.21\t92,4 MB\norg.gimp.GIMP\tGNU Image <b>Manipulation</b> Program\t3.2.8\t257 MB\nnot an app\tx\n\n");
  assert.deepEqual(list.map((a) => a.id), ["org.gimp.GIMP", "org.videolan.VLC"]);
  assert.equal(list[0].name, "GNU Image Manipulation Program");
});

test("search: only apps built for this computer, text cleaned, icons only from Flathub", async () => {
  const s = setup({
    "/search": { hits: [
      { app_id: "org.gimp.GIMP", name: "GIMP", summary: "Image <script>alert(1)</script> editor", icon: "https://dl.flathub.org/media/org/gimp/GIMP/x/icon", type: "desktop-application", arches: ["x86_64", "aarch64"], verification_verified: true, main_categories: "graphics", developer_name: "The GIMP team", installs_last_month: 54045 },
      { app_id: "com.only.Intel", name: "Intel only", arches: ["x86_64"], type: "desktop-application" },
      { app_id: "org.evil.App; rm -rf ~", name: "Bad id", arches: ["aarch64"] },
      { app_id: "org.evil.Icon", name: "Icon elsewhere", icon: "https://evil.example/track.png", arches: ["aarch64"] },
      { app_id: "org.some.Runtime", name: "A runtime", type: "runtime", arches: ["aarch64"] },
    ] },
    "/collection/popular": { hits: [{ app_id: "org.mozilla.firefox", name: "Firefox", arches: ["aarch64"], type: "desktop-application" }] },
  });
  const found = await s.apps.search("  gimp  ");
  assert.deepEqual(found.map((a) => a.id), ["org.gimp.GIMP", "org.evil.Icon"]);
  assert.equal(found[0].summary, "Image alert(1) editor");
  assert.equal(found[0].category, "Imagen y diseño");
  assert.equal(found[0].verified, true);
  assert.equal(found[1].icon, "");
  assert.equal(JSON.parse(s.asked[0].body!).query, "gimp");
  assert.deepEqual((await s.apps.search("")).map((a) => a.id), ["org.mozilla.firefox"]);
});

test("details: description without markup, sizes, screenshots, permissions and the risk they add up to", async () => {
  const s = setup({
    "/appstream/org.gimp.GIMP": {
      name: "GNU Image Manipulation Program", summary: "High-end image creation", description: "<p>GIMP is an editor.</p>\n<ul><li>Layers</li></ul>", developer_name: "The GIMP team",
      icon: "https://dl.flathub.org/media/org/gimp/GIMP/x/icon", project_license: "GPL-3.0+", urls: { homepage: "https://www.gimp.org/" }, releases: [{ version: "3.2.8" }], categories: ["Graphics"],
      metadata: { "flathub::verification::verified": true },
      screenshots: [{ sizes: [{ src: "https://dl.flathub.org/media/a_orig.png", width: "1920" }, { src: "https://dl.flathub.org/media/a_1248.png", width: "1248" }, { src: "https://dl.flathub.org/media/a_624.png", width: "624" }] }, { sizes: [{ src: "http://dl.flathub.org/plain.png", width: "800" }] }],
    },
    "/summary/org.gimp.GIMP": { arches: ["aarch64", "x86_64"], download_size: 102756941, installed_size: 269117952, metadata: { permissions: { filesystems: ["host"], shared: ["network"] } } },
    "/appstream/com.only.Intel": { name: "Intel only" },
    "/summary/com.only.Intel": { arches: ["x86_64"] },
  });
  const d = await s.apps.details("org.gimp.GIMP");
  assert.equal(d.description, "GIMP is an editor.\nLayers");
  assert.deepEqual(d.screenshots, ["https://dl.flathub.org/media/a_1248.png"]);
  assert.equal(d.homepage, "https://www.gimp.org/");
  assert.equal(d.version, "3.2.8");
  assert.equal(d.installedBytes, 269117952);
  assert.equal(d.risk, "alto");
  assert.equal(d.verified, true);
  await assert.rejects(s.apps.details("com.only.Intel"), /no está hecha para este tipo de ordenador/);
  await assert.rejects(s.apps.details("org.not.There"), /no existe en el catálogo/);
  await assert.rejects(s.apps.details("x; id"), /no existe/);
});

test("the catalogue being down or offline is said plainly", async () => {
  const offline = new LinuxApps({ run: async () => ({ code: 0, out: "" }), fetchFn: (async () => { throw new TypeError("fetch failed"); }) as typeof fetch });
  await assert.rejects(offline.search("gimp"), /No hay conexión con el catálogo/);
  const down = new LinuxApps({ run: async () => ({ code: 0, out: "" }), fetchFn: (async () => json({}, 503)) as typeof fetch });
  await assert.rejects(down.popular(), /no responde ahora mismo/);
});

test("install: for this person only, from Flathub, one at a time, with progress that never goes back", async () => {
  let release!: () => void; const gate = new Promise<void>((r) => { release = r; });
  const ran: string[][] = [];
  const apps = new LinuxApps({
    run: async (argv, onLine) => {
      ran.push(argv);
      if (argv[1] === "install" && argv.at(-1) === "org.gimp.GIMP") { onLine?.("Installing 1/2…  12%"); onLine?.("Installing 1/2…  80%"); onLine?.("Installing 2/2…  5%"); await gate; }
      return { code: 0, out: "" };
    },
  });
  const { job, done } = apps.install("org.gimp.GIMP");
  assert.equal(job.state, "running");
  assert.throws(() => apps.install("org.videolan.VLC"), /Ya se está instalando otra app/);
  assert.throws(() => apps.remove("org.videolan.VLC"), /otra instalación en marcha/);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(job.percent, 80);
  release();
  assert.equal((await done).state, "done");
  assert.equal(job.percent, 100);
  assert.deepEqual(ran[0], ["flatpak", "remote-add", "--user", "--if-not-exists", "flathub", FLATHUB_REPO]);
  assert.deepEqual(ran[1], ["flatpak", "install", "--user", "--noninteractive", "-y", "flathub", "org.gimp.GIMP"]);
  // the source is added once
  await apps.install("org.videolan.VLC").done;
  assert.equal(ran.filter((a) => a[1] === "remote-add").length, 1);
  assert.throws(() => apps.install("org.gimp.GIMP --system"), /no existe/);
});

test("install failures say why; removing can also delete what the app saved; no flatpak → said, not run", async () => {
  const full = setup({}, (argv) => (argv[1] === "install" ? { code: 1, out: "error: No space left on device" } : { code: 0, out: "" }));
  const j = await full.apps.install("org.gimp.GIMP").done;
  assert.deepEqual([j.state, j.error], ["failed", "No queda espacio en el disco para esta app."]);
  const net = setup({}, (argv) => (argv[1] === "remote-add" ? { code: 1, out: "Temporary failure in name resolution" } : { code: 0, out: "" }));
  assert.equal((await net.apps.install("org.gimp.GIMP").done).state, "failed");
  const rm = setup({});
  await rm.apps.remove("org.gimp.GIMP", true).done;
  assert.deepEqual(rm.ran[0], ["flatpak", "uninstall", "--user", "--noninteractive", "-y", "--delete-data", "org.gimp.GIMP"]);
  assert.deepEqual(rm.apps.launchArgv("org.gimp.GIMP"), ["flatpak", "run", "org.gimp.GIMP"]);
  assert.deepEqual(rm.apps.restrictArgv("org.gimp.GIMP"), ["flatpak", "override", "--user", "--nofilesystem=host", "--nofilesystem=home", "org.gimp.GIMP"]);
  assert.ok(rm.changes() >= 2);
  const none = new LinuxApps({ run: async () => { throw new Error("must not run"); }, available: () => false });
  assert.throws(() => none.install("org.gimp.GIMP"), /falta el instalador/);
  assert.deepEqual(await none.installed(), []);
});
