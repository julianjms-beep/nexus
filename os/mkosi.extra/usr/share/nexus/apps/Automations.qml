import QtQuick
import QtQuick.Window
import QtQuick.Controls
import "../shell"

// Automatizaciones: rules "cuando pase X, haz Y" run by nexus-sessiond (core/src/automations.ts).
// Commands run sandboxed (bubblewrap): read-only system, only their project folder is writable.
// NEXUS AI can fill in a draft (GET /automations/draft); nothing exists until the person presses Crear.
// Services (NEXUS Connect, app Conexiones): "cuando entre una factura en Wiwink" / "añade una nota en GoHighLevel". This app
// only sees the catalog (GET /connect: what each service can do, never a key); the Engine does the calls.
Window {
    id: w
    visible: true
    width: 1120; height: 720
    minimumWidth: 880; minimumHeight: 540
    title: "Automatizaciones"
    color: Theme.bg

    property var items: []
    property bool loaded: false
    property string selId: ""
    readonly property var sel: { for (var i = 0; i < items.length; i++) if (items[i].id === selId) return items[i]; return null }
    property var runs: []
    property int runIdx: 0
    property string live: ""
    property bool editing: false
    property bool fromAi: false
    property bool drafting: false       // «Escríbela con tus palabras»: NEXUS AI is filling the form
    property string draftErr: ""
    property string fId: ""
    property bool fEnabled: true
    property string fWhen: "files"
    property string fDo: "command"
    property string fApp: "browser"
    property string fNotify: "failure"
    property string formErr: ""
    property bool saving: false
    property bool confirmDelete: false
    property string actionMsg: ""
    property string aiAnswer: ""        // NEXUS AI's explanation of a failed run
    property string aiFor: ""           // …for this run id
    property bool aiBusy: false
    readonly property var curRun: runs.length ? runs[Math.min(runIdx, runs.length - 1)] : null
    // NEXUS Connect
    property var services: []           // the catalog from GET /connect (no keys)
    readonly property var connected: services.filter(function(c) { return c.connected })
    readonly property var watchers: services.filter(function(c) { return c.triggers.length > 0 })
    readonly property var doers: services.filter(function(c) { return c.operations.length > 0 })
    property string fTConn: ""          // trigger: service, what it watches, its fields, every N minutes
    property string fTrig: ""
    property var fTIn: ({})
    property string fAConn: ""          // action: service, operation, its fields
    property string fOp: ""
    property var fAIn: ({})
    property int fGen: 0                // rebuilds the service fields with the values above
    property var lastField: null        // where a {{dato}} chip writes
    readonly property var tConn: findConn(fTConn)
    readonly property var tDef: tConn ? findIn(tConn.triggers, fTrig) : null
    readonly property var aConn: findConn(fAConn)
    readonly property var aDef: aConn ? findIn(aConn.operations, fOp) : null
    readonly property var eventFields: fWhen === "service" && tDef ? tDef.fields : []

    readonly property var whenKinds: [["files", "Cuando cambien archivos"], ["interval", "Cada cierto tiempo"], ["daily", "Cada día a una hora"], ["login", "Al iniciar sesión"], ["service", "Cuando pase algo en un servicio"]]
    readonly property var doKinds: [["command", "Ejecutar un comando"], ["notify", "Mostrarme un aviso"], ["open", "Abrir una app"], ["service", "Hacer algo en un servicio"]]
    readonly property var notifyKinds: [["failure", "Solo si falla"], ["always", "Siempre"], ["never", "Nunca"]]
    readonly property var templates: [
        { name: "Tests al guardar", hint: "npm test cuando cambie el proyecto", trigger: { kind: "files", path: "~/proyectos" }, action: { kind: "command", command: "npm test", cwd: "" }, notify: "failure" },
        { name: "git pull cada mañana", hint: "a las 09:00, solo avance rápido", trigger: { kind: "daily", time: "09:00" }, action: { kind: "command", command: "git pull --ff-only", cwd: "~/proyectos" }, notify: "failure" },
        { name: "Pausa cada hora", hint: "un aviso para estirar", trigger: { kind: "interval", minutes: 60 }, action: { kind: "notify", text: "Levántate y estira las piernas" }, notify: "never" },
        { name: "Navegador al entrar", hint: "abre el Navegador al iniciar sesión", trigger: { kind: "login" }, action: { kind: "open", app: "browser" }, notify: "never" },
        { name: "Facturas a GoHighLevel", hint: "cada factura de Wiwink, una nota en su contacto", trigger: { kind: "service", connector: "wiwink", trigger: "factura", input: {} },
          action: { kind: "service", connector: "ghl", op: "nota", input: { email: "{{cliente.email}}", telefono: "{{cliente.telefono}}", nota: "Factura {{factura.numero}} del {{factura.fecha}}: {{factura.total}} €" } }, notify: "failure" },
        { name: "Clientes a GoHighLevel", hint: "cada cliente nuevo de Wiwink, un contacto", trigger: { kind: "service", connector: "wiwink", trigger: "cliente", input: {} },
          action: { kind: "service", connector: "ghl", op: "contacto", input: { email: "{{cliente.email}}", telefono: "{{cliente.telefono}}", empresa: "{{cliente.nombre}}", ciudad: "{{cliente.ciudad}}", origen: "Wiwink", etiquetas: "cliente, wiwink" } }, notify: "failure" }
    ]

    function tilde(p) { return String(p || "").replace(/^\/home\/[^\/]+(?=\/|$)/, "~") }
    function cap(s) { s = String(s || ""); return s.charAt(0).toUpperCase() + s.slice(1) }
    function ago(iso) {
        var d = (Session.now.getTime() - new Date(iso).getTime()) / 1000
        if (!(d >= 0)) return ""
        if (d < 45) return "hace un momento"
        if (d < 3600) return "hace " + Math.round(d / 60) + " min"
        if (d < 86400) return "hace " + Math.round(d / 3600) + " h"
        var t = new Date(iso)
        return t.toLocaleDateString(Qt.locale("es_ES"), "d MMM") + ", " + t.toLocaleTimeString(Qt.locale("es_ES"), "HH:mm")
    }
    function dur(ms) { return ms < 1000 ? ms + " ms" : ms < 60000 ? (ms / 1000).toFixed(1).replace(".", ",") + " s" : Math.floor(ms / 60000) + " min " + Math.round((ms % 60000) / 1000) + " s" }
    function fmtNext(iso) {
        var t = new Date(iso), now = Session.now, mins = Math.round((t.getTime() - now.getTime()) / 60000)
        if (mins <= 0) return "ahora"
        if (mins < 60) return "dentro de " + mins + " min"
        var hm = t.toLocaleTimeString(Qt.locale("es_ES"), "HH:mm")
        var d0 = new Date(now); d0.setHours(0, 0, 0, 0)
        var days = Math.floor((t.getTime() - d0.getTime()) / 86400000)
        return days === 0 ? "hoy a las " + hm : days === 1 ? "mañana a las " + hm : t.toLocaleDateString(Qt.locale("es_ES"), "d MMM") + ", " + hm
    }
    function findConn(id) { for (var i = 0; i < services.length; i++) if (services[i].id === id) return services[i]; return null }
    function findIn(arr, id) { for (var i = 0; i < arr.length; i++) if (arr[i].id === id) return arr[i]; return null }
    property string servicesJson: ""
    // only when something changed: a new list would rebuild the fields the person is typing in
    function loadServices() { Session.request("GET", "/connect", null, function(st, j) { if (st === 200 && j && j.connectors) { var t = JSON.stringify(j.connectors); if (t !== w.servicesJson) { w.servicesJson = t; w.services = j.connectors } } }) }
    function pickTConn(id) { fTConn = id; var c = findConn(id); fTrig = c && c.triggers.length ? c.triggers[0].id : ""; fTIn = ({}); fSvcMin.text = tDef ? String(tDef.every) : "10"; fGen++ }
    function pickTrig(id) { fTrig = id; fTIn = ({}); fSvcMin.text = tDef ? String(tDef.every) : "10"; fGen++ }
    function setIn(which, k, v) { var o = which === "t" ? fTIn : fAIn; if (v) o[k] = v; else delete o[k] }
    function pickAConn(id) { fAConn = id; var c = findConn(id); fOp = c && c.operations.length ? firstWrite(c) : ""; fAIn = ({}); fGen++ }
    function firstWrite(c) { for (var i = 0; i < c.operations.length; i++) if (c.operations[i].kind === "write") return c.operations[i].id; return c.operations[0].id }
    function pickOp(id) { fOp = id; fAIn = ({}); fGen++ }
    function insertField(key) {
        var f = lastField, tag = "{{" + key + "}}"
        if (!f || !f.visible) return
        f.insert(f.cursorPosition, tag); f.forceActiveFocus()
    }
    function runTitle(r, a) {
        if (r.ok) return "Bien"
        if (r.killed === "timeout") return "Cortada"
        if (r.killed === "stopped") return "Detenida"
        if (r.reason === "comprobar el servicio") return "No se pudo comprobar"
        if (a && a.action.kind === "service") return "Falló"
        return r.exitCode === null ? "No se ejecutó" : "Falló (código " + r.exitCode + ")"
    }
    function watchText(a) {
        var x = a && a.watch
        if (!x) return ""
        if (x.checking) return "Comprobando el servicio…"
        if (x.error) return "No se ha podido comprobar: " + x.error
        if (!x.at) return "Pendiente de la primera comprobación"
        return "Comprobado " + ago(x.at) + (x.baseline !== null && x.baseline !== undefined ? " · al empezar ya había " + x.baseline + "; solo actúa con lo nuevo" : "") + (x.queued ? " · " + x.queued + " en cola" : "")
    }
    function statusColor(a) { return a.running ? Theme.accent : !a.last ? Theme.faint : a.last.ok ? Theme.good : Theme.danger }
    function statusText(a) {
        if (a.running) return "Ejecutándose…"
        if (!a.last) return "Aún no se ha ejecutado"
        return (a.last.ok ? "Bien" : a.last.killed === "timeout" ? "Cortada (10 min)" : a.last.killed === "stopped" ? "Detenida" : "Falló") + " · " + ago(a.last.at) + " · " + dur(a.last.ms)
    }

    function load() {
        loadServices()
        Session.request("GET", "/automations", null, function(st, j) {
            if (st !== 200 || !j) return
            w.items = j.items || []; w.loaded = true
            if (w.selId && !w.sel) w.selId = ""
            if (!w.selId && w.items.length && !w.editing) w.select(w.items[0].id)
            else if (w.selId) w.loadRuns()
        })
    }
    function select(id) { selId = id; runIdx = 0; live = ""; confirmDelete = false; actionMsg = ""; editing = false; loadRuns() }
    function loadRuns() {
        if (!selId) return
        var id = selId
        Session.request("GET", "/automations/" + id + "/runs", null, function(st, j) {
            if (st !== 200 || !j || w.selId !== id) return
            w.runs = j.runs || []; w.live = j.live === null || j.live === undefined ? "" : String(j.live)
            if (w.runIdx >= w.runs.length) w.runIdx = 0
        })
    }
    function post(path, body, done) {
        Session.request("POST", path, body || {}, function(st, j) {
            if (st !== 200) w.actionMsg = cap(j && j.error ? j.error : "no se ha podido (error " + st + ")") + "."
            if (done) done(st, j)
            w.load()
        })
    }
    function runNow() { actionMsg = ""; var svc = !!sel && sel.trigger.kind === "service"; post("/automations/" + selId + "/run", {}, function(st, j) { if (st === 200 && j && j.started === false) w.actionMsg = (svc ? "No se ha comprobado: " : "No se ha ejecutado: ") + j.reason + "."; w.runIdx = 0 }) }
    function stopNow() { post("/automations/" + selId + "/stop", {}) }
    function setEnabled(id, on) { post("/automations/" + id + "/enable", { on: on }) }
    function remove() {
        if (!confirmDelete) { confirmDelete = true; deleteReset.restart(); return }
        var id = selId; selId = ""; confirmDelete = false
        post("/automations/" + id + "/delete", {})
    }
    // "¿Por qué ha fallado?": the run's output goes to NEXUS AI as program output (it cannot act while reading it)
    function explain() {
        var r = curRun, a = sel
        if (!r || !a || aiBusy) return
        aiBusy = true; aiFor = r.id; aiAnswer = ""
        var what = a.action.kind === "command" ? "ejecutó «" + a.action.command + "» en " + tilde(a.action.cwd) : "se ejecutó"
        var q = "Mi automatización «" + a.name + "» " + what + " y ha fallado" + (r.exitCode !== null ? " (código " + r.exitCode + ")" : "") + ". ¿Por qué y cómo lo arreglo?"
        Session.request("POST", "/ai", { text: q, output: { text: String(r.output || "") }, via: "terminal" }, function(st, j) {
            w.aiBusy = false
            w.aiAnswer = st === 200 && j ? String(j.text || "") : st === 503 ? "El motor de NEXUS no responde ahora mismo." : "No he podido preguntar (error " + st + ")."
        })
    }
    function checkDraft() {
        Session.request("GET", "/automations/draft", null, function(st, j) { if (st === 200 && j && j.draft) w.openForm(j.draft, true) })
    }

    function draftFromText(t) {
        drafting = true; draftErr = ""
        Session.request("POST", "/automations/draft-text", { texto: t }, function(st, j) {
            w.drafting = false
            if (st === 200 && j && j.draft) w.openForm(j.draft, true)
            else w.draftErr = (j && j.error ? String(j.error).charAt(0).toUpperCase() + String(j.error).slice(1) : "No se ha podido preparar (error " + st + ")") + "."
        })
    }
    function openForm(d, ai) {
        d = d || {}
        var t = d.trigger || {}, a = d.action || {}
        editing = true; fromAi = !!ai; formErr = ""; saving = false; draftErr = ""
        fId = d.id || ""; fEnabled = d.enabled !== false
        fWhen = ["files", "interval", "daily", "login", "service"].indexOf(t.kind) >= 0 ? t.kind : "files"
        fDo = ["command", "notify", "open", "service"].indexOf(a.kind) >= 0 ? a.kind : "command"
        var pickFirst = function(list, not) { var i; for (i = 0; i < list.length; i++) if (list[i].connected && list[i].id !== not) return list[i].id; return list.length ? list[0].id : "" }
        fTConn = t.kind === "service" ? String(t.connector || "") : pickFirst(watchers, "")
        fTrig = t.kind === "service" ? String(t.trigger || "") : ""
        if (!fTrig && tConn && tConn.triggers.length) fTrig = tConn.triggers[0].id
        fTIn = t.kind === "service" && t.input ? JSON.parse(JSON.stringify(t.input)) : ({})
        fAConn = a.kind === "service" ? String(a.connector || "") : pickFirst(doers, fTConn)
        fOp = a.kind === "service" ? String(a.op || "") : ""
        if (!fOp && aConn && aConn.operations.length) fOp = firstWrite(aConn)
        fAIn = a.kind === "service" && a.input ? JSON.parse(JSON.stringify(a.input)) : ({})
        lastField = null; fGen++
        fApp = a.app || "browser"
        fNotify = d.notify || "failure"
        fName.text = d.name || ""
        fMin.text = String(t.kind !== "service" && t.minutes ? t.minutes : 15)
        fSvcMin.text = String(t.kind === "service" && t.minutes ? t.minutes : tDef ? tDef.every : 10)
        fTime.text = t.time || "09:00"
        fPath.text = tilde(t.path)
        fCmd.text = a.command || ""
        fCwd.text = tilde(a.cwd)
        fText.text = a.text || ""
        formFlick.contentY = 0
        fName.forceActiveFocus()
    }
    function save() {
        if (saving) return
        var body = {
            name: fName.text.trim(), enabled: fEnabled, notify: fNotify,
            trigger: fWhen === "service" ? { kind: "service", connector: fTConn, trigger: fTrig, input: fTIn, minutes: parseInt(fSvcMin.text, 10) || 0 }
                   : { kind: fWhen, minutes: parseInt(fMin.text, 10) || 0, time: fTime.text.trim(), path: fPath.text.trim() },
            action: fDo === "service" ? { kind: "service", connector: fAConn, op: fOp, input: fAIn }
                  : { kind: fDo, command: fCmd.text.trim(), cwd: fCwd.text.trim(), text: fText.text.trim(), app: fApp }
        }
        if (fId) body.id = fId
        saving = true; formErr = ""
        Session.request("POST", "/automations", body, function(st, j) {
            w.saving = false
            if (st === 200 && j && j.id) { w.editing = false; w.fromAi = false; w.selId = j.id; w.load() }
            else w.formErr = cap(j && j.error ? j.error : "no se ha podido guardar (error " + st + ")") + "."
        })
    }

    Component.onCompleted: { load(); checkDraft() }
    Connections {
        target: Session
        function onAutomationsChanged() { w.load() }
        function onAutomationDraftReady() { w.checkDraft(); w.raise(); w.requestActivate() }
        function onConnectChanged() { w.loadServices() }
    }
    Timer { interval: 1000; repeat: true; running: !!w.sel && w.sel.running && !w.editing; onTriggered: w.loadRuns() }
    Timer { id: deleteReset; interval: 3500; onTriggered: w.confirmDelete = false }

    // ------------------------------------------------------------------ small building blocks
    component Chip: Rectangle {
        id: chip
        property string label: ""
        property bool on: false
        signal picked()
        width: chipText.implicitWidth + 28; height: 34; radius: 17
        color: on ? Theme.alpha(Theme.accent, 0.22) : chipArea.containsMouse ? Theme.hover : Theme.card2
        border.color: on ? Theme.accent : Theme.border
        Text { id: chipText; anchors.centerIn: parent; text: chip.label; color: chip.on ? Theme.text : Theme.dim; font.family: Theme.font; font.pixelSize: 13; font.weight: chip.on ? Font.DemiBold : Font.Normal }
        MouseArea { id: chipArea; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor; onClicked: chip.picked() }
    }
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
    component Label_: Text { color: Theme.dim; font.family: Theme.font; font.pixelSize: 13; font.weight: Font.DemiBold }
    // the fields a service trigger or action asks for (the Engine says which); {{dato}} chips write into the last one used
    component ParamFields: Column {
        id: pf
        property var params: []
        property var values: ({})
        property int gen: 0
        signal edited(string key, string value)
        signal focusedField(var field)
        width: parent ? parent.width : 400; spacing: 8
        Repeater {
            model: pf.params.map(function(p) { return { p: p, gen: pf.gen } })
            Column {
                id: pbox
                required property var modelData
                readonly property var p: modelData.p
                width: pf.width; spacing: 4
                Text { text: pbox.p.label + (pbox.p.required ? "" : "  (opcional)"); color: Theme.dim; font.family: Theme.font; font.pixelSize: 13; font.weight: Font.DemiBold }
                Field {
                    id: pfield
                    width: parent.width
                    placeholderText: pbox.p.example || ""
                    maximumLength: 2000
                    Component.onCompleted: text = String(pf.values[pbox.p.key] || "")
                    onTextChanged: pf.edited(pbox.p.key, text.trim())
                    onActiveFocusChanged: if (activeFocus) pf.focusedField(pfield)
                }
                Text { visible: !!pbox.p.help || !!pbox.p.list; text: (pbox.p.help || "") + (pbox.p.list ? (pbox.p.help ? " " : "") + "Separadas por comas." : ""); color: Theme.faint; font.family: Theme.font; font.pixelSize: 12; width: parent.width; wrapMode: Text.Wrap }
            }
        }
    }
    component NoServices: Rectangle {
        id: ns
        property string who: ""
        width: parent ? parent.width : 400; height: visible ? nsCol.height + 28 : 0; radius: 14
        color: Theme.alpha(Theme.danger, 0.08); border.color: Theme.alpha(Theme.danger, 0.35)
        Column {
            id: nsCol
            x: 16; y: 14; width: parent.width - 32; spacing: 10
            Text { width: parent.width; wrapMode: Text.Wrap; color: Theme.text; font.family: Theme.font; font.pixelSize: 13; lineHeight: 1.2
                   text: ns.who + " no está conectado todavía. Conéctalo en Conexiones (la clave se guarda allí, no aquí); después podrás guardar esta regla." }
            Btn { label: "Abrir Conexiones"; onClicked: Session.launch("connect") }
        }
    }

    // ------------------------------------------------------------------ list of rules
    Rectangle {
        id: side
        // narrower when the window is (half the screen), so the right side still has room
        width: Math.round(Math.min(400, Math.max(290, w.width * 0.38))); height: parent.height
        color: Theme.card
        Rectangle { anchors.right: parent.right; width: 1; height: parent.height; color: Theme.border }

        Column {
            id: head
            x: 20; y: 22; width: parent.width - 40
            spacing: 6
            Row {
                spacing: 12
                Image { width: 34; height: 34; sourceSize: Qt.size(68, 68); source: Qt.resolvedUrl("../icons/app-automations.svg"); anchors.verticalCenter: parent.verticalCenter }
                Text { text: "Automatizaciones"; color: Theme.text; font.family: Theme.font; font.pixelSize: 22; font.weight: Font.DemiBold; anchors.verticalCenter: parent.verticalCenter }
            }
            Text { width: parent.width; wrapMode: Text.Wrap; text: "Reglas «cuando pase esto, haz aquello» para tu trabajo. Los comandos se ejecutan aislados."; color: Theme.dim; font.family: Theme.font; font.pixelSize: 13; lineHeight: 1.2; topPadding: 2; bottomPadding: 8 }
            Btn { label: "+  Nueva automatización"; primary: true; width: parent.width; onClicked: w.openForm({}, false) }
        }
        ListView {
            id: list
            anchors.top: head.bottom; anchors.topMargin: 16; anchors.bottom: parent.bottom; anchors.bottomMargin: 12
            x: 12; width: parent.width - 24
            clip: true; spacing: 6
            model: w.items
            ScrollBar.vertical: ScrollBar { policy: ScrollBar.AsNeeded }
            delegate: Rectangle {
                id: card
                required property var modelData
                readonly property bool picked: w.selId === modelData.id && !w.editing
                width: list.width; height: 88; radius: 14
                color: picked ? Theme.alpha(Theme.accent, 0.14) : cardArea.containsMouse ? Theme.hover : "transparent"
                border.color: picked ? Theme.alpha(Theme.accent, 0.5) : "transparent"
                opacity: modelData.enabled ? 1 : 0.6
                MouseArea { id: cardArea; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor; onClicked: w.select(card.modelData.id) }
                Column {
                    x: 16; anchors.verticalCenter: parent.verticalCenter; width: parent.width - 86
                    spacing: 4
                    Row {
                        spacing: 8
                        Rectangle {
                            width: 8; height: 8; radius: 4; anchors.verticalCenter: parent.verticalCenter
                            color: w.statusColor(card.modelData)
                            SequentialAnimation on opacity { running: !!card.modelData.running; loops: Animation.Infinite; NumberAnimation { to: 0.25; duration: 600 } NumberAnimation { to: 1; duration: 600 } }
                        }
                        Text { text: card.modelData.name; color: Theme.text; font.family: Theme.font; font.pixelSize: 15; font.weight: Font.DemiBold; elide: Text.ElideRight; width: card.width - 120 }
                    }
                    Text { text: card.modelData.when + (card.modelData.next ? " · " + w.fmtNext(card.modelData.next) : ""); color: Theme.dim; font.family: Theme.font; font.pixelSize: 13; elide: Text.ElideRight; width: parent.width }
                    Text { text: card.modelData.what; color: Theme.faint; font.family: card.modelData.action.kind === "command" ? Theme.mono : Theme.font; font.pixelSize: 12; elide: Text.ElideRight; width: parent.width }
                }
                NexusSwitch { anchors.right: parent.right; anchors.rightMargin: 16; anchors.verticalCenter: parent.verticalCenter; checked: card.modelData.enabled; onToggled: w.setEnabled(card.modelData.id, checked) }
            }
        }
        Text {
            visible: w.loaded && !w.items.length
            anchors.top: head.bottom; anchors.topMargin: 28; x: 24; width: parent.width - 48
            wrapMode: Text.Wrap; horizontalAlignment: Text.AlignHCenter
            text: "Aún no tienes ninguna."; color: Theme.faint; font.family: Theme.font; font.pixelSize: 13
        }
    }

    Item {
        id: main
        anchors.left: side.right; anchors.right: parent.right; anchors.top: parent.top; anchors.bottom: parent.bottom
        anchors.margins: 28

        // -------------------------------------------------------------- nothing selected: examples
        // (centred when it fits; in a short or narrow window it scrolls instead of being cut at the top)
        Flickable {
            id: emptyFlick
            visible: !w.editing && !w.sel && w.loaded
            anchors.fill: parent
            contentWidth: width; contentHeight: emptyCol.y + emptyCol.height
            clip: true; boundsBehavior: Flickable.StopAtBounds
            ScrollBar.vertical: ScrollBar { policy: ScrollBar.AsNeeded }
            Column {
                id: emptyCol
                width: Math.min(emptyFlick.width, 640)
                x: Math.round((emptyFlick.width - width) / 2)
                y: Math.max(0, Math.round((emptyFlick.height - height) / 2))
                spacing: 14
                Text { width: parent.width; wrapMode: Text.Wrap; text: "Automatiza lo repetitivo"; color: Theme.text; font.family: Theme.font; font.pixelSize: 26; font.weight: Font.DemiBold }
                Text { width: parent.width; wrapMode: Text.Wrap; lineHeight: 1.25; color: Theme.dim; font.family: Theme.font; font.pixelSize: 14
                       text: "Una automatización es una regla: cuándo (al guardar archivos, cada cierto tiempo, a una hora, al entrar o cuando pase algo en un servicio conectado) y qué hace (un comando, un aviso, abrir una app o algo en un servicio). Escríbela con tus palabras o empieza con un ejemplo:" }
                PromptBox {
                    width: parent.width
                    title: "Escríbela con tus palabras"
                    placeholder: "Por ejemplo: «cada vez que entre una factura nueva en Wiwink, avísame» o «todos los días a las 9 haz git pull en mi proyecto api»"
                    button: "Prepararla con NEXUS AI"
                    hint: "Rellena el formulario para que lo revises; no se crea nada hasta que pulses Crear. Cuesta unos 2 céntimos de tu saldo de Claude."
                    busy: w.drafting; error: w.drafting ? "" : w.draftErr
                    onSubmit: (t) => w.draftFromText(t)
                }
                Grid {
                    id: tplGrid
                    columns: parent.width >= 520 ? 2 : 1; spacing: 12
                    Repeater {
                        model: w.templates
                        Rectangle {
                            id: tpl
                            required property var modelData
                            width: Math.min(300, (tplGrid.parent.width - (tplGrid.columns - 1) * 12) / tplGrid.columns); height: 74; radius: 14
                            color: tplArea.containsMouse ? Theme.hover : Theme.card
                            border.color: tplArea.containsMouse ? Theme.accent : Theme.border
                            Column {
                                x: 16; anchors.verticalCenter: parent.verticalCenter; spacing: 4; width: tpl.width - 32
                                Text { width: parent.width; elide: Text.ElideRight; text: tpl.modelData.name; color: Theme.text; font.family: Theme.font; font.pixelSize: 15; font.weight: Font.DemiBold }
                                Text { width: parent.width; elide: Text.ElideRight; text: tpl.modelData.hint; color: Theme.dim; font.family: Theme.font; font.pixelSize: 13 }
                            }
                            MouseArea { id: tplArea; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor; onClicked: w.openForm(tpl.modelData, false) }
                        }
                    }
                }
            }
        }

        // -------------------------------------------------------------- one rule: detail, runs and output
        Item {
            id: detailArea
            visible: !w.editing && !!w.sel
            anchors.fill: parent
            // half the screen or less: the history goes above the output instead of beside it
            readonly property bool narrow: width < 600
            Column {
                id: detailHead
                width: parent.width
                spacing: 14
                Row {
                    spacing: 12
                    Text { text: w.sel ? w.sel.name : ""; width: Math.min(implicitWidth, detailHead.width - pill.width - 32); elide: Text.ElideRight; color: Theme.text; font.family: Theme.font; font.pixelSize: 26; font.weight: Font.DemiBold; anchors.verticalCenter: parent.verticalCenter }
                    Rectangle {
                        anchors.verticalCenter: parent.verticalCenter
                        width: pill.implicitWidth + 20; height: 26; radius: 13
                        color: w.sel && w.sel.enabled ? Theme.alpha(Theme.good, 0.16) : Theme.card2
                        Text { id: pill; anchors.centerIn: parent; text: w.sel && w.sel.enabled ? "Activa" : "En pausa"; color: w.sel && w.sel.enabled ? Theme.good : Theme.dim; font.family: Theme.font; font.pixelSize: 12; font.weight: Font.DemiBold }
                    }
                }
                Flow {
                    spacing: 12
                    width: parent.width
                    Repeater {
                        model: w.sel ? [["Cuándo", w.sel.when + (w.sel.next ? "  ·  próxima: " + w.fmtNext(w.sel.next) : ""), false], ["Qué hace", w.sel.what, w.sel.action.kind === "command"]] : []
                        Rectangle {
                            id: info
                            required property var modelData
                            width: detailArea.narrow ? detailHead.width : (detailHead.width - 12) / 2; height: 70; radius: 14
                            color: Theme.card; border.color: Theme.border
                            Column {
                                x: 16; anchors.verticalCenter: parent.verticalCenter; width: parent.width - 32; spacing: 5
                                Text { text: info.modelData[0]; color: Theme.faint; font.family: Theme.font; font.pixelSize: 12 }
                                Text { text: info.modelData[1]; color: Theme.text; font.family: info.modelData[2] ? Theme.mono : Theme.font; font.pixelSize: 14; elide: Text.ElideRight; width: parent.width }
                            }
                        }
                    }
                }
                Text {
                    visible: !!w.sel && !!w.sel.watch
                    width: parent.width; wrapMode: Text.Wrap; font.family: Theme.font; font.pixelSize: 13
                    color: w.sel && w.sel.watch && w.sel.watch.error ? Theme.danger : Theme.dim
                    text: w.sel ? w.watchText(w.sel) : ""
                }
                Text {
                    visible: !!w.sel && w.sel.action.kind === "service"
                    width: parent.width; wrapMode: Text.Wrap; color: Theme.dim; font.family: Theme.font; font.pixelSize: 13
                    text: "Lo hace el motor de NEXUS con la clave que guardaste en Conexiones (esta app nunca la ve). Cada llamada queda en el registro de auditoría, sin datos de clientes."
                }
                Text {
                    visible: !!w.sel && w.sel.action.kind === "command"
                    width: parent.width; wrapMode: Text.Wrap; color: Theme.dim; font.family: Theme.font; font.pixelSize: 13
                    text: w.sel && w.sel.action.kind === "command" ? "Aislada: el sistema es de solo lectura, tu carpeta personal está oculta salvo " + w.tilde(w.sel.action.cwd) + " (donde puede escribir) y tus ajustes de git y ssh (solo lectura). Se corta a los 10 minutos." : ""
                }
                Flow {
                    width: parent.width
                    spacing: 10
                    Btn { label: w.sel && w.sel.trigger.kind === "service" ? "↻  Comprobar ahora" : "▶  Ejecutar ahora"; primary: true; visible: !!w.sel && !w.sel.running
                          enabled_: !(w.sel && w.sel.watch && w.sel.watch.checking); onClicked: w.runNow() }
                    Btn { label: "■  Detener"; danger: true; visible: !!w.sel && w.sel.running; onClicked: w.stopNow() }
                    Btn { label: "Editar"; onClicked: w.openForm(w.sel, false) }
                    Btn { label: w.confirmDelete ? "¿Seguro? Pulsa otra vez" : "Borrar"; danger: true; onClicked: w.remove() }
                }
                Text { visible: w.actionMsg !== ""; text: w.actionMsg; color: Theme.danger; font.family: Theme.font; font.pixelSize: 13; width: parent.width; wrapMode: Text.Wrap }
                Text { text: "Historial"; color: Theme.text; font.family: Theme.font; font.pixelSize: 16; font.weight: Font.DemiBold; topPadding: 6 }
            }
            Rectangle {
                id: runsBox
                anchors.top: detailHead.bottom; anchors.topMargin: 10
                // (no bottom anchor: switching one on and off does not give the height back when the window resizes)
                readonly property real room: parent.height - detailHead.height - 10
                height: detailArea.narrow ? Math.max(120, Math.round(room * 0.4)) : room
                width: detailArea.narrow ? parent.width : 300; radius: 14
                color: Theme.card; border.color: Theme.border
                ListView {
                    id: runList
                    anchors.fill: parent; anchors.margins: 6
                    clip: true; spacing: 2
                    model: w.runs
                    ScrollBar.vertical: ScrollBar { policy: ScrollBar.AsNeeded }
                    delegate: Rectangle {
                        id: runRow
                        required property var modelData
                        required property int index
                        width: runList.width; height: 54; radius: 10
                        color: w.runIdx === index && !(w.sel && w.sel.running) ? Theme.alpha(Theme.accent, 0.16) : runArea.containsMouse ? Theme.hover : "transparent"
                        MouseArea { id: runArea; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor; onClicked: w.runIdx = runRow.index }
                        Rectangle { x: 12; anchors.verticalCenter: parent.verticalCenter; width: 8; height: 8; radius: 4; color: runRow.modelData.ok ? Theme.good : Theme.danger }
                        Column {
                            x: 30; anchors.verticalCenter: parent.verticalCenter; width: parent.width - 40; spacing: 3
                            Text { text: w.runTitle(runRow.modelData, w.sel) + " · " + w.dur(runRow.modelData.ms); color: Theme.text; font.family: Theme.font; font.pixelSize: 13; elide: Text.ElideRight; width: parent.width }
                            Text { text: w.ago(runRow.modelData.at) + " · " + runRow.modelData.reason; color: Theme.dim; font.family: Theme.font; font.pixelSize: 12; elide: Text.ElideRight; width: parent.width }
                        }
                    }
                }
                Text { visible: !w.runs.length; anchors.centerIn: parent; text: "Todavía no se ha ejecutado"; color: Theme.faint; font.family: Theme.font; font.pixelSize: 13 }
            }
            Rectangle {
                anchors.top: detailArea.narrow ? runsBox.bottom : runsBox.top; anchors.topMargin: detailArea.narrow ? 12 : 0
                anchors.bottom: parent.bottom; anchors.right: parent.right
                anchors.left: detailArea.narrow ? parent.left : runsBox.right; anchors.leftMargin: detailArea.narrow ? 0 : 12
                radius: 14
                color: Theme.dark ? "#0a0d16" : "#f7f8fc"; border.color: Theme.border
                Text {
                    id: outTitle
                    x: 16; y: 12
                    text: w.sel && w.sel.running ? "Salida en directo" : "Salida"
                    color: Theme.faint; font.family: Theme.font; font.pixelSize: 12; font.weight: Font.DemiBold
                }
                Btn {
                    anchors.right: parent.right; anchors.rightMargin: 10; y: 7
                    height: 30
                    visible: !!w.curRun && !w.curRun.ok && !(w.sel && w.sel.running) && String(w.curRun.output || "").trim() !== "" && w.aiFor !== w.curRun.id
                    label: "¿Por qué ha fallado?  ◆"
                    onClicked: w.explain()
                }
                Rectangle {
                    id: aiBox
                    visible: !!w.curRun && w.aiFor === w.curRun.id && (w.aiBusy || w.aiAnswer !== "")
                    anchors.top: outTitle.bottom; anchors.topMargin: 10
                    x: 12; width: parent.width - 24
                    height: visible ? Math.min(aiText.implicitHeight + 26, parent.height * 0.6) : 0
                    radius: 12
                    color: Theme.alpha(Theme.accent, 0.10); border.color: Theme.alpha(Theme.accent, 0.35)
                    NexusMark { x: 12; y: 12; width: 18; height: 18 }
                    Flickable {
                        x: 40; y: 10; width: parent.width - 52; height: parent.height - 20
                        clip: true; contentHeight: aiText.implicitHeight
                        TextEdit {
                            id: aiText
                            width: parent.width
                            readOnly: true; selectByMouse: true; wrapMode: TextEdit.Wrap; textFormat: TextEdit.PlainText
                            color: Theme.text; selectionColor: Theme.alpha(Theme.accent, 0.45); selectedTextColor: Theme.text
                            font.family: Theme.font; font.pixelSize: 14
                            text: w.aiBusy ? "NEXUS AI está leyendo la salida…" : w.aiAnswer
                        }
                    }
                }
                Flickable {
                    id: outFlick
                    anchors.top: aiBox.visible ? aiBox.bottom : outTitle.bottom; anchors.topMargin: aiBox.visible ? 10 : 8; anchors.bottom: parent.bottom; anchors.bottomMargin: 10
                    x: 16; width: parent.width - 28
                    clip: true
                    contentWidth: width; contentHeight: out.paintedHeight + 8
                    ScrollBar.vertical: ScrollBar { policy: ScrollBar.AsNeeded }
                    onContentHeightChanged: if (w.sel && w.sel.running) contentY = Math.max(0, contentHeight - height)
                    TextEdit {
                        id: out
                        width: outFlick.width - 12
                        readOnly: true; selectByMouse: true; wrapMode: TextEdit.Wrap
                        textFormat: TextEdit.PlainText
                        color: Theme.text; selectionColor: Theme.alpha(Theme.accent, 0.45); selectedTextColor: Theme.text
                        font.family: Theme.mono; font.pixelSize: 13
                        text: w.sel && w.sel.running ? (w.live || "Esperando salida…") : (w.runs.length ? (String(w.runs[Math.min(w.runIdx, w.runs.length - 1)].output || "") || "(sin salida)") : "")
                    }
                }
            }
        }

        // -------------------------------------------------------------- create / edit
        Flickable {
            id: formFlick
            visible: w.editing
            anchors.fill: parent
            clip: true
            contentHeight: form.height + 24
            ScrollBar.vertical: ScrollBar { policy: ScrollBar.AsNeeded }
            Column {
                id: form
                width: Math.min(formFlick.width - 16, 660)
                spacing: 12
                Text { text: w.fId ? "Editar automatización" : "Nueva automatización"; color: Theme.text; font.family: Theme.font; font.pixelSize: 26; font.weight: Font.DemiBold; bottomPadding: 4 }
                PromptBox {
                    visible: !w.fId && !w.fromAi
                    width: parent.width
                    title: "Escríbela con tus palabras"
                    placeholder: "Cuéntale qué quieres que pase y cuándo. Por ejemplo: «cuando guarde algo en ~/proyectos/web, pasa los tests y avísame solo si fallan»"
                    button: "Rellenar con NEXUS AI"
                    hint: "O rellena el formulario a mano aquí debajo. Unos 2 céntimos de tu saldo de Claude."
                    busy: w.drafting; error: w.drafting ? "" : w.draftErr
                    onSubmit: (t) => w.draftFromText(t)
                }
                Rectangle {
                    visible: w.fromAi
                    width: parent.width; height: 52; radius: 14
                    color: Theme.alpha(Theme.accent, 0.12); border.color: Theme.alpha(Theme.accent, 0.4)
                    NexusMark { x: 16; anchors.verticalCenter: parent.verticalCenter; width: 22; height: 22 }
                    Text { x: 50; anchors.verticalCenter: parent.verticalCenter; width: parent.width - 66; wrapMode: Text.Wrap; text: "NEXUS AI lo ha rellenado. Revísalo: no se crea ni se ejecuta nada hasta que pulses Crear."; color: Theme.text; font.family: Theme.font; font.pixelSize: 13 }
                }
                Label_ { text: "Nombre" }
                Field { id: fName; width: parent.width; placeholderText: "Por ejemplo: Tests de la web"; maximumLength: 80 }

                Label_ { text: "Cuándo"; topPadding: 6 }
                Flow {
                    width: parent.width; spacing: 8
                    Repeater { model: w.whenKinds; Chip { required property var modelData; label: modelData[1]; on: w.fWhen === modelData[0]; onPicked: w.fWhen = modelData[0] } }
                }
                Row {
                    visible: w.fWhen === "interval"; spacing: 10
                    Text { text: "Cada"; color: Theme.text; font.family: Theme.font; font.pixelSize: 14; anchors.verticalCenter: parent.verticalCenter }
                    Field { id: fMin; width: 100; inputMethodHints: Qt.ImhDigitsOnly; validator: IntValidator { bottom: 1; top: 10080 } }
                    Text { text: "minutos"; color: Theme.text; font.family: Theme.font; font.pixelSize: 14; anchors.verticalCenter: parent.verticalCenter }
                }
                Row {
                    visible: w.fWhen === "daily"; spacing: 10
                    Text { text: "A las"; color: Theme.text; font.family: Theme.font; font.pixelSize: 14; anchors.verticalCenter: parent.verticalCenter }
                    Field { id: fTime; width: 100; placeholderText: "09:00"; mono: true; maximumLength: 5 }
                    Text { text: "(si el equipo estaba apagado, se ejecuta al encenderlo ese día)"; color: Theme.faint; font.family: Theme.font; font.pixelSize: 12; anchors.verticalCenter: parent.verticalCenter }
                }
                Column {
                    visible: w.fWhen === "files"; spacing: 6; width: parent.width
                    Field { id: fPath; width: parent.width; mono: true; placeholderText: "~/proyectos/web" }
                    Text { text: "Vigila la carpeta y sus subcarpetas. Se ignoran .git, node_modules, dist, build, target y similares."; color: Theme.faint; font.family: Theme.font; font.pixelSize: 12; width: parent.width; wrapMode: Text.Wrap }
                }
                Text { visible: w.fWhen === "login"; text: "Una vez cada vez que entras en NEXUS."; color: Theme.faint; font.family: Theme.font; font.pixelSize: 12 }
                Column {
                    visible: w.fWhen === "service"; spacing: 8; width: parent.width
                    Flow {
                        width: parent.width; spacing: 8
                        Repeater { model: w.watchers; Chip { required property var modelData; label: modelData.name + (modelData.connected ? "" : " · sin conectar"); on: w.fTConn === modelData.id; onPicked: w.pickTConn(modelData.id) } }
                    }
                    NoServices { visible: !!w.tConn && !w.tConn.connected; who: w.tConn ? w.tConn.name : "" }
                    Flow {
                        width: parent.width; spacing: 8
                        Repeater { model: w.tConn ? w.tConn.triggers : []; Chip { required property var modelData; label: modelData.name; on: w.fTrig === modelData.id; onPicked: w.pickTrig(modelData.id) } }
                    }
                    Text { visible: !!w.tDef; text: w.tDef ? w.tDef.description : ""; color: Theme.faint; font.family: Theme.font; font.pixelSize: 12; width: parent.width; wrapMode: Text.Wrap }
                    ParamFields { params: w.tDef ? w.tDef.params : []; values: w.fTIn; gen: w.fGen; onEdited: (k, v) => w.setIn("t", k, v); onFocusedField: (f) => w.lastField = f }
                    Row {
                        spacing: 10
                        Text { text: "Lo mira cada"; color: Theme.text; font.family: Theme.font; font.pixelSize: 14; anchors.verticalCenter: parent.verticalCenter }
                        Field { id: fSvcMin; width: 90; inputMethodHints: Qt.ImhDigitsOnly; validator: IntValidator { bottom: 1; top: 1440 } }
                        Text { text: "minutos"; color: Theme.text; font.family: Theme.font; font.pixelSize: 14; anchors.verticalCenter: parent.verticalCenter }
                    }
                    Text { width: parent.width; wrapMode: Text.Wrap; color: Theme.faint; font.family: Theme.font; font.pixelSize: 12; lineHeight: 1.2
                           text: "La primera vez solo apunta lo que ya existe (no hace nada con ello). Desde entonces, cada cosa nueva ejecuta la acción una vez, con sus datos." }
                }

                Label_ { text: "Qué hace"; topPadding: 6 }
                Flow {
                    width: parent.width; spacing: 8
                    Repeater { model: w.doKinds; Chip { required property var modelData; label: modelData[1]; on: w.fDo === modelData[0]; onPicked: w.fDo = modelData[0] } }
                }
                Column {
                    visible: w.fDo === "command"; spacing: 8; width: parent.width
                    Field { id: fCmd; width: parent.width; mono: true; placeholderText: "npm test" }
                    Row {
                        spacing: 10; width: parent.width
                        Text { id: inLbl; text: "En la carpeta"; color: Theme.text; font.family: Theme.font; font.pixelSize: 14; anchors.verticalCenter: parent.verticalCenter }
                        Field { id: fCwd; width: parent.width - inLbl.width - 10; mono: true; placeholderText: w.fWhen === "files" && fPath.text ? fPath.text + "  (la misma que vigila)" : "~/proyectos/web" }
                    }
                    Text { width: parent.width; wrapMode: Text.Wrap; color: Theme.faint; font.family: Theme.font; font.pixelSize: 12
                           text: "Se ejecuta aislado con bubblewrap: solo puede escribir en esa carpeta (y en las cachés de npm/cargo); no ve el resto de tus archivos ni las claves de NEXUS. Tiene red, para git pull o npm install." }
                }
                Field { id: fText; visible: w.fDo === "notify"; width: parent.width; placeholderText: w.fWhen === "service" ? "Factura nueva de {{cliente.nombre}}: {{factura.total}} €" : "Levántate y estira las piernas"; maximumLength: 200
                        onActiveFocusChanged: if (activeFocus) w.lastField = fText }
                Text { visible: w.fDo === "command" && w.fWhen === "service"; width: parent.width; wrapMode: Text.Wrap; color: Theme.faint; font.family: Theme.font; font.pixelSize: 12
                       text: "Lo que ha pasado en el servicio le llega al comando en la variable $NEXUS_EVENTO (JSON) y su título en $NEXUS_EVENTO_TITULO. Nunca se pega dentro del comando." }
                Column {
                    visible: w.fDo === "service"; spacing: 8; width: parent.width
                    Flow {
                        width: parent.width; spacing: 8
                        Repeater { model: w.doers; Chip { required property var modelData; label: modelData.name + (modelData.connected ? "" : " · sin conectar"); on: w.fAConn === modelData.id; onPicked: w.pickAConn(modelData.id) } }
                    }
                    NoServices { visible: !!w.aConn && !w.aConn.connected; who: w.aConn ? w.aConn.name : "" }
                    Flow {
                        width: parent.width; spacing: 8
                        Repeater { model: w.aConn ? w.aConn.operations : []; Chip { required property var modelData; label: modelData.name + (modelData.kind === "read" ? " (solo lee)" : ""); on: w.fOp === modelData.id; onPicked: w.pickOp(modelData.id) } }
                    }
                    Text { visible: !!w.aDef; text: w.aDef ? w.aDef.description : ""; color: Theme.faint; font.family: Theme.font; font.pixelSize: 12; width: parent.width; wrapMode: Text.Wrap }
                    ParamFields { params: w.aDef ? w.aDef.params : []; values: w.fAIn; gen: w.fGen; onEdited: (k, v) => w.setIn("a", k, v); onFocusedField: (f) => w.lastField = f }
                }
                Column {
                    visible: w.eventFields.length > 0 && (w.fDo === "service" || w.fDo === "notify"); spacing: 6; width: parent.width
                    Text { text: "Datos de lo que ha pasado: toca uno para ponerlo en el campo donde estás escribiendo"; color: Theme.faint; font.family: Theme.font; font.pixelSize: 12; width: parent.width; wrapMode: Text.Wrap }
                    Flow {
                        width: parent.width; spacing: 6
                        Repeater {
                            model: w.eventFields
                            Rectangle {
                                id: ev
                                required property var modelData
                                width: evText.implicitWidth + 18; height: 26; radius: 13
                                color: evArea.containsMouse ? Theme.alpha(Theme.accent, 0.22) : Theme.alpha(Theme.accent, 0.10); border.color: Theme.alpha(Theme.accent, 0.4)
                                Text { id: evText; anchors.centerIn: parent; text: ev.modelData.label; color: Theme.text; font.family: Theme.font; font.pixelSize: 12 }
                                MouseArea { id: evArea; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor; onClicked: w.insertField(ev.modelData.key) }
                            }
                        }
                    }
                }
                Flow {
                    visible: w.fDo === "open"; width: parent.width; spacing: 8
                    Repeater {
                        model: Object.keys(Session.apps).filter(function(k) { return k !== "automations" })
                        Chip { required property string modelData; label: (Session.apps[modelData] || {}).name || modelData; on: w.fApp === modelData; onPicked: w.fApp = modelData }
                    }
                }

                Label_ { visible: w.fDo === "command" || w.fDo === "service"; text: "Avisarme"; topPadding: 6 }
                Flow {
                    visible: w.fDo === "command" || w.fDo === "service"; width: parent.width; spacing: 8
                    Repeater { model: w.notifyKinds; Chip { required property var modelData; label: modelData[1]; on: w.fNotify === modelData[0]; onPicked: w.fNotify = modelData[0] } }
                }

                Text { visible: w.formErr !== ""; text: w.formErr; color: Theme.danger; font.family: Theme.font; font.pixelSize: 13; width: parent.width; wrapMode: Text.Wrap; topPadding: 4 }
                Row {
                    spacing: 10; topPadding: 8
                    Btn { label: w.saving ? "Guardando…" : w.fId ? "Guardar cambios" : "Crear"; primary: true; enabled_: !w.saving; onClicked: w.save() }
                    Btn { label: "Cancelar"; onClicked: { w.editing = false; w.fromAi = false; if (!w.sel && w.items.length) w.select(w.items[0].id) } }
                }
            }
        }
    }
    Shortcut { sequences: ["Ctrl+N", "Meta+N"]; onActivated: w.openForm({}, false) }
    Shortcut { sequence: "Escape"; enabled: w.editing; onActivated: { w.editing = false; w.fromAi = false } }
    Shortcut { sequences: ["Ctrl+Return", "Meta+Return"]; enabled: w.editing; onActivated: w.save() }
}
