import QtQuick
import QtQuick.Window
import QtQuick.Controls
import "../shell"

// Conexiones (NEXUS Connect): connect online services (GoHighLevel, Wiwink, a webhook) and see, before connecting,
// what each one can do, what it can watch, the permissions it needs and which data goes where.
// The keys are typed here once and go to the Engine (core/src/connect.ts), which tests them against the service and keeps
// them in a 0600 file of its own user. Nothing here ever receives a key back: GET /connect has no secrets.
// Only rules the person creates in Automatizaciones can change data in a service.
// «＋ Añadir conexión» (core/src/connect-custom.ts): the person adds any other service as a description (address, how the
// key is sent, actions, lists to watch), typed by hand or drafted by NEXUS AI from the service's official docs. The editor
// works on a plain copy; the Engine checks it again on save and forgets the key if the address changes.
Window {
    id: w
    visible: true
    width: 1080; height: 720
    minimumWidth: 860; minimumHeight: 540
    title: "Conexiones"
    color: Theme.bg

    property var items: []
    property bool loaded: false
    property string loadErr: ""
    property string selId: ""
    readonly property var sel: { for (var i = 0; i < items.length; i++) if (items[i].id === selId) return items[i]; return null }
    property bool editing: false        // the key form is open (not connected yet, or "Cambiar la clave")
    property var vals: ({})             // what the person types, by field key; cleared after each attempt
    property int formGen: 0             // a new number rebuilds the fields empty
    property bool busy: false
    property string msg: ""
    property bool msgOk: false
    property bool confirmOff: false
    // «＋ Añadir conexión»
    property string mode: ""            // "" = one service, "new" = how to add one, "edit" = the description form
    property var ed: null               // the description being edited (a plain object, changed in place while typing)
    property int edGen: 0               // a new number rebuilds the editor's lists (a row added or removed)
    property string edAuth: "bearer"
    property string edBase: ""
    property string edTitle: ""
    property string edErr: ""
    property string draftInfo: ""
    property bool drafting: false
    property int draftSecs: 0
    property string askService: ""
    property string askNotes: ""
    property bool confirmDel: false

    function cap(s) { s = String(s || ""); return s.charAt(0).toUpperCase() + s.slice(1) }
    function since(iso) {
        if (!iso) return ""
        var t = new Date(iso)
        return t.toLocaleDateString(Qt.locale("es_ES"), "d MMM yyyy") + ", " + t.toLocaleTimeString(Qt.locale("es_ES"), "HH:mm")
    }

    function load() {
        Session.request("GET", "/connect", null, function(st, j) {
            if (st !== 200 || !j) { w.loadErr = st === 502 || st === 0 ? "El motor de NEXUS no responde ahora mismo. Vuelve a probar en un momento." : "No se ha podido cargar (error " + st + ")."; w.loaded = true; return }
            w.loadErr = ""; w.items = j.connectors || []; w.loaded = true
            if (w.selId && !w.sel) w.selId = ""
            if (!w.selId && w.items.length) w.select(w.items[0].id)
        })
    }
    function select(id) { if (mode !== "") closeEditor(); selId = id; msg = ""; confirmOff = false; confirmDel = false; resetForm(); var c = sel; editing = !!c && !c.connected }
    function resetForm() { vals = ({}); formGen++ }
    function setVal(k, v) { var o = vals; o[k] = v; vals = o }
    function connectNow() {
        var c = sel
        if (!c || busy) return
        busy = true; msg = ""; confirmOff = false
        var body = { values: {} }
        for (var i = 0; i < c.fields.length; i++) body.values[c.fields[i].key] = String(vals[c.fields[i].key] || "").trim()
        var id = c.id
        Session.request("POST", "/connect/" + id, body, function(st, j) {
            w.busy = false
            w.resetForm()   // the key leaves this window as soon as the Engine has answered
            if (st === 200 && j && j.connected) { w.editing = false; w.msgOk = true; w.msg = "Conectado: " + (j.account || "la clave funciona") + "." }
            else { w.msgOk = false; w.msg = w.cap(j && j.error ? j.error : st === 502 ? "el motor de NEXUS no responde" : "no se ha podido conectar (error " + st + ")") + "." }
            w.load()
        })
    }
    function testNow() {
        var c = sel
        if (!c || busy) return
        busy = true; msg = ""
        Session.request("POST", "/connect/" + c.id + "/test", {}, function(st, j) {
            w.busy = false
            if (st === 200 && j && j.ok) { w.msgOk = true; w.msg = "Funciona: " + (j.account || "la clave sigue siendo válida") + "." }
            else { w.msgOk = false; w.msg = w.cap(j && j.error ? j.error : "no se ha podido comprobar (error " + st + ")") + "." }
        })
    }
    function disconnect() {
        var c = sel
        if (!c || busy) return
        if (!confirmOff) { confirmOff = true; offReset.restart(); return }
        confirmOff = false; busy = true; msg = ""
        Session.request("DELETE", "/connect/" + c.id, null, function(st, j) {
            w.busy = false
            if (st === 200) { w.msgOk = true; w.msg = c.name + " desconectado: la clave se ha borrado del equipo."; w.editing = true }
            else { w.msgOk = false; w.msg = w.cap(j && j.error ? j.error : "no se ha podido (error " + st + ")") + "." }
            w.load()
        })
    }

    // ---- «＋ Añadir conexión»
    function usd(v) { var n = Number(v) || 0; return (n < 0.01 ? "menos de 0,01" : n.toFixed(2).replace(".", ",")) + " US$" }
    function hostOf(u) { var m = /^https:\/\/([^\/?#\s]+)/.exec(String(u || "")); return m ? m[1] : "" }
    function prettyJson(b) { try { return JSON.stringify(JSON.parse(b), null, 2) } catch (err) { return String(b || "") } }
    function blankOp() { return { name: "", description: "", method: "GET", path: "/", body: "", labels: {}, paramsText: "" } }
    function blankTr() { return { name: "", description: "", path: "/", list: "", idField: "id", labelField: "name", fieldsText: "", every: 15, newestFirst: true } }
    function prepare(sp) {
        var e = { id: sp.id || "", name: sp.name || "", description: sp.description || "", docs: sp.docs || "", base: sp.base || "https://",
                  auth: { kind: (sp.auth && sp.auth.kind) || "bearer", name: (sp.auth && sp.auth.name) || "" }, keyHelp: sp.keyHelp || "", test: sp.test || "/",
                  operations: [], triggers: [], notices: sp.notices || [], sources: sp.sources || [], by: sp.by || "persona" }
        var ops = sp.operations || []
        for (var i = 0; i < ops.length; i++) {
            var o = ops[i], labels = {}, keys = [], ps = o.params || []
            for (var j = 0; j < ps.length; j++) { labels[ps[j].key] = ps[j].label; keys.push(ps[j].key + (ps[j].required ? "*" : "")) }
            e.operations.push({ name: o.name || "", description: o.description || "", method: o.method || "GET", path: o.path || "/", body: o.body ? prettyJson(o.body) : "", labels: labels, paramsText: keys.join(", ") })
        }
        var trs = sp.triggers || []
        for (var k = 0; k < trs.length; k++) {
            var t = trs[k]
            var extra = (t.fields || []).filter(function(f) { return f !== t.idField && f !== t.labelField })
            e.triggers.push({ name: t.name || "", description: t.description || "", path: t.path || "/", list: t.list || "", idField: t.idField || "id", labelField: t.labelField || "", fieldsText: extra.join(", "), every: t.every || 15, newestFirst: t.newestFirst !== false })
        }
        return e
    }
    function openEditor(e, title) { ed = e; edAuth = e.auth.kind; edBase = e.base; edTitle = title; edErr = ""; edGen++; mode = "edit" }
    // The form → the description the Engine checks. Placeholders used in a path or body but not listed are added (required).
    function toSpec() {
        var e = ed
        var out = { name: e.name, description: e.description, docs: e.docs, base: e.base, auth: { kind: e.auth.kind, name: e.auth.name }, keyHelp: e.keyHelp, test: e.test,
                    operations: [], triggers: [], notices: e.notices, sources: e.sources, by: e.by }
        if (e.id) out.id = e.id
        for (var i = 0; i < e.operations.length; i++) {
            var o = e.operations[i], params = [], seen = {}
            var parts = String(o.paramsText || "").split(",")
            for (var j = 0; j < parts.length; j++) {
                var raw = parts[j].trim(); if (!raw) continue
                var req = raw.charAt(raw.length - 1) === "*"
                var key = (req ? raw.slice(0, -1) : raw).trim()
                if (seen[key]) continue
                seen[key] = true; params.push({ key: key, label: o.labels[key] || "", required: req })
            }
            var body = o.method === "GET" || o.method === "DELETE" ? "" : String(o.body || "")
            var used = (String(o.path || "") + " " + body).match(/\{\{\s*([a-z][a-z0-9_]*)\s*\}\}/g) || []
            for (var u = 0; u < used.length; u++) {
                var k2 = used[u].replace(/[{}\s]/g, "")
                if (!seen[k2]) { seen[k2] = true; params.push({ key: k2, label: o.labels[k2] || "", required: true }) }
            }
            out.operations.push({ name: o.name, description: o.description, method: o.method, path: o.path, body: body, params: params })
        }
        for (var k = 0; k < e.triggers.length; k++) {
            var t = e.triggers[k]
            out.triggers.push({ name: t.name, description: t.description, path: t.path, list: t.list, idField: t.idField, labelField: t.labelField,
                                fields: String(t.fieldsText || "").split(",").map(function(f) { return f.trim() }).filter(function(f) { return f !== "" }),
                                every: parseInt(t.every, 10) || 15, newestFirst: t.newestFirst })
        }
        return out
    }
    function setEd(k, v) { if (ed) ed[k] = v }
    function setOp(i, k, v) { if (ed && ed.operations[i]) ed.operations[i][k] = v }
    function setTr(i, k, v) { if (ed && ed.triggers[i]) ed.triggers[i][k] = v }
    function addOp() { ed.operations.push(blankOp()); edGen++ }
    function addTr() { ed.triggers.push(blankTr()); edGen++ }
    function dropOp(i) { ed.operations.splice(i, 1); edGen++ }
    function dropTr(i) { ed.triggers.splice(i, 1); edGen++ }
    function startNew() { mode = "new"; edErr = ""; draftInfo = ""; msg = ""; confirmDel = false }
    function closeEditor() { mode = ""; ed = null; edErr = ""; draftInfo = "" }
    function manual() {
        draftInfo = ""
        var e = prepare({ name: askService.trim(), base: "https://", auth: { kind: "bearer" }, test: "/", operations: [{ name: "", method: "GET", path: "/" }], triggers: [] })
        e.operations[0] = blankOp()
        openEditor(e, "Añadir una conexión")
    }
    function draftNow() {
        var name = askService.trim()
        if (!name || drafting) return
        drafting = true; edErr = ""; draftSecs = 0
        Session.request("POST", "/connect-custom/draft", { service: name, notes: askNotes.trim() }, function(st, j) {
            w.drafting = false
            if (st === 200 && j && j.spec) {
                w.draftInfo = "Preparada por NEXUS AI leyendo la documentación de " + name + " · ha costado " + w.usd(j.usd) + (j.searches ? " · " + j.searches + (j.searches === 1 ? " búsqueda" : " búsquedas") : "") + ". Revísala antes de guardarla."
                w.openEditor(w.prepare(j.spec), "Revisa la conexión con " + (j.spec.name || name))
                if (j.problem) w.edErr = "Antes de guardarla, arregla esto: " + j.problem + "."
                return
            }
            var why = j && j.error ? String(j.error) : ""
            w.edErr = why === "not_configured" ? "NEXUS AI necesita tu clave de Claude: ponla en Ajustes → NEXUS AI. También puedes rellenarla a mano."
                    : why === "no_draft" ? "NEXUS AI no ha encontrado una documentación de API clara para «" + name + "». Prueba con el nombre exacto del servicio o rellénala a mano."
                    : why === "timeout" ? "NEXUS AI ha tardado demasiado leyendo la documentación. Vuelve a probar o rellénala a mano."
                    : why === "offline" ? "Sin conexión con Claude. Revisa Internet y vuelve a probar."
                    : why === "auth" ? "Claude no acepta tu clave: revísala en Ajustes → NEXUS AI."
                    : why === "rate_limit" ? "Claude pide ir más despacio: vuelve a probar en un minuto."
                    : why === "refusal" ? "NEXUS AI no ha querido preparar esta conexión."
                    : w.cap(why || ("no se ha podido preparar (error " + st + ")")) + "."
            if (j && j.usd) w.edErr += " Ha costado " + w.usd(j.usd) + "."
        })
    }
    function saveEd() {
        if (busy || !ed) return
        busy = true; edErr = ""
        var wasNew = !ed.id
        Session.request("POST", "/connect-custom", { spec: toSpec() }, function(st, j) {
            w.busy = false
            if (st === 200 && j && j.id) {
                w.closeEditor()
                w.selId = j.id; w.confirmOff = false; w.resetForm(); w.editing = !j.connected
                w.msgOk = true
                w.msg = j.keyReset ? "Guardada. Como has cambiado la dirección o cómo se envía la clave, la clave anterior se ha borrado: vuelve a ponerla."
                      : wasNew ? (j.fields && j.fields.length ? "Guardada. Ahora pon tu clave para conectarla." : "Guardada. Pulsa Conectar para probarla.") : "Cambios guardados."
                w.load()
            } else { w.edErr = w.cap(j && j.error ? j.error : st === 502 ? "el motor de NEXUS no responde" : "no se ha podido guardar (error " + st + ")") + "." }
        })
    }
    function editSel() {
        var c = sel
        if (!c || !c.custom || busy) return
        busy = true
        Session.request("GET", "/connect-custom/" + c.id, null, function(st, j) {
            w.busy = false
            if (st === 200 && j && j.spec) { w.draftInfo = ""; w.openEditor(w.prepare(j.spec), "Editar «" + j.spec.name + "»") }
            else { w.msgOk = false; w.msg = w.cap(j && j.error ? j.error : "no se ha podido abrir (error " + st + ")") + "." }
        })
    }
    function removeSel() {
        var c = sel
        if (!c || !c.custom || busy) return
        if (!confirmDel) { confirmDel = true; delReset.restart(); return }
        confirmDel = false; busy = true
        Session.request("DELETE", "/connect-custom/" + c.id, null, function(st, j) {
            w.busy = false
            if (st === 200) { w.selId = ""; w.load() }
            else { w.msgOk = false; w.msg = w.cap(j && j.error ? j.error : "no se ha podido borrar (error " + st + ")") + "." }
        })
    }

    Component.onCompleted: load()
    Connections { target: Session; function onConnectChanged() { w.load() } }
    Timer { id: offReset; interval: 3500; onTriggered: w.confirmOff = false }
    Timer { id: delReset; interval: 3500; onTriggered: w.confirmDel = false }
    Timer { interval: 1000; repeat: true; running: w.drafting; onTriggered: w.draftSecs++ }

    // ------------------------------------------------------------------ small building blocks
    component Btn: Rectangle {
        id: btn
        property string label: ""
        property bool primary: false
        property bool danger: false
        property bool enabled_: true
        signal clicked()
        width: btnText.implicitWidth + 32; height: 38; radius: 12
        opacity: enabled_ ? 1 : 0.5
        color: primary ? (btnArea.pressed ? Qt.darker(Theme.accent, 1.2) : Theme.accent)
             : danger ? (btnArea.containsMouse ? Theme.alpha(Theme.danger, 0.16) : "transparent")
             : (btnArea.containsMouse ? Theme.hover : Theme.card2)
        border.color: primary ? "transparent" : danger ? Theme.alpha(Theme.danger, 0.55) : Theme.border
        Text { id: btnText; anchors.centerIn: parent; text: btn.label; color: btn.primary ? "#ffffff" : btn.danger ? Theme.danger : Theme.text; font.family: Theme.font; font.pixelSize: 14; font.weight: btn.primary ? Font.DemiBold : Font.Normal }
        MouseArea { id: btnArea; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor; onClicked: if (btn.enabled_) btn.clicked() }
    }
    component Field: TextField {
        id: fld
        property bool mono: false
        color: Theme.text; placeholderTextColor: Theme.faint
        selectByMouse: true; selectionColor: Theme.alpha(Theme.accent, 0.45); selectedTextColor: Theme.text
        font.family: mono ? Theme.mono : Theme.font; font.pixelSize: 14
        leftPadding: 14; rightPadding: 14
        background: Rectangle { implicitHeight: 42; radius: 12; color: Theme.card; border.color: fld.activeFocus ? Theme.accent : Theme.border; border.width: fld.activeFocus ? 2 : 1 }
    }
    component Section: Text { color: Theme.text; font.family: Theme.font; font.pixelSize: 16; font.weight: Font.DemiBold; topPadding: 10 }
    component Tag: Rectangle {
        id: tag
        property string label: ""
        property color tint: Theme.dim
        width: tagText.implicitWidth + 16; height: 22; radius: 11
        color: Theme.alpha(tint, 0.14); border.color: Theme.alpha(tint, 0.4)
        Text { id: tagText; anchors.centerIn: parent; text: tag.label; color: tag.tint; font.family: Theme.font; font.pixelSize: 11; font.weight: Font.DemiBold }
    }
    component Chip: Rectangle {
        id: chip
        property string label: ""
        property bool on: false
        signal clicked()
        width: chipText.implicitWidth + 24; height: 32; radius: 10
        color: on ? Theme.alpha(Theme.accent, 0.18) : chipArea.containsMouse ? Theme.hover : Theme.card2
        border.color: on ? Theme.accent : Theme.border
        Text { id: chipText; anchors.centerIn: parent; text: chip.label; color: chip.on ? Theme.accent : Theme.text; font.family: Theme.font; font.pixelSize: 13; font.weight: chip.on ? Font.DemiBold : Font.Normal }
        MouseArea { id: chipArea; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor; onClicked: chip.clicked() }
    }
    component Lbl: Text { color: Theme.dim; font.family: Theme.font; font.pixelSize: 13; font.weight: Font.DemiBold; topPadding: 4 }
    component Hint: Text { color: Theme.faint; font.family: Theme.font; font.pixelSize: 12; wrapMode: Text.Wrap; lineHeight: 1.2 }
    component Area: Rectangle {
        id: area
        property alias text: areaEdit.text
        property string placeholder: ""
        signal edited(string text)
        height: Math.max(96, areaEdit.contentHeight + 26); radius: 12
        color: Theme.card; border.color: areaEdit.activeFocus ? Theme.accent : Theme.border; border.width: areaEdit.activeFocus ? 2 : 1
        TextEdit {
            id: areaEdit
            x: 14; y: 12; width: parent.width - 28
            wrapMode: TextEdit.Wrap; selectByMouse: true
            color: Theme.text; selectionColor: Theme.alpha(Theme.accent, 0.45); selectedTextColor: Theme.text
            font.family: Theme.mono; font.pixelSize: 13
            onTextChanged: area.edited(text)
        }
        Text { visible: areaEdit.text === "" && !areaEdit.activeFocus; x: 14; y: 12; width: parent.width - 28; wrapMode: Text.Wrap; text: area.placeholder; color: Theme.faint; font.family: Theme.mono; font.pixelSize: 13 }
    }
    component Badge: Rectangle {
        id: badge
        property var conn: null
        width: 40; height: 40; radius: 12
        color: conn && conn.color ? conn.color : Theme.accent
        Text { anchors.centerIn: parent; text: String(badge.conn && badge.conn.name || "?").charAt(0).toUpperCase(); color: "#ffffff"; font.family: Theme.font; font.pixelSize: Math.round(badge.height * 0.45); font.weight: Font.Bold }
    }

    // ------------------------------------------------------------------ list of services
    Rectangle {
        id: side
        width: Math.round(Math.min(380, Math.max(280, w.width * 0.34))); height: parent.height
        color: Theme.card
        Rectangle { anchors.right: parent.right; width: 1; height: parent.height; color: Theme.border }
        Column {
            id: head
            x: 20; y: 22; width: parent.width - 40
            spacing: 6
            Row {
                spacing: 12
                Image { width: 34; height: 34; sourceSize: Qt.size(68, 68); source: Qt.resolvedUrl("../icons/app-connect.svg"); anchors.verticalCenter: parent.verticalCenter }
                Text { text: "Conexiones"; color: Theme.text; font.family: Theme.font; font.pixelSize: 22; font.weight: Font.DemiBold; anchors.verticalCenter: parent.verticalCenter }
            }
            Text { width: parent.width; wrapMode: Text.Wrap; lineHeight: 1.2; topPadding: 2; bottomPadding: 8; color: Theme.dim; font.family: Theme.font; font.pixelSize: 13
                   text: "Conecta tus servicios para usarlos en Automatizaciones. Las claves se quedan en el motor de NEXUS: ninguna app vuelve a verlas." }
        }
        ListView {
            id: list
            anchors.top: head.bottom; anchors.topMargin: 12; anchors.bottom: addBtn.top; anchors.bottomMargin: 10
            x: 12; width: parent.width - 24
            clip: true; spacing: 6
            model: w.items
            ScrollBar.vertical: ScrollBar { policy: ScrollBar.AsNeeded }
            delegate: Rectangle {
                id: card
                required property var modelData
                readonly property bool picked: w.selId === modelData.id && w.mode === ""
                width: list.width; height: 74; radius: 14
                color: picked ? Theme.alpha(Theme.accent, 0.14) : cardArea.containsMouse ? Theme.hover : "transparent"
                border.color: picked ? Theme.alpha(Theme.accent, 0.5) : "transparent"
                MouseArea { id: cardArea; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor; onClicked: w.select(card.modelData.id) }
                Badge { x: 14; anchors.verticalCenter: parent.verticalCenter; conn: card.modelData }
                Column {
                    x: 66; anchors.verticalCenter: parent.verticalCenter; width: parent.width - 80; spacing: 4
                    Text { text: card.modelData.name; color: Theme.text; font.family: Theme.font; font.pixelSize: 15; font.weight: Font.DemiBold; elide: Text.ElideRight; width: parent.width }
                    Row {
                        spacing: 6
                        Rectangle { width: 8; height: 8; radius: 4; anchors.verticalCenter: parent.verticalCenter; color: card.modelData.connected ? Theme.good : Theme.faint }
                        Text { text: card.modelData.connected ? (card.modelData.account || "Conectado") : "Sin conectar"; color: Theme.dim; font.family: Theme.font; font.pixelSize: 12; elide: Text.ElideRight; width: card.width - 100 }
                    }
                }
            }
        }
        Rectangle {
            id: addBtn
            x: 12; width: parent.width - 24; height: 48; radius: 14
            anchors.bottom: parent.bottom; anchors.bottomMargin: 14
            color: w.mode !== "" ? Theme.alpha(Theme.accent, 0.14) : addArea.containsMouse ? Theme.hover : "transparent"
            border.color: w.mode !== "" ? Theme.alpha(Theme.accent, 0.5) : Theme.border
            Text { anchors.centerIn: parent; text: "＋  Añadir conexión"; color: w.mode !== "" ? Theme.accent : Theme.text; font.family: Theme.font; font.pixelSize: 14; font.weight: Font.DemiBold }
            MouseArea { id: addArea; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor; onClicked: w.startNew() }
        }
        Text {
            visible: w.loaded && w.loadErr !== ""
            anchors.top: head.bottom; anchors.topMargin: 28; x: 24; width: parent.width - 48
            wrapMode: Text.Wrap; horizontalAlignment: Text.AlignHCenter
            text: w.loadErr; color: Theme.danger; font.family: Theme.font; font.pixelSize: 13
        }
    }

    // ------------------------------------------------------------------ one service
    Flickable {
        id: main
        anchors.left: side.right; anchors.right: parent.right; anchors.top: parent.top; anchors.bottom: parent.bottom
        anchors.margins: 28
        visible: !!w.sel && w.mode === ""
        clip: true; boundsBehavior: Flickable.StopAtBounds
        contentWidth: width; contentHeight: col.height + 24
        ScrollBar.vertical: ScrollBar { policy: ScrollBar.AsNeeded }
        Column {
            id: col
            width: Math.min(main.width - 16, 720)
            spacing: 12

            Row {
                spacing: 14
                Badge { conn: w.sel; width: 52; height: 52; radius: 15; anchors.verticalCenter: parent.verticalCenter }
                Column {
                    anchors.verticalCenter: parent.verticalCenter; spacing: 4
                    Row {
                        spacing: 12
                        Text { text: w.sel ? w.sel.name : ""; color: Theme.text; font.family: Theme.font; font.pixelSize: 26; font.weight: Font.DemiBold; anchors.verticalCenter: parent.verticalCenter }
                        Rectangle {
                            anchors.verticalCenter: parent.verticalCenter
                            width: pill.implicitWidth + 20; height: 26; radius: 13
                            color: w.sel && w.sel.connected ? Theme.alpha(Theme.good, 0.16) : Theme.card2
                            Text { id: pill; anchors.centerIn: parent; text: w.sel && w.sel.connected ? "Conectado" : "Sin conectar"; color: w.sel && w.sel.connected ? Theme.good : Theme.dim; font.family: Theme.font; font.pixelSize: 12; font.weight: Font.DemiBold }
                        }
                        Tag { visible: !!w.sel && !!w.sel.custom; anchors.verticalCenter: parent.verticalCenter; label: "Tuya"; tint: Theme.accent }
                    }
                    Text { text: w.sel ? w.sel.provider : ""; color: Theme.faint; font.family: Theme.font; font.pixelSize: 12; width: col.width - 70; elide: Text.ElideRight }
                }
            }
            Text { width: parent.width; wrapMode: Text.Wrap; lineHeight: 1.25; color: Theme.dim; font.family: Theme.font; font.pixelSize: 14; text: w.sel ? w.sel.description : "" }
            Row {
                visible: !!w.sel && !!w.sel.custom
                spacing: 10
                Btn { label: "Editar la conexión"; enabled_: !w.busy; onClicked: w.editSel() }
                Btn { label: w.confirmDel ? "¿Seguro? Pulsa otra vez" : "Eliminar la conexión"; danger: true; enabled_: !w.busy; onClicked: w.removeSel() }
            }
            Text { visible: w.confirmDel; width: parent.width; wrapMode: Text.Wrap; color: Theme.dim; font.family: Theme.font; font.pixelSize: 12
                   text: "Se borran la descripción y la clave de este equipo. Las automatizaciones que la usan dejarán de funcionar. En el servicio no se borra nada." }

            // ---- connected: account, test, change key, disconnect
            Rectangle {
                visible: !!w.sel && w.sel.connected && !w.editing
                width: parent.width; height: acc.height + 32; radius: 14
                color: Theme.card; border.color: Theme.border
                Column {
                    id: acc
                    x: 16; y: 16; width: parent.width - 32; spacing: 10
                    Text { text: w.sel && w.sel.account ? w.sel.account : "Conectado"; color: Theme.text; font.family: Theme.font; font.pixelSize: 15; font.weight: Font.DemiBold; width: parent.width; wrapMode: Text.Wrap }
                    Text { visible: !!w.sel && !!w.sel.connectedAt; text: w.sel ? "Conectado el " + w.since(w.sel.connectedAt) : ""; color: Theme.faint; font.family: Theme.font; font.pixelSize: 12 }
                    Flow {
                        width: parent.width; spacing: 10
                        Btn { label: w.busy ? "Comprobando…" : "Probar la conexión"; primary: true; enabled_: !w.busy; onClicked: w.testNow() }
                        Btn { visible: !!w.sel && w.sel.fields.length > 0; label: "Cambiar la clave"; enabled_: !w.busy; onClicked: { w.msg = ""; w.resetForm(); w.editing = true } }
                        Btn { label: "Crear una automatización"; enabled_: !w.busy; onClicked: Session.launch("automations") }
                        Btn { label: w.confirmOff ? "¿Seguro? Pulsa otra vez" : "Desconectar"; danger: true; enabled_: !w.busy; onClicked: w.disconnect() }
                    }
                    Text { visible: w.confirmOff; width: parent.width; wrapMode: Text.Wrap; color: Theme.dim; font.family: Theme.font; font.pixelSize: 12
                           text: "Se borra la clave de este equipo. Las automatizaciones que usan " + (w.sel ? w.sel.name : "") + " dejarán de funcionar hasta que lo vuelvas a conectar. En el servicio no se borra nada." }
                }
            }

            // ---- the key form
            Rectangle {
                visible: !!w.sel && w.editing
                width: parent.width; height: form.height + 32; radius: 14
                color: Theme.card; border.color: Theme.alpha(Theme.accent, 0.45)
                Column {
                    id: form
                    x: 16; y: 16; width: parent.width - 32; spacing: 8
                    Text { text: w.sel && w.sel.connected ? "Cambiar la clave" : "Conectar " + (w.sel ? w.sel.name : ""); color: Theme.text; font.family: Theme.font; font.pixelSize: 16; font.weight: Font.DemiBold }
                    Repeater {
                        model: w.sel ? w.sel.fields.map(function(f) { return { f: f, gen: w.formGen } }) : []
                        Column {
                            id: fieldBox
                            required property var modelData
                            readonly property var f: modelData.f
                            width: form.width; spacing: 5; topPadding: 4
                            Text { text: fieldBox.f.label + (fieldBox.f.optional ? "  (opcional)" : ""); color: Theme.dim; font.family: Theme.font; font.pixelSize: 13; font.weight: Font.DemiBold }
                            Field {
                                width: parent.width
                                mono: true
                                echoMode: fieldBox.f.secret ? TextInput.Password : TextInput.Normal
                                inputMethodHints: Qt.ImhNoAutoUppercase | Qt.ImhNoPredictiveText | Qt.ImhSensitiveData
                                placeholderText: w.sel && w.sel.connected && fieldBox.f.secret ? (fieldBox.f.optional ? "Vacío: sin clave" : "Vacío: se queda la que ya está guardada") : (fieldBox.f.example || "")
                                text: ""
                                onTextChanged: w.setVal(fieldBox.f.key, text)
                                onAccepted: w.connectNow()
                            }
                            Text { visible: !!fieldBox.f.help; text: fieldBox.f.help || ""; color: Theme.faint; font.family: Theme.font; font.pixelSize: 12; width: parent.width; wrapMode: Text.Wrap; lineHeight: 1.2 }
                        }
                    }
                    Row {
                        spacing: 10; topPadding: 8
                        Btn { label: w.busy ? "Comprobando con " + (w.sel ? w.sel.name : "") + "…" : w.sel && w.sel.connected ? "Guardar la clave nueva" : "Conectar"; primary: true; enabled_: !w.busy; onClicked: w.connectNow() }
                        Btn { visible: !!w.sel && w.sel.connected; label: "Cancelar"; enabled_: !w.busy; onClicked: { w.editing = false; w.resetForm(); w.msg = "" } }
                    }
                    Text { width: parent.width; wrapMode: Text.Wrap; lineHeight: 1.2; color: Theme.faint; font.family: Theme.font; font.pixelSize: 12
                           text: "Antes de guardarla, NEXUS la prueba con una lectura (no cambia nada en el servicio). Si no funciona, no se guarda." }
                }
            }
            Text { visible: w.msg !== ""; text: w.msg; color: w.msgOk ? Theme.good : Theme.danger; font.family: Theme.font; font.pixelSize: 13; width: parent.width; wrapMode: Text.Wrap }

            // ---- what it can do
            Section { text: "Qué puede hacer" }
            Repeater {
                model: w.sel ? w.sel.operations : []
                Rectangle {
                    id: op
                    required property var modelData
                    width: col.width; height: opCol.height + 24; radius: 12
                    color: Theme.card; border.color: Theme.border
                    Column {
                        id: opCol
                        x: 14; y: 12; width: parent.width - 28; spacing: 6
                        Flow {
                            width: parent.width; spacing: 8
                            Text { text: op.modelData.name; color: Theme.text; font.family: Theme.font; font.pixelSize: 14; font.weight: Font.DemiBold }
                            Tag { label: op.modelData.kind === "read" ? "Solo lee" : "Cambia datos"; tint: op.modelData.kind === "read" ? Theme.good : Theme.accent }
                            Tag { label: ({ baja: "Riesgo bajo", media: "Riesgo medio", alta: "Riesgo alto" })[op.modelData.risk] || "Riesgo " + op.modelData.risk; tint: op.modelData.risk === "alta" ? Theme.danger : op.modelData.risk === "media" ? "#e0a030" : Theme.dim }
                        }
                        Text { text: op.modelData.description; color: Theme.dim; font.family: Theme.font; font.pixelSize: 13; width: parent.width; wrapMode: Text.Wrap; lineHeight: 1.2 }
                    }
                }
            }
            Text { visible: !!w.sel && w.sel.operations.length === 0; text: "Nada."; color: Theme.faint; font.family: Theme.font; font.pixelSize: 13 }

            // ---- what it can watch
            Section { text: "Qué puede vigilar"; visible: !!w.sel && w.sel.triggers.length > 0 }
            Repeater {
                model: w.sel ? w.sel.triggers : []
                Rectangle {
                    id: tr
                    required property var modelData
                    width: col.width; height: trCol.height + 24; radius: 12
                    color: Theme.card; border.color: Theme.border
                    Column {
                        id: trCol
                        x: 14; y: 12; width: parent.width - 28; spacing: 6
                        Flow {
                            width: parent.width; spacing: 8
                            Text { text: tr.modelData.name; color: Theme.text; font.family: Theme.font; font.pixelSize: 14; font.weight: Font.DemiBold }
                            Tag { label: "Lo mira cada " + tr.modelData.every + " min"; tint: Theme.dim }
                        }
                        Text { text: tr.modelData.description; color: Theme.dim; font.family: Theme.font; font.pixelSize: 13; width: parent.width; wrapMode: Text.Wrap; lineHeight: 1.2 }
                        Text { width: parent.width; wrapMode: Text.Wrap; color: Theme.faint; font.family: Theme.font; font.pixelSize: 12
                               text: "Trae: " + tr.modelData.fields.map(function(x) { return x.label }).join(", ") + "." }
                    }
                }
            }

            // ---- what NEXUS AI warned about (custom connections it drafted)
            Section { text: "Avisos de NEXUS AI"; visible: !!w.sel && !!w.sel.custom && w.sel.custom.notices.length > 0 }
            Repeater {
                model: w.sel && w.sel.custom ? w.sel.custom.notices : []
                Text { required property string modelData; width: col.width; wrapMode: Text.Wrap; lineHeight: 1.2; text: "•  " + modelData; color: Theme.dim; font.family: Theme.font; font.pixelSize: 13 }
            }

            // ---- permissions, data, verification, security
            Section { text: "Permisos que necesita la clave"; visible: !!w.sel && w.sel.scopes.length > 0 }
            Flow {
                visible: !!w.sel && w.sel.scopes.length > 0
                width: parent.width; spacing: 8
                Repeater { model: w.sel ? w.sel.scopes : []; Tag { required property string modelData; label: modelData; tint: Theme.dim } }
            }
            Section { text: "Qué datos pasan" }
            Text { width: parent.width; wrapMode: Text.Wrap; lineHeight: 1.25; color: Theme.dim; font.family: Theme.font; font.pixelSize: 13; text: w.sel ? w.sel.data : "" }
            Section { text: "Comprobado con" }
            Text { width: parent.width; wrapMode: Text.Wrap; lineHeight: 1.25; color: Theme.dim; font.family: Theme.font; font.pixelSize: 13
                   text: w.sel ? w.sel.verified + (w.sel.docs ? "\nDocumentación: " + w.sel.docs : "") + "\nVersión del conector: " + w.sel.version : "" }
            Rectangle {
                width: parent.width; height: sec.implicitHeight + 28; radius: 14
                color: Theme.alpha(Theme.accent, 0.10); border.color: Theme.alpha(Theme.accent, 0.35)
                NexusMark { x: 16; y: 14; width: 22; height: 22 }
                Text { id: sec; x: 50; y: 14; width: parent.width - 66; wrapMode: Text.Wrap; lineHeight: 1.25; color: Theme.text; font.family: Theme.font; font.pixelSize: 13
                       text: "Cómo se protege: la clave solo la guarda el motor de NEXUS (un archivo que solo él puede leer); las apps, los agentes y NEXUS AI nunca la ven. Solo las automatizaciones que tú creas pueden cambiar datos en el servicio. Cada llamada queda en el registro de auditoría con el servicio, la operación y si fue bien, sin datos de clientes ni claves." }
            }
        }
    }
    // ------------------------------------------------------------------ «＋ Añadir conexión»: how, then the description form
    Flickable {
        id: editor
        anchors.left: side.right; anchors.right: parent.right; anchors.top: parent.top; anchors.bottom: parent.bottom
        anchors.margins: 28
        visible: w.mode !== ""
        clip: true; boundsBehavior: Flickable.StopAtBounds
        contentWidth: width; contentHeight: edCol.height + 24
        ScrollBar.vertical: ScrollBar { policy: ScrollBar.AsNeeded }
        Column {
            id: edCol
            width: Math.min(editor.width - 16, 760)
            spacing: 10

            Text { text: w.mode === "new" ? "Añadir una conexión" : w.edTitle; color: Theme.text; font.family: Theme.font; font.pixelSize: 26; font.weight: Font.DemiBold; width: parent.width; wrapMode: Text.Wrap }

            // ---- step 1: which service, and how
            Column {
                visible: w.mode === "new"
                width: parent.width; spacing: 8
                Text { width: parent.width; wrapMode: Text.Wrap; lineHeight: 1.25; color: Theme.dim; font.family: Theme.font; font.pixelSize: 14
                       text: "Conecta cualquier servicio que tenga API: tu programa de facturas, tu tienda online, tu CRM… Luego lo podrás usar en Automatizaciones como GoHighLevel o Wiwink." }
                Lbl { text: "¿Con qué servicio?" }
                Field { width: parent.width; placeholderText: "Por ejemplo: Holded, Shopify, Notion, Trello, Stripe…"; enabled: !w.drafting
                        onTextChanged: w.askService = text; onAccepted: w.draftNow() }
                Lbl { text: "¿Qué quieres hacer con él?  (opcional)" }
                Field { width: parent.width; placeholderText: "Por ejemplo: ver los pedidos nuevos y crear contactos"; enabled: !w.drafting
                        onTextChanged: w.askNotes = text; onAccepted: w.draftNow() }
                Flow {
                    width: parent.width; spacing: 10; topPadding: 6
                    Btn { label: w.drafting ? "Leyendo la documentación… " + Math.floor(w.draftSecs / 60) + ":" + ("0" + (w.draftSecs % 60)).slice(-2) : "Que la prepare NEXUS AI"; primary: true; enabled_: !w.drafting && w.askService.trim() !== ""; onClicked: w.draftNow() }
                    Btn { label: "Rellenarla a mano"; enabled_: !w.drafting; onClicked: w.manual() }
                    Btn { label: "Cancelar"; enabled_: !w.drafting; onClicked: w.closeEditor() }
                }
                Hint { width: parent.width
                       text: w.drafting ? "NEXUS AI está buscando y leyendo la documentación oficial de la API de " + w.askService.trim() + ". Suele tardar de 1 a 3 minutos. No se guarda nada hasta que lo revises."
                                        : "NEXUS AI busca la documentación oficial de su API y te prepara la conexión para que la revises. Suele costar unos 0,50 US$ de tu saldo de Claude. Tu clave no la ve nunca: la pones tú al final." }
            }

            // ---- step 2: the description
            Column {
                visible: w.mode === "edit" && !!w.ed
                width: parent.width; spacing: 8

                Rectangle {
                    visible: w.draftInfo !== ""
                    width: parent.width; height: diText.implicitHeight + 24; radius: 12
                    color: Theme.alpha(Theme.accent, 0.10); border.color: Theme.alpha(Theme.accent, 0.35)
                    NexusMark { x: 14; y: 12; width: 20; height: 20 }
                    Text { id: diText; x: 44; y: 12; width: parent.width - 58; wrapMode: Text.Wrap; lineHeight: 1.2; text: w.draftInfo; color: Theme.text; font.family: Theme.font; font.pixelSize: 13 }
                }
                Repeater {
                    model: w.ed && w.mode === "edit" ? (w.edGen, w.ed.notices) : []
                    Text { required property string modelData; width: edCol.width; wrapMode: Text.Wrap; lineHeight: 1.2; text: "⚠  " + modelData; color: Theme.warn; font.family: Theme.font; font.pixelSize: 13 }
                }

                Section { text: "Lo básico" }
                Lbl { text: "Nombre" }
                Field { width: parent.width; text: w.ed ? (w.edGen, w.ed.name) : ""; placeholderText: "Holded"; onTextChanged: w.setEd("name", text) }
                Lbl { text: "Para qué sirve  (opcional)" }
                Field { width: parent.width; text: w.ed ? (w.edGen, w.ed.description) : ""; placeholderText: "Facturas y contactos de la empresa"; onTextChanged: w.setEd("description", text) }
                Lbl { text: "Dirección de la API" }
                Field { width: parent.width; mono: true; text: w.ed ? (w.edGen, w.ed.base) : ""; placeholderText: "https://api.servicio.com/v1"
                        onTextChanged: { w.setEd("base", text); w.edBase = text } }
                Hint { width: parent.width; text: "La parte común de todas las direcciones de su API. Tiene que empezar por https://." }
                Lbl { text: "Documentación  (opcional)" }
                Field { width: parent.width; mono: true; text: w.ed ? (w.edGen, w.ed.docs) : ""; placeholderText: "https://developers.servicio.com"; onTextChanged: w.setEd("docs", text) }

                Section { text: "La clave" }
                Flow {
                    width: parent.width; spacing: 8
                    Repeater {
                        model: [["bearer", "Token (Bearer)"], ["header", "En una cabecera"], ["query", "En la dirección"], ["basic", "Usuario y contraseña"], ["none", "Sin clave"]]
                        Chip { required property var modelData; label: modelData[1]; on: w.edAuth === modelData[0]
                               onClicked: { w.edAuth = modelData[0]; if (w.ed) w.ed.auth.kind = modelData[0] } }
                    }
                }
                Lbl { visible: w.edAuth === "header" || w.edAuth === "query"; text: w.edAuth === "header" ? "Nombre de la cabecera" : "Nombre del parámetro" }
                Field { visible: w.edAuth === "header" || w.edAuth === "query"; width: parent.width; mono: true; text: w.ed ? (w.edGen, w.ed.auth.name) : ""
                        placeholderText: w.edAuth === "header" ? "X-API-Key" : "api_key"; onTextChanged: if (w.ed) w.ed.auth.name = text }
                Lbl { visible: w.edAuth !== "none"; text: "Dónde se consigue  (opcional)" }
                Field { visible: w.edAuth !== "none"; width: parent.width; text: w.ed ? (w.edGen, w.ed.keyHelp) : ""; placeholderText: "En el servicio: Ajustes → API → Crear clave"; onTextChanged: w.setEd("keyHelp", text) }
                Lbl { text: "Comprobación (una lectura)" }
                Field { width: parent.width; mono: true; text: w.ed ? (w.edGen, w.ed.test) : ""; placeholderText: "/me"; onTextChanged: w.setEd("test", text) }
                Hint { width: parent.width; text: "Una dirección que solo lee (por ejemplo tu cuenta). NEXUS la usa para comprobar la clave antes de guardarla." }
                Rectangle {
                    visible: w.edAuth !== "none" && w.hostOf(w.edBase) !== ""
                    width: parent.width; height: hostText.implicitHeight + 20; radius: 12
                    color: Theme.alpha(Theme.good, 0.10); border.color: Theme.alpha(Theme.good, 0.4)
                    Text { id: hostText; x: 14; y: 10; width: parent.width - 28; wrapMode: Text.Wrap; color: Theme.text; font.family: Theme.font; font.pixelSize: 13
                           text: "Tu clave solo se enviará a " + w.hostOf(w.edBase) + ". Si cambias la dirección más adelante, la clave guardada se borra." }
                }

                Section { text: "Acciones" }
                Hint { width: parent.width; text: "Lo que NEXUS puede hacer en el servicio. GET solo lee; POST, PUT y PATCH cambian datos y DELETE borra: esas solo las ejecutan las automatizaciones que crees tú. Los datos van entre llaves: {{email}}." }
                Repeater {
                    model: { var g = w.edGen; var n = w.ed ? w.ed.operations.length : 0; var a = []; for (var i = 0; i < n; i++) a.push(g * 1000 + i); return a }
                    Rectangle {
                        id: opEd
                        required property int index
                        readonly property var o: w.ed && w.ed.operations[index] ? w.ed.operations[index] : ({})
                        property string method: o.method || "GET"
                        width: edCol.width; height: opEdCol.height + 24; radius: 12
                        color: Theme.card; border.color: Theme.border
                        Column {
                            id: opEdCol
                            x: 14; y: 12; width: parent.width - 28; spacing: 6
                            Row {
                                width: parent.width; spacing: 10
                                Field { width: parent.width - opDrop.width - 10; text: opEd.o.name || ""; placeholderText: "Nombre (por ejemplo: Crear un contacto)"; onTextChanged: w.setOp(opEd.index, "name", text) }
                                Btn { id: opDrop; label: "Quitar"; danger: true; onClicked: w.dropOp(opEd.index) }
                            }
                            Flow {
                                width: parent.width; spacing: 6
                                Repeater {
                                    model: ["GET", "POST", "PUT", "PATCH", "DELETE"]
                                    Chip { required property string modelData; label: modelData; on: opEd.method === modelData
                                           onClicked: { opEd.method = modelData; w.setOp(opEd.index, "method", modelData) } }
                                }
                            }
                            Field { width: parent.width; mono: true; text: opEd.o.path || ""; placeholderText: "/contacts/{{id}}"; onTextChanged: w.setOp(opEd.index, "path", text) }
                            Field { width: parent.width; mono: true; text: opEd.o.paramsText || ""; placeholderText: "Datos que pide: email*, nombre, telefono   (* = obligatorio)"; onTextChanged: w.setOp(opEd.index, "paramsText", text) }
                            Area { visible: opEd.method !== "GET" && opEd.method !== "DELETE"; width: parent.width; text: opEd.o.body || ""
                                   placeholder: "Cuerpo JSON (opcional). Por ejemplo:\n{\"email\": \"{{email}}\", \"name\": \"{{nombre}}\"}\nVacío: se envían los datos tal cual."
                                   onEdited: (t) => w.setOp(opEd.index, "body", t) }
                            Field { width: parent.width; text: opEd.o.description || ""; placeholderText: "Qué hace, en una frase (opcional)"; onTextChanged: w.setOp(opEd.index, "description", text) }
                        }
                    }
                }
                Btn { label: "＋  Añadir una acción"; onClicked: w.addOp() }

                Section { text: "Qué vigilar" }
                Hint { width: parent.width; text: "Listas en las que NEXUS mira si aparece algo nuevo (pedidos, facturas, contactos…). La primera vez solo se apunta lo que ya hay." }
                Repeater {
                    model: { var g = w.edGen; var n = w.ed ? w.ed.triggers.length : 0; var a = []; for (var i = 0; i < n; i++) a.push(g * 1000 + i); return a }
                    Rectangle {
                        id: trEd
                        required property int index
                        readonly property var t: w.ed && w.ed.triggers[index] ? w.ed.triggers[index] : ({})
                        property bool newest: t.newestFirst !== false
                        width: edCol.width; height: trEdCol.height + 24; radius: 12
                        color: Theme.card; border.color: Theme.border
                        Column {
                            id: trEdCol
                            x: 14; y: 12; width: parent.width - 28; spacing: 6
                            Row {
                                width: parent.width; spacing: 10
                                Field { width: parent.width - trDrop.width - 10; text: trEd.t.name || ""; placeholderText: "Nombre (por ejemplo: Pedido nuevo)"; onTextChanged: w.setTr(trEd.index, "name", text) }
                                Btn { id: trDrop; label: "Quitar"; danger: true; onClicked: w.dropTr(trEd.index) }
                            }
                            Field { width: parent.width; mono: true; text: trEd.t.path || ""; placeholderText: "/orders?sort=newest"; onTextChanged: w.setTr(trEd.index, "path", text) }
                            Row {
                                width: parent.width; spacing: 8
                                Field { width: (parent.width - 16) / 3; mono: true; text: trEd.t.list || ""; placeholderText: "La lista está en: data"; onTextChanged: w.setTr(trEd.index, "list", text) }
                                Field { width: (parent.width - 16) / 3; mono: true; text: trEd.t.idField || ""; placeholderText: "Campo id"; onTextChanged: w.setTr(trEd.index, "idField", text) }
                                Field { width: (parent.width - 16) / 3; mono: true; text: trEd.t.labelField || ""; placeholderText: "Campo nombre"; onTextChanged: w.setTr(trEd.index, "labelField", text) }
                            }
                            Field { width: parent.width; mono: true; text: trEd.t.fieldsText || ""; placeholderText: "Campos que trae: email, total, cliente.nombre"; onTextChanged: w.setTr(trEd.index, "fieldsText", text) }
                            Flow {
                                width: parent.width; spacing: 8
                                Text { text: "Mirar cada"; color: Theme.dim; font.family: Theme.font; font.pixelSize: 13; height: 42; verticalAlignment: Text.AlignVCenter }
                                Field { width: 90; text: String(trEd.t.every || 15); inputMethodHints: Qt.ImhDigitsOnly; onTextChanged: w.setTr(trEd.index, "every", text) }
                                Text { text: "minutos"; color: Theme.dim; font.family: Theme.font; font.pixelSize: 13; height: 42; verticalAlignment: Text.AlignVCenter }
                                Chip { label: trEd.newest ? "✓ Lo más nuevo sale primero" : "Lo más nuevo sale al final"; on: trEd.newest
                                       onClicked: { trEd.newest = !trEd.newest; w.setTr(trEd.index, "newestFirst", trEd.newest) } }
                            }
                        }
                    }
                }
                Btn { label: "＋  Añadir algo que vigilar"; onClicked: w.addTr() }

                Section { text: "De dónde sale"; visible: !!w.ed && w.ed.sources.length > 0 }
                Repeater {
                    model: w.ed && w.mode === "edit" ? (w.edGen, w.ed.sources) : []
                    Text { required property string modelData; width: edCol.width; elide: Text.ElideRight; text: modelData; color: Theme.faint; font.family: Theme.mono; font.pixelSize: 12 }
                }

                Flow {
                    width: parent.width; spacing: 10; topPadding: 10
                    Btn { label: w.busy ? "Comprobando…" : "Guardar la conexión"; primary: true; enabled_: !w.busy; onClicked: w.saveEd() }
                    Btn { label: "Cancelar"; enabled_: !w.busy; onClicked: w.closeEditor() }
                }
                Hint { width: parent.width; text: "Al guardar, NEXUS revisa que todo esté bien formado y que la dirección sea de Internet (nunca de tu red local). Después pondrás la clave." }
            }
            Text { visible: w.edErr !== ""; width: parent.width; wrapMode: Text.Wrap; lineHeight: 1.2; text: w.edErr; color: Theme.danger; font.family: Theme.font; font.pixelSize: 13 }
        }
    }

    Text {
        visible: w.loaded && !w.sel && w.loadErr === "" && w.mode === ""
        anchors.centerIn: parent; anchors.horizontalCenterOffset: side.width / 2
        text: "Elige un servicio"; color: Theme.faint; font.family: Theme.font; font.pixelSize: 14
    }
    Shortcut { sequence: "Escape"; enabled: w.mode === "" && w.editing && !!w.sel && w.sel.connected; onActivated: { w.editing = false; w.resetForm() } }
    Shortcut { sequence: "Escape"; enabled: w.mode !== "" && !w.drafting && !w.busy; onActivated: w.closeEditor() }
}
