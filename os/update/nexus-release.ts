// nexus-release: make NEXUS OS releases for NEXUS Update (core/src/update.ts). Runs in the Debian builder VM, after
// os/build.sh has staged the release tree (everything NEXUS adds to Debian) in ~/nexus-build/release-tree.
//
//   keygen  <private.pem> <public.pem>     a new ed25519 signing key. The private key never goes into git: it lives in
//                                          ~/.nexus-keys on the machine that publishes; the public one is
//                                          os/mkosi.extra/usr/share/nexus/update/signing.pub.
//   factory --tree T --version V [--debs D] --out F
//                                          the manifest of what an image comes with (os/build.sh puts it in the image
//                                          as /usr/lib/nexus/update/factory.json): the updater's starting point.
//   register --manifest F --channel C      put an image's factory manifest in the channel as a release with no bundle
//                                          of its own, so the next release has a small bundle from exactly that image.
//   publish --tree T --version V --channel C --key K --notes FILE [--debs D] [--post F] [--full]
//                                          add release V to channel folder C: its manifest, the bundles from earlier
//                                          releases (only what changed) and the signed latest.json; --full also makes
//                                          one with everything, for machines the channel does not know. FILE: one
//                                          change per line, in Spanish, as people will read them in Ajustes.
// NEXUS's own packages (--debs D): every *+nexus*.deb in D (name and version read with dpkg-deb).
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { buildRelease, scanTree, sha256File, VERSION_RE, validManifest, type Manifest } from "../../core/src/update.ts";

const [cmd, ...rest] = process.argv.slice(2);
const opt = (name: string) => { const i = rest.indexOf(`--${name}`); return i >= 0 ? rest[i + 1] : undefined; };
const need = (name: string) => { const v = opt(name); if (!v) { console.error(`falta --${name}`); process.exit(2); } return v; };

function nexusDebs(dir: string | undefined) {
  if (!dir) return [];
  return fs.readdirSync(dir).filter((f) => /\+nexus[^_]*_[a-z0-9]+\.deb$/.test(f) && !f.includes("-dbgsym")).sort().map((f) => {
    const p = path.join(dir, f);
    const [pkg, version] = execFileSync("dpkg-deb", ["-f", p, "Package", "Version"]).toString().trim().split("\n").map((l) => l.replace(/^\w+: /, ""));
    return { path: p, package: pkg, version };
  });
}

if (cmd === "keygen") {
  const [priv, pub] = rest;
  if (!priv || !pub) { console.error("uso: keygen <private.pem> <public.pem>"); process.exit(2); }
  if (fs.existsSync(priv)) { console.error(`${priv} ya existe: no se sobrescribe una clave de firma`); process.exit(1); }
  const k = crypto.generateKeyPairSync("ed25519");
  fs.mkdirSync(path.dirname(priv), { recursive: true, mode: 0o700 });
  fs.writeFileSync(priv, k.privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600, flag: "wx" });
  fs.writeFileSync(pub, k.publicKey.export({ type: "spki", format: "pem" }));
  console.log(`clave pública en ${pub}`);
} else if (cmd === "factory") {
  const version = need("version");
  if (!VERSION_RE.test(version)) { console.error("la versión debe ser como 0.2.0"); process.exit(2); }
  const debs = nexusDebs(opt("debs")).map((d) => ({ package: d.package, version: d.version, sha256: sha256File(d.path), file: path.basename(d.path) }));
  const m: Manifest = { version, files: scanTree(need("tree")), debs };
  if (!validManifest(m)) { console.error("el árbol no forma un manifiesto válido"); process.exit(1); }
  const out = need("out");
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(m));
  console.log(`manifiesto de fábrica ${version}: ${m.files.length} archivos, ${debs.length} paquetes`);
} else if (cmd === "register") {
  const m = JSON.parse(fs.readFileSync(need("manifest"), "utf8"));
  if (!validManifest(m)) { console.error("ese manifiesto no es válido"); process.exit(1); }
  const dir = path.join(need("channel"), "releases", m.version);
  if (fs.existsSync(dir)) { console.error(`el canal ya tiene la versión ${m.version}`); process.exit(1); }
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(m));
  console.log(`versión ${m.version} registrada en el canal (${m.files.length} archivos): la próxima tendrá un paquete pequeño desde ella`);
} else if (cmd === "publish") {
  const notes = fs.readFileSync(need("notes"), "utf8").split("\n").map((l) => l.replace(/^[-*•]\s*/, "").trim()).filter(Boolean);
  if (!notes.length) { console.error("las notas de la versión están vacías"); process.exit(2); }
  const latest = buildRelease({
    tree: need("tree"), version: need("version"), channel: need("channel"), privateKeyPem: fs.readFileSync(need("key"), "utf8"),
    notes, debs: nexusDebs(opt("debs")), post: opt("post"), full: rest.includes("--full"),
    tar: (args, cwd) => { execFileSync("tar", args, { cwd, stdio: "inherit" }); },
  });
  for (const b of latest.bundles) console.log(`  ${b.file}  ${(b.size / 1e6).toFixed(1)} MB  (desde ${b.from === "*" ? "cualquier versión" : b.from})`);
  console.log(`NEXUS OS ${latest.version} publicada en ${opt("channel")}`);
} else {
  console.error("uso: nexus-release keygen|factory|register|publish … (ver la cabecera del archivo)");
  process.exit(2);
}
