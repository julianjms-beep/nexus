import QtQuick
import QtQuick.Window
import QtQuick.Controls
import QtQuick.Effects
import QtCore
import Qt.labs.folderlistmodel
import "../shell"

// Archivos, as in the concept: places with line icons (Mis archivos, Recientes, Favoritos, Descargas…, Papelera), big
// folders in a grid or a list, search below the open folder, picture thumbnails, a preview for text and pictures.
// Reading a folder is local (FolderListModel, follows changes live). Every change (bin, restore, delete for good, new
// folder, rename, favourites) goes through nexus-sessiond, which only works inside the home folder and never on hidden
// paths (core/src/files.ts); the Papelera is the standard freedesktop.org one.
Window {
    id: w
    visible: true
    width: 1040; height: 600
    minimumWidth: 760; minimumHeight: 460
    title: "Archivos"
    color: Theme.bg

    readonly property string home: decodeURIComponent(String(StandardPaths.writableLocation(StandardPaths.HomeLocation)).replace(/^file:\/\//, ""))
    property string mode: "folder"          // folder | recent | favorites | trash | search
    property string cwd: startFolder()
    property string fmPath: ""              // the folder the FolderListModel was last pointed at
    property string query: ""
    property var backStack: []
    property var fwdStack: []
    property bool listView: false
    property int sel: -1
    property string selectName: ""          // select this entry once the list arrives (new folder, "Mostrar en su carpeta")
    property var favs: ({})                 // path -> true
    property int trashCount: 0
    property bool loading: false
    property bool syncing: false
    property bool searchOpen: false
    property string preview: ""
    property string previewKind: ""
    property var previewEntry: null

    readonly property var textExt: ["txt", "md", "json", "conf", "sh", "ts", "js", "qml", "py", "log", "toml", "yaml", "yml", "csv", "ini", "xml", "html", "css"]
    readonly property var imageExt: ["png", "jpg", "jpeg", "gif", "svg", "webp", "bmp"]
    readonly property var audioExt: ["mp3", "ogg", "flac", "wav", "m4a", "opus"]
    readonly property var places: [
        { key: "home", label: "Mis archivos", icon: "folder", path: "" },
        { key: "recent", label: "Recientes", icon: "clock" },
        { key: "favorites", label: "Favoritos", icon: "star" },
        { key: "dl", label: "Descargas", icon: "download", path: "/Descargas" },
        { sep: true },
        { key: "docs", label: "Documentos", icon: "doc", path: "/Documentos" },
        { key: "pics", label: "Imágenes", icon: "image", path: "/Imágenes" },
        { key: "music", label: "Música", icon: "music", path: "/Música" },
        { sep: true },
        { key: "trash", label: "Papelera", icon: "trash" }
    ]

    // ---- small helpers
    function url(p) { return "file://" + p.split("/").map(encodeURIComponent).join("/") }
    function ext(name) { var i = name.lastIndexOf("."); return i > 0 ? name.slice(i + 1).toLowerCase() : "" }
    function kindOf(name, dir) {
        if (dir) return "folder"
        var x = ext(name)
        return imageExt.indexOf(x) >= 0 ? "image" : audioExt.indexOf(x) >= 0 ? "music" : "doc"
    }
    function tintOf(name, kind) {
        if (kind === "image") return "#1fae9f"
        if (kind === "music") return "#d9508f"
        var x = ext(name)
        return x === "pdf" ? "#e5534b" : ["xls", "xlsx", "csv", "ods"].indexOf(x) >= 0 ? "#2f9e5b" : ["ppt", "pptx", "odp", "key"].indexOf(x) >= 0 ? "#e58a2b" : "#4f7cff"
    }
    function parentOf(p) { var i = p.lastIndexOf("/"); return i > 0 ? p.slice(0, i) : "/" }
    function nameOf(p) { return p.slice(p.lastIndexOf("/") + 1) }
    function where(p) { var d = parentOf(p); return d === home ? "Mis archivos" : d.indexOf(home + "/") === 0 ? d.slice(home.length + 1).split("/").join(" › ") : d }
    function size(n) {
        if (n < 1024) return n + " B"
        var u = ["KB", "MB", "GB", "TB"], v = n / 1024, i = 0
        while (v >= 1024 && i < u.length - 1) { v /= 1024; i++ }
        return (v < 10 ? v.toFixed(1).replace(/\.0$/, "") : String(Math.round(v))).replace(".", ",") + " " + u[i]
    }
    function when(ms) {
        if (!ms) return ""
        var d = new Date(ms), n = new Date()
        var day0 = new Date(n.getFullYear(), n.getMonth(), n.getDate()).getTime(), hm = Qt.formatTime(d, "HH:mm")
        if (ms >= day0) return "Hoy, " + hm
        if (ms >= day0 - 86400000) return "Ayer, " + hm
        var mon = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sept", "oct", "nov", "dic"][d.getMonth()]
        return d.getDate() + " " + mon + (d.getFullYear() !== n.getFullYear() ? " " + d.getFullYear() : "")
    }
    function placeOn(pl) {
        if (pl.key === "recent" || pl.key === "favorites" || pl.key === "trash") return mode === pl.key
        return mode === "folder" && cwd === home + pl.path
    }
    function crumbs() {
        if (mode === "recent") return [{ label: "Recientes" }]
        if (mode === "favorites") return [{ label: "Favoritos" }]
        if (mode === "trash") return [{ label: "Papelera" }]
        if (mode === "search") return [{ label: "«" + query + "»" }]
        var out = [{ label: "Mis archivos", path: home }]
        if (cwd.indexOf(home + "/") === 0) {
            var parts = cwd.slice(home.length + 1).split("/"), p = home
            for (var i = 0; i < parts.length; i++) { p += "/" + parts[i]; out.push({ label: parts[i], path: p }) }
        } else if (cwd !== home) out = [{ label: cwd, path: cwd }]
        return out.length > 4 ? [{ label: "…", path: out[out.length - 4].path }].concat(out.slice(-3)) : out
    }
    function cur() {
        if (sel < 0 || sel >= items.count) return null
        var g = items.get(sel)
        return { name: g.name, path: g.path, dir: g.dir, size: g.size, mtime: g.mtime, tid: g.tid, deleted: g.deleted }
    }
    // "--folder=/home/…" on the command line (NEXUS AI's "Enséñame 2026"; nexus-sessiond checked it is in the home)
    function startFolder() {
        var a = Qt.application.arguments
        for (var i = 0; i < a.length; i++) if (String(a[i]).indexOf("--folder=/") === 0) return String(a[i]).slice(9).replace(/(.)\/+$/, "$1")
        return home
    }
    function view() { return listView ? list : grid }
    function focusView() { view().forceActiveFocus() }

    // ---- navigation (back/forward remember where you were, also Recientes, Papelera and searches)
    function state() { return { mode: mode, cwd: cwd, query: query } }
    function apply(s) {
        items.clear()                       // the old view's entries must not linger under the new mode (thumbnails…)
        loading = true
        mode = s.mode; cwd = s.cwd; query = s.query || ""
        syncing = true; searchField.text = mode === "search" ? query : ""; syncing = false
        if (mode !== "search") searchOpen = false
        sel = -1; closePreview(); reload()
    }
    function go(s) { backStack = backStack.concat([state()]); fwdStack = []; apply(s) }
    function openFolder(p) { go({ mode: "folder", cwd: p, query: "" }) }
    function openPlace(pl) {
        if (pl.key === "recent" || pl.key === "favorites" || pl.key === "trash") go({ mode: pl.key, cwd: cwd, query: "" })
        else openFolder(home + pl.path)
    }
    function goBack() {
        if (!backStack.length) return
        var b = backStack.slice(), s = b.pop()
        backStack = b; fwdStack = fwdStack.concat([state()]); apply(s)
    }
    function goFwd() {
        if (!fwdStack.length) return
        var f = fwdStack.slice(), s = f.pop()
        fwdStack = f; backStack = backStack.concat([state()]); apply(s)
    }
    function runSearch() {
        var q = searchField.text.trim()
        if (q) {
            if (mode === "search") { query = q; sel = -1; reload() }
            else go({ mode: "search", cwd: mode === "folder" ? cwd : home, query: q })
        } else if (mode === "search") goBack()
    }

    // ---- loading what the view shows
    function reload() {
        if (mode === "folder") {
            // compare paths, not URLs: Qt hands the folder back decoded ("Imágenes", not "Im%C3%A1genes")
            loading = true
            if (fmPath !== cwd) { fmPath = cwd; fm.folder = url(cwd) } else rebuild.restart()
            return
        }
        loading = true
        var want = mode + "|" + cwd + "|" + query
        var p = mode === "recent" ? "/files/recent" : mode === "favorites" ? "/files/favorites" : mode === "trash" ? "/files/trash"
              : "/files/search?in=" + encodeURIComponent(cwd) + "&q=" + encodeURIComponent(query)
        Session.request("GET", p, null, function(st, j) {
            if (w.mode + "|" + w.cwd + "|" + w.query !== want) return   // the person moved on meanwhile
            w.loading = false
            if (st !== 200 || !j) { w.fill([]); w.say(j && j.error ? j.error : "No se ha podido leer", "error"); return }
            w.fill(j.entries || [])
        })
    }
    function fill(listIn) {
        var keep = sel >= 0 && sel < items.count ? items.get(sel).path : ""
        items.clear()
        for (var i = 0; i < listIn.length; i++) {
            var e = listIn[i]
            items.append({ name: String(e.name), path: String(e.path), dir: !!e.dir, size: Number(e.size || 0), mtime: Number(e.mtime || 0), tid: String(e.id || ""), deleted: Number(e.deleted || 0) })
        }
        sel = -1
        for (var k = 0; k < items.count; k++) {
            var g = items.get(k)
            if ((selectName && g.name === selectName) || (!selectName && keep && g.path === keep)) { sel = k; view().positionViewAtIndex(k, GridView.Contain); break }
        }
        selectName = ""
        if (trashCount === 0 && mode === "trash") trashCount = items.count
    }
    function rebuildFromFolder() {
        var out = []
        for (var i = 0; i < fm.count; i++) {
            var d = fm.get(i, "fileModified")
            out.push({ name: fm.get(i, "fileName"), path: fm.get(i, "filePath"), dir: fm.get(i, "fileIsDir"), size: fm.get(i, "fileSize"), mtime: d ? d.getTime() : 0 })
        }
        loading = false
        fill(out)
    }
    function refreshMeta() {
        Session.request("GET", "/files/favorites", null, function(st, j) {
            if (st !== 200 || !j) return
            var m = {}; for (var i = 0; i < (j.entries || []).length; i++) m[j.entries[i].path] = true
            w.favs = m
        })
        Session.request("GET", "/files/trash", null, function(st, j) { if (st === 200 && j) w.trashCount = (j.entries || []).length })
    }

    // ---- actions (sessiond does the work and checks every path)
    function act(method, path, body, ok) {
        Session.request(method, path, body, function(st, j) {
            if (st === 200) { if (ok) ok(j || {}) }
            else w.say(j && j.error ? String(j.error) : st === 0 ? "NEXUS no responde ahora mismo" : "No se ha podido hacer", "error")
        })
    }
    function openItem(e) {
        if (!e) return
        if (mode === "trash") { say("Restaura «" + e.name + "» para abrirlo", "info"); return }
        if (e.dir) { openFolder(e.path); return }
        previewEntry = e
        var k = kindOf(e.name, false)
        if (k === "image") { previewKind = "image"; preview = url(e.path); return }
        if (textExt.indexOf(ext(e.name)) >= 0) {
            var x = new XMLHttpRequest()
            x.onreadystatechange = function() { if (x.readyState === XMLHttpRequest.DONE) { w.previewKind = "text"; w.preview = (x.responseText || "").slice(0, 20000) } }
            x.open("GET", url(e.path)); x.send(); return
        }
        previewKind = "none"; preview = ""
    }
    function closePreview() { previewKind = ""; preview = ""; previewEntry = null }
    function locate(e) { selectName = e.name; go({ mode: "folder", cwd: parentOf(e.path), query: "" }) }
    function trashItem(e) {
        act("POST", "/files/trash", { path: e.path }, function(j) {
            w.say("«" + e.name + "» está en la papelera", "info", { label: "Deshacer", run: function() { w.act("POST", "/files/restore", { id: j.id }, null) } })
        })
    }
    function restoreItem(e) { act("POST", "/files/restore", { id: e.tid }, function() { w.say("«" + e.name + "» ha vuelto a " + w.where(e.path), "info") }) }
    function deleteItem(e) {
        askDialog.start("¿Eliminar «" + e.name + "» para siempre?", "No se podrá recuperar.", "Eliminar", function() { w.act("POST", "/files/delete", { id: e.tid }, null) })
    }
    function emptyTrash() {
        askDialog.start("¿Vaciar la papelera?", trashCount === 1 ? "El elemento se borrará para siempre." : "Los " + trashCount + " elementos se borrarán para siempre.", "Vaciar",
                        function() { w.act("POST", "/files/empty", {}, function() { w.say("Papelera vacía", "info") }) })
    }
    function toggleFav(e) {
        var on = !favs[e.path]
        act("POST", "/files/favorites", { path: e.path, on: on }, function() { w.say(on ? "«" + e.name + "» está en Favoritos" : "Quitado de Favoritos", "info") })
    }
    function newFolder() {
        nameDialog.start("Nueva carpeta", "Crear", "Carpeta nueva", false, function(n) { w.act("POST", "/files/mkdir", { parent: w.cwd, name: n }, function(j) { w.selectName = w.nameOf(j.path) }) })
    }
    function renameItem(e) {
        nameDialog.start("Cambiar nombre", "Cambiar", e.name, !e.dir, function(n) { w.act("POST", "/files/rename", { path: e.path, name: n }, function(j) { w.selectName = w.nameOf(j.path) }) })
    }
    function menuFor(e) {
        if (!e) return mode === "folder" ? [["folder-plus", "Nueva carpeta…", function() { w.newFolder() }, false]] : []
        if (mode === "trash") return [["restore", "Restaurar", function() { w.restoreItem(e) }, false], ["trash", "Eliminar para siempre…", function() { w.deleteItem(e) }, true]]
        var m = [["open", e.dir ? "Abrir" : "Ver", function() { w.openItem(e) }, false]]
        if (mode !== "folder") m.push(["locate", "Mostrar en su carpeta", function() { w.locate(e) }, false])
        m.push(["star", favs[e.path] ? "Quitar de Favoritos" : "Añadir a Favoritos", function() { w.toggleFav(e) }, false])
        m.push(["rename", "Cambiar nombre…", function() { w.renameItem(e) }, false])
        m.push(["trash", "Mover a la papelera", function() { w.trashItem(e) }, true])
        return m
    }
    function showMenu(e, item, mx, my) {
        var p = item.mapToItem(w.contentItem, mx, my)
        ctx.items = menuFor(e)
        if (!ctx.items.length) return
        ctx.x = Math.min(p.x, w.width - ctx.width - 8); ctx.y = Math.min(p.y, w.height - ctx.implicitHeight - 8)
        ctx.open()
    }
    function say(text, kind, action) { toast.text = text; toast.kind = kind; toast.action = action || null; toast.shown = true; toastTimer.interval = kind === "error" ? 6000 : 5000; toastTimer.restart() }
    function key(ev) {
        var e = cur()
        if (ev.key === Qt.Key_Delete && e) { if (mode === "trash") deleteItem(e); else trashItem(e) }
        else if (ev.key === Qt.Key_F2 && e && mode !== "trash") renameItem(e)
        else if ((ev.key === Qt.Key_Return || ev.key === Qt.Key_Enter) && e) openItem(e)
        else if (ev.key === Qt.Key_Backspace) goBack()
        else if (ev.key === Qt.Key_Escape) { if (previewKind !== "") closePreview(); else sel = -1 }
        else if (ev.key === Qt.Key_Menu && e) showMenu(e, view(), 40, 40)
        else if ([Qt.Key_Left, Qt.Key_Right, Qt.Key_Up, Qt.Key_Down].indexOf(ev.key) >= 0 && items.count) {
            var cols = listView ? 1 : Math.max(1, Math.floor(grid.width / grid.cellWidth))
            var step = ev.key === Qt.Key_Left ? -1 : ev.key === Qt.Key_Right ? 1 : ev.key === Qt.Key_Up ? -cols : cols
            if (listView && (ev.key === Qt.Key_Left || ev.key === Qt.Key_Right)) return
            sel = sel < 0 ? 0 : Math.max(0, Math.min(items.count - 1, sel + step))
            view().positionViewAtIndex(sel, GridView.Contain)
        } else return
        ev.accepted = true
    }

    ListModel { id: items }
    FolderListModel {
        id: fm
        showDirsFirst: true
        showHidden: false
        showDotAndDotDot: false
        sortCaseSensitive: false
        onStatusChanged: if (status === FolderListModel.Ready) rebuild.restart()
        onCountChanged: rebuild.restart()
    }
    Timer { id: rebuild; interval: 60; onTriggered: if (w.mode === "folder" && fm.status === FolderListModel.Ready) w.rebuildFromFolder() }
    Timer { id: searchTimer; interval: 280; onTriggered: w.runSearch() }
    Connections {
        target: Session
        function onFilesChanged() { w.refreshMeta(); if (w.mode !== "folder") w.reload() }
        function onFoldersGone(paths) {
            for (var i = 0; i < paths.length; i++) {
                var g = String(paths[i])
                if (w.mode === "folder" && (w.cwd === g || w.cwd.indexOf(g + "/") === 0)) {
                    var up = g.slice(0, g.lastIndexOf("/")) || "/"
                    w.apply({ mode: "folder", cwd: up.length < w.home.length ? w.home : up, query: "" })
                    return
                }
            }
        }
        function onRevealRequested(p) { if (p && !(w.mode === "folder" && w.cwd === p)) w.openFolder(p); w.raise(); w.requestActivate() }
    }
    Shortcut { sequences: ["Ctrl+F"]; onActivated: { w.searchOpen = true; searchField.forceActiveFocus(); searchField.selectAll() } }
    Shortcut { sequences: ["Ctrl+Shift+N"]; enabled: w.mode === "folder"; onActivated: w.newFolder() }
    Shortcut { sequences: ["Alt+Left"]; onActivated: w.goBack() }
    Shortcut { sequences: ["Alt+Right"]; onActivated: w.goFwd() }
    Component.onCompleted: { reload(); refreshMeta(); focusView() }

    // ---- reusable bits
    component IconBtn: Rectangle {
        id: ib
        property string icon: ""
        property bool on: false
        property string tip: ""
        signal clicked()
        width: 36; height: 36; radius: 10
        color: on ? Theme.alpha(Theme.accent, Theme.dark ? 0.26 : 0.16) : iba.containsMouse && enabled ? Theme.hover : "transparent"
        opacity: enabled ? 1 : 0.35
        LineIcon { anchors.centerIn: parent; name: ib.icon; size: 20; color: ib.on ? (Theme.dark ? "#cfc8ff" : Theme.accent) : Theme.text }
        MouseArea { id: iba; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor; onClicked: ib.clicked() }
        ToolTip.visible: tip !== "" && iba.containsMouse
        ToolTip.text: tip
        ToolTip.delay: 600
    }
    component PillBtn: Rectangle {
        id: pb
        property string text: ""
        property bool danger: false
        property bool primary: false
        signal clicked()
        implicitWidth: pbt.implicitWidth + 32; height: 38; radius: 12
        color: primary ? (danger ? Theme.danger : Theme.accent) : pba.containsMouse ? Theme.hover : "transparent"
        border.width: primary ? 0 : 1
        border.color: danger ? Theme.alpha(Theme.danger, 0.6) : Theme.border
        Text { id: pbt; anchors.centerIn: parent; text: pb.text; color: pb.primary ? "white" : pb.danger ? Theme.danger : Theme.text; font.family: Theme.font; font.pixelSize: 14; font.weight: Font.DemiBold }
        MouseArea { id: pba; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor; onClicked: pb.clicked() }
    }
    component Glyph: Rectangle {      // a file that is not a folder or a picture: a coloured card with its line icon and type
        id: gl
        property string name: ""
        property string kind: "doc"
        property bool small: false
        width: small ? 28 : 66; height: small ? 28 : 80; radius: small ? 8 : 13
        gradient: Gradient {
            GradientStop { position: 0; color: Qt.lighter(w.tintOf(gl.name, gl.kind), 1.22) }
            GradientStop { position: 1; color: w.tintOf(gl.name, gl.kind) }
        }
        LineIcon { anchors.centerIn: parent; anchors.verticalCenterOffset: gl.small ? 0 : -7; name: gl.kind; color: "white"; size: gl.small ? 17 : 28; stroke: gl.small ? 2 : 1.8 }
        Text {
            visible: !gl.small
            anchors.horizontalCenter: parent.horizontalCenter; anchors.bottom: parent.bottom; anchors.bottomMargin: 9
            text: w.ext(gl.name).toUpperCase().slice(0, 4)
            color: Qt.rgba(1, 1, 1, 0.88); font.family: Theme.font; font.pixelSize: 10; font.weight: Font.Bold; font.letterSpacing: 0.8
        }
    }
    component Thumb: Item {           // a picture's own thumbnail with rounded corners (falls back to the glyph)
        id: th
        property string path: ""
        property string name: ""
        property bool small: false
        readonly property bool ready: img.status === Image.Ready
        Image {
            id: img
            anchors.fill: parent
            visible: false
            source: th.path !== "" ? w.url(th.path) : ""
            sourceSize: Qt.size(th.width * 2, th.height * 2)
            fillMode: Image.PreserveAspectCrop
            asynchronous: true
            cache: true
        }
        Rectangle { id: mask; anchors.fill: parent; radius: th.small ? 7 : 11; visible: false; layer.enabled: true }
        MultiEffect {
            anchors.fill: parent
            visible: th.ready
            source: img
            maskEnabled: true
            maskSource: mask
            maskThresholdMin: 0.5
            maskSpreadAtMin: 1.0
        }
        Rectangle { visible: th.ready; anchors.fill: parent; radius: th.small ? 7 : 11; color: "transparent"; border.color: Theme.border }
        Glyph { visible: !th.ready; anchors.centerIn: parent; name: th.name; kind: "image"; small: th.small }
    }

    // ---- sidebar
    Rectangle {
        id: side
        width: 232
        anchors.top: parent.top; anchors.bottom: parent.bottom
        color: Theme.dark ? "#0f1220" : "#f4f5fa"
        Rectangle { anchors.right: parent.right; width: 1; height: parent.height; color: Theme.border }
        // the selection is one pill that glides to the place you open (and fades when you are somewhere else)
        Rectangle {
            id: placePill
            readonly property Item at: { var n = placeRep.count; for (var i = 0; i < n; i++) { var it = placeRep.itemAt(i); if (it && it.on) return it } return null }
            property real lastY: 0
            x: placeCol.x; width: placeCol.width; height: 42; radius: 11
            y: at ? placeCol.y + at.y : lastY
            onYChanged: if (at) lastY = y
            opacity: at ? 1 : 0
            color: Theme.alpha(Theme.accent, Theme.dark ? 0.22 : 0.13)
            border.width: 1; border.color: Theme.alpha(Theme.accent, 0.35)
            Behavior on y { NumberAnimation { duration: Theme.ms(240); easing.type: Easing.OutCubic } }
            Behavior on opacity { NumberAnimation { duration: Theme.ms(160) } }
        }
        Column {
            id: placeCol
            x: 14; y: 16; width: parent.width - 28
            spacing: 2
            Repeater {
                id: placeRep
                model: w.places
                delegate: Item {
                    id: pi
                    required property var modelData
                    readonly property bool sep: !!modelData.sep
                    readonly property bool on: !sep && w.placeOn(modelData)
                    width: parent.width
                    height: sep ? 17 : 42
                    Rectangle { visible: pi.sep; anchors.verticalCenter: parent.verticalCenter; x: 10; width: parent.width - 20; height: 1; color: Theme.border }
                    Rectangle {
                        visible: !pi.sep
                        anchors.fill: parent
                        radius: 11
                        color: !pi.on && pma.containsMouse ? Theme.hover : "transparent"
                        Behavior on color { ColorAnimation { duration: Theme.ms(120) } }
                        LineIcon {
                            x: 13; anchors.verticalCenter: parent.verticalCenter
                            name: pi.modelData.icon || "folder"; size: 20
                            color: pi.on ? (Theme.dark ? "#cfc8ff" : Theme.accent) : Theme.dim
                        }
                        Text {
                            x: 45; anchors.verticalCenter: parent.verticalCenter
                            text: pi.modelData.label || ""
                            color: Theme.text; font.family: Theme.font; font.pixelSize: 15
                            font.weight: pi.on ? Font.DemiBold : Font.Normal
                        }
                        Text {
                            visible: pi.modelData.key === "trash" && w.trashCount > 0
                            anchors.right: parent.right; anchors.rightMargin: 14; anchors.verticalCenter: parent.verticalCenter
                            text: w.trashCount; color: Theme.faint; font.family: Theme.font; font.pixelSize: 13
                        }
                    }
                    MouseArea { id: pma; anchors.fill: parent; enabled: !pi.sep; hoverEnabled: true; cursorShape: Qt.PointingHandCursor; onClicked: { w.openPlace(pi.modelData); w.focusView() } }
                }
            }
        }
    }

    // ---- main area
    Item {
        id: main
        anchors.left: side.right; anchors.top: parent.top; anchors.bottom: parent.bottom
        anchors.right: w.previewKind !== "" ? pane.left : parent.right

        Item {
            id: bar
            width: parent.width; height: 62
            Row {
                id: nav
                x: 12; anchors.verticalCenter: parent.verticalCenter
                spacing: 2
                IconBtn { icon: "back"; enabled: w.backStack.length > 0; tip: "Atrás"; onClicked: w.goBack() }
                IconBtn { icon: "forward"; enabled: w.fwdStack.length > 0; tip: "Adelante"; onClicked: w.goFwd() }
            }
            Row {
                id: crumbRow
                anchors.left: nav.right; anchors.leftMargin: 10; anchors.verticalCenter: parent.verticalCenter
                width: Math.max(0, tools.x - x - 12)
                clip: true
                spacing: 6
                Repeater {
                    model: w.crumbs()
                    delegate: Row {
                        id: cr
                        required property var modelData
                        required property int index
                        readonly property bool last: index === w.crumbs().length - 1
                        spacing: 6
                        Text {
                            visible: cr.index > 0
                            anchors.verticalCenter: parent.verticalCenter
                            text: "›"; color: Theme.faint; font.family: Theme.font; font.pixelSize: 17
                        }
                        Text {
                            anchors.verticalCenter: parent.verticalCenter
                            text: cr.modelData.label
                            // the folder you are in shortens with "…" in a narrow window (never cut in half)
                            width: cr.last ? Math.max(0, Math.min(implicitWidth, crumbRow.width - cr.x - x)) : implicitWidth
                            elide: cr.last ? Text.ElideRight : Text.ElideNone
                            color: cr.last ? Theme.text : cma.containsMouse ? Theme.text : Theme.dim
                            font.family: Theme.font; font.pixelSize: cr.last ? 18 : 15
                            font.weight: cr.last ? Font.DemiBold : Font.Normal
                            MouseArea { id: cma; anchors.fill: parent; enabled: !cr.last && !!cr.modelData.path; hoverEnabled: true; cursorShape: Qt.PointingHandCursor; onClicked: w.openFolder(cr.modelData.path) }
                        }
                    }
                }
                Text {
                    visible: w.mode === "search"
                    anchors.verticalCenter: parent.verticalCenter
                    text: "en " + (w.cwd === w.home ? "Mis archivos" : w.nameOf(w.cwd))
                    color: Theme.dim; font.family: Theme.font; font.pixelSize: 15
                }
            }
            Row {
                id: tools
                anchors.right: parent.right; anchors.rightMargin: 14; anchors.verticalCenter: parent.verticalCenter
                spacing: 8
                PillBtn { visible: w.mode === "trash" && w.trashCount > 0; text: "Vaciar papelera"; danger: true; onClicked: w.emptyTrash() }
                IconBtn { visible: w.mode === "folder"; icon: "folder-plus"; tip: "Nueva carpeta (Ctrl+Mayús+N)"; onClicked: w.newFolder() }
                Rectangle {
                    width: views.width + 6; height: 42; radius: 12
                    color: Theme.dark ? Qt.rgba(1, 1, 1, 0.04) : Qt.rgba(0, 0, 0, 0.03)
                    border.color: Theme.border
                    Row {
                        id: views
                        anchors.centerIn: parent
                        spacing: 2
                        IconBtn { icon: "grid"; on: !w.listView; tip: "Cuadrícula"; onClicked: { w.listView = false; w.focusView() } }
                        IconBtn { icon: "list"; on: w.listView; tip: "Lista"; onClicked: { w.listView = true; w.focusView() } }
                    }
                }
                Rectangle {
                    id: searchBox
                    width: w.searchOpen ? Math.max(150, Math.min(240, main.width - 560)) : 42; height: 42; radius: 12
                    color: w.searchOpen ? Theme.card : "transparent"
                    border.color: searchField.activeFocus ? Theme.accent : w.searchOpen ? Theme.border : "transparent"
                    border.width: searchField.activeFocus ? 2 : 1
                    clip: true
                    Behavior on width { NumberAnimation { duration: 160; easing.type: Easing.OutCubic } }
                    LineIcon { x: 11; anchors.verticalCenter: parent.verticalCenter; name: "search"; size: 20; color: w.searchOpen ? Theme.dim : Theme.text }
                    MouseArea {
                        anchors.fill: parent; visible: !w.searchOpen; hoverEnabled: true; cursorShape: Qt.PointingHandCursor
                        onClicked: { w.searchOpen = true; searchField.forceActiveFocus() }
                    }
                    TextField {
                        id: searchField
                        visible: w.searchOpen
                        x: 36; width: parent.width - 40; height: parent.height
                        placeholderText: "Buscar aquí y dentro"
                        color: Theme.text; placeholderTextColor: Theme.faint
                        selectionColor: Theme.alpha(Theme.accent, 0.6); selectedTextColor: Theme.dark ? "white" : Theme.text
                        font.family: Theme.font; font.pixelSize: 14
                        background: null
                        leftPadding: 4; rightPadding: 6
                        onTextChanged: if (!w.syncing) searchTimer.restart()
                        Keys.onEscapePressed: { text = ""; w.searchOpen = false; w.runSearch(); w.focusView() }
                        Keys.onDownPressed: w.focusView()
                        onActiveFocusChanged: if (!activeFocus && text === "" && w.mode !== "search") w.searchOpen = false
                    }
                }
            }
        }

        GridView {
            id: grid
            visible: !w.listView
            anchors.top: bar.bottom; anchors.bottom: foot.top
            anchors.left: parent.left; anchors.right: parent.right
            anchors.leftMargin: 14; anchors.rightMargin: 14
            model: items
            cellWidth: Math.floor(width / Math.max(1, Math.floor(width / 148)))
            cellHeight: 160
            clip: true
            focus: true
            keyNavigationEnabled: false
            boundsBehavior: Flickable.StopAtBounds
            Keys.onPressed: (ev) => w.key(ev)
            ScrollBar.vertical: ScrollBar { policy: ScrollBar.AsNeeded }
            MouseArea {
                anchors.fill: parent; z: -1
                acceptedButtons: Qt.LeftButton | Qt.RightButton
                onClicked: (m) => { w.sel = -1; w.focusView(); if (m.button === Qt.RightButton) w.showMenu(null, grid, m.x, m.y) }
            }
            delegate: Item {
                id: tile
                required property int index
                required property string name
                required property string path
                required property bool dir
                readonly property string kind: w.kindOf(name, dir)
                readonly property bool picked: w.sel === index
                readonly property bool fav: !!w.favs[path]
                width: grid.cellWidth; height: grid.cellHeight
                Rectangle {
                    anchors.fill: parent; anchors.margins: 6
                    radius: 14
                    color: tile.picked ? Theme.alpha(Theme.accent, Theme.dark ? 0.22 : 0.14) : ta.containsMouse ? Theme.hover : "transparent"
                    border.width: tile.picked ? 1 : 0
                    border.color: Theme.alpha(Theme.accent, 0.55)
                }
                Item {
                    id: art
                    width: 104; height: 88
                    anchors.horizontalCenter: parent.horizontalCenter; y: 14
                    Image {
                        visible: tile.kind === "folder"
                        anchors.centerIn: parent
                        width: 90; height: 90
                        source: Qt.resolvedUrl("../icons/folder.svg"); sourceSize: Qt.size(180, 180); smooth: true
                    }
                    Thumb {
                        visible: tile.kind === "image"
                        anchors.centerIn: parent
                        width: 100; height: 78
                        path: tile.kind === "image" && w.mode !== "trash" ? tile.path : ""
                        name: tile.name
                    }
                    Glyph { visible: tile.kind === "doc" || tile.kind === "music"; anchors.centerIn: parent; name: tile.name; kind: tile.kind }
                    LineIcon {
                        visible: tile.fav
                        anchors.right: parent.right; anchors.top: parent.top; anchors.topMargin: 2
                        name: "star"; filled: true; size: 18; color: Theme.warn
                    }
                }
                Text {
                    anchors.horizontalCenter: parent.horizontalCenter
                    y: art.y + art.height + 8
                    width: parent.width - 20
                    horizontalAlignment: Text.AlignHCenter
                    text: tile.name
                    elide: Text.ElideMiddle; wrapMode: Text.Wrap; maximumLineCount: 2
                    color: Theme.text; font.family: Theme.font; font.pixelSize: 14
                    font.weight: tile.dir ? Font.DemiBold : Font.Medium
                }
                MouseArea {
                    id: ta
                    anchors.fill: parent; anchors.margins: 6
                    hoverEnabled: true
                    acceptedButtons: Qt.LeftButton | Qt.RightButton
                    onClicked: (m) => { w.sel = tile.index; w.focusView(); if (m.button === Qt.RightButton) w.showMenu(w.cur(), ta, m.x, m.y) }
                    onDoubleClicked: (m) => { if (m.button === Qt.LeftButton) w.openItem(w.cur()) }
                }
            }
        }

        ListView {
            id: list
            visible: w.listView
            anchors.top: bar.bottom; anchors.bottom: foot.top
            anchors.left: parent.left; anchors.right: parent.right
            anchors.leftMargin: 14; anchors.rightMargin: 14
            model: items
            clip: true
            keyNavigationEnabled: false
            boundsBehavior: Flickable.StopAtBounds
            Keys.onPressed: (ev) => w.key(ev)
            ScrollBar.vertical: ScrollBar { policy: ScrollBar.AsNeeded }
            readonly property real colA: 150
            readonly property real colB: w.mode === "trash" || w.mode === "recent" || w.mode === "search" || w.mode === "favorites" ? 200 : 90
            header: Item {
                width: list.width; height: 34
                Text { x: 54; anchors.verticalCenter: parent.verticalCenter; text: "Nombre"; color: Theme.faint; font.family: Theme.font; font.pixelSize: 12; font.weight: Font.DemiBold }
                Text { x: list.width - list.colB - list.colA - 14; anchors.verticalCenter: parent.verticalCenter; text: w.mode === "trash" ? "Borrado" : "Modificado"; color: Theme.faint; font.family: Theme.font; font.pixelSize: 12; font.weight: Font.DemiBold }
                Text { x: list.width - list.colB - 14; anchors.verticalCenter: parent.verticalCenter; text: list.colB > 100 ? (w.mode === "trash" ? "Estaba en" : "Carpeta") : "Tamaño"; color: Theme.faint; font.family: Theme.font; font.pixelSize: 12; font.weight: Font.DemiBold }
                Rectangle { anchors.bottom: parent.bottom; width: parent.width; height: 1; color: Theme.border }
            }
            delegate: Rectangle {
                id: row
                required property int index
                required property string name
                required property string path
                required property bool dir
                required property real size
                required property real mtime
                required property real deleted
                readonly property string kind: w.kindOf(name, dir)
                readonly property bool picked: w.sel === index
                width: list.width; height: 46; radius: 10
                color: picked ? Theme.alpha(Theme.accent, Theme.dark ? 0.22 : 0.14) : ra.containsMouse ? Theme.hover : "transparent"
                Item {
                    x: 12; width: 30; height: 30; anchors.verticalCenter: parent.verticalCenter
                    Image { visible: row.kind === "folder"; anchors.centerIn: parent; width: 30; height: 30; source: Qt.resolvedUrl("../icons/folder.svg"); sourceSize: Qt.size(60, 60) }
                    Thumb { visible: row.kind === "image"; anchors.centerIn: parent; width: 28; height: 28; small: true; path: row.kind === "image" && w.mode !== "trash" ? row.path : ""; name: row.name }
                    Glyph { visible: row.kind === "doc" || row.kind === "music"; anchors.centerIn: parent; small: true; name: row.name; kind: row.kind }
                }
                Text {
                    x: 54; anchors.verticalCenter: parent.verticalCenter
                    width: list.width - list.colA - list.colB - 54 - 28
                    text: row.name; elide: Text.ElideMiddle
                    color: Theme.text; font.family: Theme.font; font.pixelSize: 14; font.weight: row.dir ? Font.DemiBold : Font.Normal
                }
                LineIcon {
                    visible: !!w.favs[row.path]
                    x: list.width - list.colA - list.colB - 36; anchors.verticalCenter: parent.verticalCenter
                    name: "star"; filled: true; size: 15; color: Theme.warn
                }
                Text {
                    x: list.width - list.colB - list.colA - 14; anchors.verticalCenter: parent.verticalCenter
                    width: list.colA - 10; elide: Text.ElideRight
                    text: w.when(w.mode === "trash" ? row.deleted : row.mtime)
                    color: Theme.dim; font.family: Theme.font; font.pixelSize: 13
                }
                Text {
                    x: list.width - list.colB - 14; anchors.verticalCenter: parent.verticalCenter
                    width: list.colB; elide: Text.ElideMiddle
                    text: list.colB > 100 ? w.where(row.path) : row.dir ? "—" : w.size(row.size)
                    color: Theme.dim; font.family: Theme.font; font.pixelSize: 13
                }
                MouseArea {
                    id: ra
                    anchors.fill: parent
                    hoverEnabled: true
                    acceptedButtons: Qt.LeftButton | Qt.RightButton
                    onClicked: (m) => { w.sel = row.index; w.focusView(); if (m.button === Qt.RightButton) w.showMenu(w.cur(), ra, m.x, m.y) }
                    onDoubleClicked: (m) => { if (m.button === Qt.LeftButton) w.openItem(w.cur()) }
                }
            }
        }

        // what the view shows when there is nothing
        Column {
            visible: items.count === 0 && !w.loading
            anchors.centerIn: grid
            spacing: 12
            LineIcon {
                anchors.horizontalCenter: parent.horizontalCenter
                name: w.mode === "trash" ? "trash" : w.mode === "recent" ? "clock" : w.mode === "favorites" ? "star" : w.mode === "search" ? "search" : "folder"
                size: 44; stroke: 1.4; color: Theme.faint
            }
            Text {
                anchors.horizontalCenter: parent.horizontalCenter
                text: w.mode === "trash" ? "La papelera está vacía" : w.mode === "recent" ? "Aún no hay archivos recientes"
                    : w.mode === "favorites" ? "Aún no tienes favoritos" : w.mode === "search" ? "No hay nada que se llame así" : "Carpeta vacía"
                color: Theme.dim; font.family: Theme.font; font.pixelSize: 16; font.weight: Font.DemiBold
            }
            Text {
                anchors.horizontalCenter: parent.horizontalCenter
                visible: text !== ""
                text: w.mode === "favorites" ? "Pulsa con el botón derecho en un archivo o carpeta y elige «Añadir a Favoritos»."
                    : w.mode === "search" ? "Se busca en esta carpeta y en todas las de dentro." : ""
                color: Theme.faint; font.family: Theme.font; font.pixelSize: 13
            }
        }

        Item {
            id: foot
            anchors.bottom: parent.bottom
            width: parent.width; height: 34
            Rectangle { width: parent.width; height: 1; color: Theme.border }
            Text {
                x: 20; anchors.verticalCenter: parent.verticalCenter
                width: parent.width - 40; elide: Text.ElideMiddle
                color: Theme.faint; font.family: Theme.font; font.pixelSize: 12
                text: {
                    var e = w.sel >= 0 ? w.cur() : null
                    if (e) return e.name + (e.dir ? "" : " · " + w.size(e.size)) + " · " + w.when(w.mode === "trash" ? e.deleted : e.mtime)
                    if (w.loading) return "Cargando…"
                    return items.count === 1 ? "1 elemento" : items.count + " elementos"
                }
            }
        }

        // short messages (with "Deshacer" after binning something)
        Rectangle {
            id: toast
            property string text: ""
            property string kind: "info"
            property var action: null
            property bool shown: false
            anchors.horizontalCenter: parent.horizontalCenter
            y: parent.height - foot.height - height - 14
            height: 44; radius: 22
            width: Math.min(parent.width - 40, trow.implicitWidth + 40)
            color: kind === "error" ? (Theme.dark ? "#3b1823" : "#ffe5ea") : (Theme.dark ? "#1c2137" : "#ffffff")
            border.color: kind === "error" ? Theme.alpha(Theme.danger, 0.55) : Theme.border
            opacity: shown ? 1 : 0
            visible: opacity > 0
            Behavior on opacity { NumberAnimation { duration: 180 } }
            Row {
                id: trow
                anchors.centerIn: parent
                spacing: 16
                Text { anchors.verticalCenter: parent.verticalCenter; text: toast.text; color: Theme.text; font.family: Theme.font; font.pixelSize: 14 }
                Text {
                    visible: !!toast.action
                    anchors.verticalCenter: parent.verticalCenter
                    text: toast.action ? toast.action.label : ""
                    color: Theme.dark ? "#b9afff" : Theme.accent; font.family: Theme.font; font.pixelSize: 14; font.weight: Font.DemiBold
                    MouseArea { anchors.fill: parent; anchors.margins: -8; cursorShape: Qt.PointingHandCursor; onClicked: { var a = toast.action; toast.shown = false; if (a) a.run() } }
                }
            }
            Timer { id: toastTimer; onTriggered: toast.shown = false }
        }
    }

    // ---- preview (text and pictures)
    Rectangle {
        id: pane
        visible: w.previewKind !== ""
        anchors.right: parent.right; anchors.top: parent.top; anchors.bottom: parent.bottom
        width: Math.min(340, w.width * 0.32)
        color: Theme.dark ? "#0f1220" : "#f4f5fa"
        Rectangle { width: 1; height: parent.height; color: Theme.border }
        Text {
            x: 20; y: 20; width: parent.width - 70
            text: w.previewEntry ? w.previewEntry.name : ""
            elide: Text.ElideMiddle
            color: Theme.text; font.family: Theme.font; font.pixelSize: 16; font.weight: Font.DemiBold
        }
        Text {
            x: 20; y: 46; width: parent.width - 40
            text: w.previewEntry ? w.size(w.previewEntry.size) + " · " + w.when(w.previewEntry.mtime) : ""
            color: Theme.faint; font.family: Theme.font; font.pixelSize: 12
        }
        IconBtn { anchors.right: parent.right; anchors.rightMargin: 12; y: 14; icon: "close"; tip: "Cerrar (Esc)"; onClicked: { w.closePreview(); w.focusView() } }
        Image {
            visible: w.previewKind === "image"
            x: 20; y: 78; width: parent.width - 40; height: parent.height - 100
            fillMode: Image.PreserveAspectFit
            asynchronous: true
            source: w.previewKind === "image" ? w.preview : ""
            sourceSize: Qt.size(width * 2, height * 2)
        }
        ScrollView {
            visible: w.previewKind === "text"
            x: 20; y: 78; width: parent.width - 40; height: parent.height - 100
            TextArea { readOnly: true; text: w.preview; wrapMode: Text.Wrap; color: Theme.text; font.family: Theme.mono; font.pixelSize: 12; background: null }
        }
        Column {
            visible: w.previewKind === "none"
            anchors.centerIn: parent
            spacing: 12
            Glyph { anchors.horizontalCenter: parent.horizontalCenter; name: w.previewEntry ? w.previewEntry.name : ""; kind: w.previewEntry ? w.kindOf(w.previewEntry.name, false) : "doc" }
            Text { anchors.horizontalCenter: parent.horizontalCenter; text: "Sin vista previa"; color: Theme.faint; font.family: Theme.font; font.pixelSize: 13 }
        }
    }

    // ---- right-click menu
    Popup {
        id: ctx
        property var items: []
        parent: w.contentItem
        width: 232
        padding: 6
        modal: false
        focus: true
        closePolicy: Popup.CloseOnEscape | Popup.CloseOnPressOutside
        background: Rectangle { radius: 14; color: Theme.dark ? "#1a1e31" : "#ffffff"; border.color: Theme.border }
        contentItem: Column {
            spacing: 2
            Repeater {
                model: ctx.items
                delegate: Rectangle {
                    id: mi
                    required property var modelData
                    width: 220; height: 38; radius: 9
                    color: mia.containsMouse ? (mi.modelData[3] ? Theme.alpha(Theme.danger, 0.14) : Theme.hover) : "transparent"
                    LineIcon { x: 10; anchors.verticalCenter: parent.verticalCenter; name: mi.modelData[0]; size: 18; color: mi.modelData[3] ? Theme.danger : Theme.dim }
                    Text { x: 38; anchors.verticalCenter: parent.verticalCenter; text: mi.modelData[1]; color: mi.modelData[3] ? Theme.danger : Theme.text; font.family: Theme.font; font.pixelSize: 14 }
                    MouseArea { id: mia; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor; onClicked: { var run = mi.modelData[2]; ctx.close(); run(); } }
                }
            }
        }
        onClosed: w.focusView()
    }

    // ---- "Nueva carpeta" / "Cambiar nombre"
    Popup {
        id: nameDialog
        property string title: ""
        property string okText: ""
        property var done: null
        parent: Overlay.overlay
        anchors.centerIn: parent
        width: 400
        padding: 22
        modal: true
        dim: true
        focus: true
        background: Rectangle { radius: 18; color: Theme.dark ? "#161a2b" : "#ffffff"; border.color: Theme.border }
        Overlay.modal: Rectangle { color: Qt.rgba(0, 0, 0, 0.35) }
        function start(t, ok, initial, keepExt, cb) {
            title = t; okText = ok; done = cb
            nameField.text = initial
            open()
            nameField.forceActiveFocus()
            var dot = initial.lastIndexOf(".")
            if (keepExt && dot > 0) nameField.select(0, dot); else nameField.selectAll()
        }
        function accept() { var n = nameField.text.trim(); if (!n) return; var cb = done; close(); if (cb) cb(n) }
        contentItem: Column {
            spacing: 16
            Text { text: nameDialog.title; color: Theme.text; font.family: Theme.font; font.pixelSize: 18; font.weight: Font.DemiBold }
            TextField {
                id: nameField
                width: 356
                color: Theme.text; placeholderTextColor: Theme.faint
                selectionColor: Theme.alpha(Theme.accent, 0.6); selectedTextColor: Theme.dark ? "white" : Theme.text
                font.family: Theme.font; font.pixelSize: 15
                leftPadding: 14; rightPadding: 14
                background: Rectangle { implicitHeight: 44; radius: 12; color: Theme.card; border.color: nameField.activeFocus ? Theme.accent : Theme.border; border.width: nameField.activeFocus ? 2 : 1 }
                onAccepted: nameDialog.accept()
            }
            Row {
                anchors.right: parent.right
                spacing: 10
                PillBtn { text: "Cancelar"; onClicked: nameDialog.close() }
                PillBtn { text: nameDialog.okText; primary: true; onClicked: nameDialog.accept() }
            }
        }
        onClosed: w.focusView()
    }

    // ---- "¿Vaciar la papelera?" / "¿Eliminar para siempre?"
    Popup {
        id: askDialog
        property string title: ""
        property string body: ""
        property string okText: ""
        property var done: null
        parent: Overlay.overlay
        anchors.centerIn: parent
        width: 420
        padding: 22
        modal: true
        dim: true
        focus: true
        background: Rectangle { radius: 18; color: Theme.dark ? "#161a2b" : "#ffffff"; border.color: Theme.border }
        Overlay.modal: Rectangle { color: Qt.rgba(0, 0, 0, 0.35) }
        function start(t, b, ok, cb) { title = t; body = b; okText = ok; done = cb; open(); cancelBtn.forceActiveFocus() }
        contentItem: Column {
            spacing: 10
            Text { width: 376; wrapMode: Text.Wrap; text: askDialog.title; color: Theme.text; font.family: Theme.font; font.pixelSize: 18; font.weight: Font.DemiBold }
            Text { width: 376; wrapMode: Text.Wrap; text: askDialog.body; color: Theme.dim; font.family: Theme.font; font.pixelSize: 14; bottomPadding: 10 }
            Row {
                anchors.right: parent.right
                spacing: 10
                PillBtn { id: cancelBtn; text: "Cancelar"; onClicked: askDialog.close() }
                PillBtn { text: askDialog.okText; primary: true; danger: true; onClicked: { var cb = askDialog.done; askDialog.close(); if (cb) cb() } }
            }
        }
        onClosed: w.focusView()
    }
}
