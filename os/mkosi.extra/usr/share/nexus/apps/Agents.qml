import QtQuick
import QtQuick.Window
import QtQuick.Controls
import "../shell"

// Agentes: AI agents (Claude Code or any MCP client) working on your projects, run by nexus-sessiond
// (core/src/agentd.ts). Each agent has a folder and capabilities written as MCP URIs; it runs isolated with
// `nexus-agente <nombre> -- claude`. Critical commands wait here for the person's click, after the review committee.
Window {
    id: w
    visible: true
    width: 1180; height: 760
    minimumWidth: 940; minimumHeight: 560
    title: "Agentes"
    color: Theme.bg

    property var agents: []
    property var runs: []
    property var approvals: []
    property bool loaded: false
    property string selId: ""
    readonly property var sel: { for (var i = 0; i < agents.length; i++) if (agents[i].id === selId) return agents[i]; return null }
    readonly property var selRun: { if (!sel) return null; for (var i = 0; i < runs.length; i++) if (runs[i].agent === sel.id) return runs[i]; return null }
    property bool editing: false
    property string fId: ""
    property var fPerms: ({})
    property bool fCouncil: true
    property string formErr: ""
    property bool saving: false
    property bool confirmDelete: false
    property string copied: ""
    property string tab: "codigo"       // codigo = agents on your projects · agencias = teams (Agencias.qml)
    // «Escríbelo con tus palabras»: NEXUS AI fills the form, the person reviews it and presses Crear
    property bool drafting: false
    property string draftErr: ""
    property bool fromAi: false
    property string draftUsd: ""

    readonly property var permKinds: [
        ["read", "Leer archivos", "fs://read"], ["write", "Escribir archivos", "fs://write"], ["exec", "Ejecutar comandos", "exec://"],
        ["memory", "Memoria compartida", "memory://proyecto"], ["system", "Estado del sistema", "system://read"], ["logs", "Registros", "logs://read"],
        ["automations", "Proponer automatizaciones", "automations://propose"], ["notify", "Avisos en el escritorio", "notify://desktop"]
    ]

    function tilde(p) { return String(p || "").replace(/^\/home\/[^\/]+(?=\/|$)/, "~") }
    function cap(s) { s = String(s || ""); return s.charAt(0).toUpperCase() + s.slice(1) }
    function ago(iso) {
        var d = (Session.now.getTime() - new Date(iso).getTime()) / 1000
        if (!(d >= 0)) return ""
        if (d < 45) return "hace un momento"
        if (d < 3600) return "hace " + Math.round(d / 60) + " min"
        if (d < 86400) return "hace " + Math.round(d / 3600) + " h"
        return new Date(iso).toLocaleDateString(Qt.locale("es_ES"), "d MMM")
    }
    function hm(iso) { return new Date(iso).toLocaleTimeString(Qt.locale("es_ES"), "HH:mm:ss") }
    function usd(n) { n = Number(n || 0); return (n > 0 && n < 0.0001 ? "<0,0001" : n.toFixed(n > 0 && n < 0.1 ? 4 : 2).replace(".", ",")) + " $" }
    function big(n) { n = Number(n || 0); return n >= 1e6 ? (n / 1e6).toFixed(1).replace(".", ",") + " M" : n >= 1e3 ? Math.round(n / 1e3) + " k" : String(n) }
    function runOf(a) { for (var i = 0; i < runs.length; i++) if (runs[i].agent === a.id) return runs[i]; return null }
    function liveOf(a) { var r = runOf(a); return r && (r.status === "running" || r.status === "waiting") ? r : null }
    function dotColor(a) { var r = liveOf(a); return !r ? Theme.faint : r.status === "waiting" ? Theme.warn : Theme.good }
    function stateText(a) {
        var r = runOf(a)
        if (!r) return "Aún no ha trabajado"
        if (r.status === "running") return "Trabajando · " + r.calls + " llamadas"
        if (r.status === "waiting") return "Esperando tu permiso"
        if (r.status === "halted") return "Detenido " + ago(r.ended || r.started)
        return "Terminó " + ago(r.ended || r.started)
    }
    function scopeLabel(u) {
        var m = /^fs:\/\/read\/(.*)$/.exec(u); if (m) return "Leer " + m[1]
        m = /^fs:\/\/write\/(.*)$/.exec(u); if (m) return "Escribir " + m[1]
        m = /^exec:\/\/(.*)$/.exec(u); if (m) return "Ejecutar en " + m[1]
        var plain = { "memory://proyecto": "Memoria compartida", "system://read": "Estado del sistema", "logs://read": "Registros", "automations://propose": "Proponer automatizaciones", "notify://desktop": "Avisos" }
        return plain[u] || u
    }
    function outcomeColor(o) { return o === "ok" || o === "approved" ? Theme.good : o === "error" || o === "denied" ? Theme.danger : o === "waiting" ? Theme.warn : Theme.dim }
    function outcomeGlyph(o) { return o === "ok" ? "✓" : o === "approved" ? "✓" : o === "error" ? "✕" : o === "denied" ? "✕" : o === "waiting" ? "…" : "◆" }

    function load() {
        Session.request("GET", "/agents", null, function(st, j) {
            if (st !== 200 || !j) return
            w.agents = j.agents || []; w.runs = j.runs || []; w.approvals = j.approvals || []; w.loaded = true
            if (w.selId && !w.sel) w.selId = ""
            if (!w.selId && w.agents.length && !w.editing) w.selId = w.agents[0].id
        })
    }
    function post(path, body, done) {
        Session.request("POST", path, body || {}, function(st, j) { if (done) done(st, j); w.load() })
    }
    function decide(id, yes) { post("/agents/approvals/" + id, { approve: yes }) }
    function halt() { var r = liveOf(sel); if (r) post("/agents/runs/" + r.id + "/halt", {}) }
    function remove() {
        if (!confirmDelete) { confirmDelete = true; deleteReset.restart(); return }
        post("/agents/" + sel.id + "/delete", {}, function() { w.selId = ""; w.confirmDelete = false })
    }
    function copy(s) { clip.text = s; clip.selectAll(); clip.copy(); copied = s; copiedReset.restart() }
    function openForm(a, ai) {
        editing = true; formErr = ""; confirmDelete = false; draftErr = ""; fromAi = !!ai
        fId = a ? (a.id || "") : ""
        fName.text = a ? a.name : ""
        fFolder.text = a ? a.folderShort : "~/proyectos/"
        fCheck.text = a ? (a.check || "") : ""
        fBrief.text = a ? (a.brief || "") : ""
        fCalls.text = String(a ? a.maxCalls : 400); fMinutes.text = String(a ? a.maxMinutes : 240); fTokens.text = String(a ? a.maxTokens : 2000000); fUsd.text = String(a ? a.maxUsd : 5).replace(".", ",")
        fCouncil = a ? a.council !== false : true
        var p = { read: true, write: true, exec: true, memory: true, system: true }
        if (a && a.perms) {         // a draft from NEXUS AI: the permissions it proposes
            p = {}
            for (var j = 0; j < a.perms.length; j++) p[a.perms[j]] = true
        } else if (a) {
            p = {}
            for (var i = 0; i < a.scopes.length; i++) {
                var u = a.scopes[i]
                if (u.indexOf("fs://read/") === 0) p.read = true; else if (u.indexOf("fs://write/") === 0) p.write = true; else if (u.indexOf("exec://") === 0) p.exec = true
                else if (u === "memory://proyecto") p.memory = true; else if (u === "system://read") p.system = true; else if (u === "logs://read") p.logs = true
                else if (u === "automations://propose") p.automations = true; else if (u === "notify://desktop") p.notify = true
            }
        }
        fPerms = p
        if (!ai) fName.forceActiveFocus()
    }
    function draftFromText(t) {
        drafting = true; draftErr = ""
        Session.request("POST", "/agents/draft", { texto: t }, function(st, j) {
            w.drafting = false
            if (st === 200 && j && j.draft) { w.draftUsd = Number(j.usd || 0).toFixed(3).replace(".", ","); w.openForm(j.draft, true) }
            else w.draftErr = w.cap(j && j.error ? j.error : "NEXUS AI no ha podido prepararlo (error " + st + ")") + "."
        })
    }
    function togglePerm(k) { var p = Object.assign({}, fPerms); p[k] = !p[k]; if (k === "write" && p.write) p.read = true; if (k === "read" && !p.read) p.write = false; fPerms = p }
    function save() {
        var folder = fFolder.text.trim().replace(/\/+$/, "")
        var scopes = []
        if (fPerms.read || fPerms.write) scopes.push("fs://read/" + folder)
        if (fPerms.write) scopes.push("fs://write/" + folder)
        if (fPerms.exec) scopes.push("exec://" + folder)
        var plain = { memory: "memory://proyecto", system: "system://read", logs: "logs://read", automations: "automations://propose", notify: "notify://desktop" }
        for (var k in plain) if (fPerms[k]) scopes.push(plain[k])
        var body = { name: fName.text, folder: folder, scopes: scopes, check: fCheck.text.trim(), brief: fBrief.text.trim(), council: fCouncil,
                     maxCalls: Number(fCalls.text), maxMinutes: Number(fMinutes.text), maxTokens: Number(fTokens.text), maxUsd: Number(fUsd.text.replace(",", ".")) }
        if (fId) body.id = fId
        saving = true; formErr = ""
        Session.request("POST", "/agents", body, function(st, j) {
            w.saving = false
            if (st === 200 && j && j.id) { w.editing = false; w.selId = j.id; w.load() }
            else w.formErr = cap(j && j.error ? j.error : "no se ha podido guardar (error " + st + ")") + "."
        })
    }

    Component.onCompleted: load()
    Connections {
        target: Session
        function onAgentsChanged() { reloadSoon.restart() }
        function onAgentApproval(id) { w.load(); w.raise(); w.requestActivate() }
    }
    Timer { id: reloadSoon; interval: 150; onTriggered: w.load() }
    Timer { interval: 5000; repeat: true; running: true; onTriggered: w.load() }   // "hace N min", and runs ended elsewhere
    Timer { id: deleteReset; interval: 3500; onTriggered: w.confirmDelete = false }
    Timer { id: copiedReset; interval: 1800; onTriggered: w.copied = "" }
    TextEdit { id: clip; visible: false }

    // ------------------------------------------------------------------ small building blocks
    component Chip: Rectangle {
        id: chip
        property string label: ""
        property bool on: false
        signal picked()
        width: chipText.implicitWidth + 28; height: 34; radius: 17
        color: on ? Theme.alpha(Theme.accent, 0.22) : chipArea.containsMouse ? Theme.hover : Theme.card2
        border.color: on ? Theme.accent : Theme.border
        Text { id: chipText; anchors.centerIn: parent; text: (chip.on ? "✓  " : "") + chip.label; color: chip.on ? Theme.text : Theme.dim; font.family: Theme.font; font.pixelSize: 13; font.weight: chip.on ? Font.DemiBold : Font.Normal }
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
    component Card: Rectangle { radius: 16; color: Theme.card; border.color: Theme.border }
    component Seg: Rectangle {
        id: seg
        property var options: []
        property string current: ""
        signal picked(string id)
        width: segRow.implicitWidth + 8; height: 36; radius: 12; color: Theme.card2; border.color: Theme.border
        Row {
            id: segRow; x: 4; anchors.verticalCenter: parent.verticalCenter; spacing: 2
            Repeater {
                model: seg.options
                Rectangle {
                    id: segBtn
                    required property var modelData
                    width: segText.implicitWidth + 24; height: 28; radius: 9
                    color: seg.current === modelData[0] ? Theme.accent : segArea.containsMouse ? Theme.hover : "transparent"
                    Text { id: segText; anchors.centerIn: parent; text: segBtn.modelData[1]; color: seg.current === segBtn.modelData[0] ? "#ffffff" : Theme.dim; font.family: Theme.font; font.pixelSize: 13; font.weight: Font.DemiBold }
                    MouseArea { id: segArea; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor; onClicked: seg.picked(segBtn.modelData[0]) }
                }
            }
        }
    }

    // ------------------------------------------------------------------ Agencias: teams of AI workers (its own file)
    Agencias { anchors.fill: parent; visible: w.tab === "agencias"; onSwitchTab: (t) => w.tab = t }

    // ------------------------------------------------------------------ list of agents
    Rectangle {
        id: side
        visible: w.tab === "codigo"
        // narrower when the window is (half the screen), so the right side still has room
        width: Math.round(Math.min(380, Math.max(280, w.width * 0.36))); height: parent.height
        color: Theme.card
        Rectangle { anchors.right: parent.right; width: 1; height: parent.height; color: Theme.border }
        Column {
            id: head
            x: 20; y: 22; width: parent.width - 40
            spacing: 6
            Row {
                spacing: 12
                Image { width: 34; height: 34; sourceSize: Qt.size(68, 68); source: Qt.resolvedUrl("../icons/app-agents.svg"); anchors.verticalCenter: parent.verticalCenter }
                Text { text: "Agentes"; color: Theme.text; font.family: Theme.font; font.pixelSize: 22; font.weight: Font.DemiBold; anchors.verticalCenter: parent.verticalCenter }
            }
            Seg { options: [["codigo", "Código"], ["agencias", "Agencias"]]; current: w.tab; onPicked: (id) => w.tab = id }
            Text { width: parent.width; wrapMode: Text.Wrap; text: "Agentes de IA trabajando aislados en tus proyectos, con los permisos que tú decides. NEXUS los vigila y te pregunta lo importante."; color: Theme.dim; font.family: Theme.font; font.pixelSize: 13; lineHeight: 1.2; topPadding: 2; bottomPadding: 8 }
            Btn { label: "+  Nuevo agente"; primary: true; width: parent.width; onClicked: w.openForm(null) }
        }
        ListView {
            id: list
            anchors.top: head.bottom; anchors.topMargin: 16; anchors.bottom: parent.bottom; anchors.bottomMargin: 12
            x: 12; width: parent.width - 24
            clip: true; spacing: 6
            model: w.agents
            delegate: Rectangle {
                id: card
                required property var modelData
                readonly property bool picked: w.selId === modelData.id && !w.editing
                width: list.width; height: 76; radius: 14
                color: picked ? Theme.alpha(Theme.accent, 0.14) : cardArea.containsMouse ? Theme.hover : "transparent"
                border.color: picked ? Theme.alpha(Theme.accent, 0.5) : "transparent"
                MouseArea { id: cardArea; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor; onClicked: { w.editing = false; w.confirmDelete = false; w.selId = card.modelData.id } }
                Column {
                    x: 16; anchors.verticalCenter: parent.verticalCenter; width: parent.width - 32
                    spacing: 4
                    Row {
                        spacing: 8
                        Rectangle {
                            width: 9; height: 9; radius: 5; anchors.verticalCenter: parent.verticalCenter
                            color: w.dotColor(card.modelData)
                            SequentialAnimation on opacity { running: !!w.liveOf(card.modelData); loops: Animation.Infinite; NumberAnimation { to: 0.25; duration: 650 } NumberAnimation { to: 1; duration: 650 } }
                        }
                        Text { text: card.modelData.name; color: Theme.text; font.family: Theme.font; font.pixelSize: 15; font.weight: Font.DemiBold; elide: Text.ElideRight; width: card.width - 60 }
                    }
                    Text { text: card.modelData.folderShort; color: Theme.dim; font.family: Theme.mono; font.pixelSize: 12; elide: Text.ElideRight; width: parent.width }
                    Text { text: w.stateText(card.modelData); color: w.liveOf(card.modelData) ? (w.liveOf(card.modelData).status === "waiting" ? Theme.warn : Theme.good) : Theme.faint; font.family: Theme.font; font.pixelSize: 12 }
                }
            }
        }
        Text {
            visible: w.loaded && !w.agents.length
            anchors.top: head.bottom; anchors.topMargin: 28; x: 24; width: parent.width - 48
            wrapMode: Text.Wrap; horizontalAlignment: Text.AlignHCenter
            text: "Aún no tienes ninguno."; color: Theme.faint; font.family: Theme.font; font.pixelSize: 13
        }
    }

    Item {
        id: main
        visible: w.tab === "codigo"
        anchors.left: side.right; anchors.right: parent.right; anchors.top: parent.top; anchors.bottom: parent.bottom
        anchors.margins: 28

        // -------------------------------------------------------------- approvals: always on top, for every agent
        Column {
            id: asks
            width: parent.width
            spacing: 12
            visible: w.approvals.length > 0 && !w.editing
            Repeater {
                model: w.approvals
                Rectangle {
                    id: ask
                    required property var modelData
                    width: asks.width; radius: 16
                    height: askCol.implicitHeight + 32
                    color: Theme.alpha(Theme.warn, 0.10); border.color: Theme.alpha(Theme.warn, 0.6); border.width: 1.5
                    Column {
                        id: askCol
                        x: 20; y: 16; width: parent.width - 40
                        spacing: 10
                        Row {
                            spacing: 10
                            Text { text: "◆"; color: Theme.warn; font.pixelSize: 16; anchors.verticalCenter: parent.verticalCenter }
                            Text { text: ask.modelData.agentName + " pide permiso"; color: Theme.text; font.family: Theme.font; font.pixelSize: 16; font.weight: Font.DemiBold; anchors.verticalCenter: parent.verticalCenter }
                            Text { text: "· " + w.ago(ask.modelData.at) + " · se rechaza solo a los 5 min"; color: Theme.dim; font.family: Theme.font; font.pixelSize: 12; anchors.verticalCenter: parent.verticalCenter }
                        }
                        Rectangle {
                            width: parent.width; height: cmdText.implicitHeight + 20; radius: 10; color: Theme.card
                            Text { id: cmdText; x: 14; y: 10; width: parent.width - 28; wrapMode: Text.WrapAnywhere; text: ask.modelData.title; color: Theme.text; font.family: Theme.mono; font.pixelSize: 14 }
                        }
                        Text { width: parent.width; wrapMode: Text.Wrap; text: ask.modelData.detail; color: Theme.dim; font.family: Theme.font; font.pixelSize: 13 }
                        Column {
                            width: parent.width; spacing: 6
                            visible: !!ask.modelData.council
                            Text { text: ask.modelData.council ? "Comité de revisión: " + ask.modelData.council.yes + " de 3 a favor" : ""; color: Theme.text; font.family: Theme.font; font.pixelSize: 13; font.weight: Font.DemiBold }
                            Repeater {
                                model: ask.modelData.council ? ask.modelData.council.verdicts : []
                                Row {
                                    id: vrow
                                    required property var modelData
                                    spacing: 8
                                    Text { text: vrow.modelData.error ? "–" : vrow.modelData.approve ? "✓" : "✕"; color: vrow.modelData.error ? Theme.faint : vrow.modelData.approve ? Theme.good : Theme.danger; font.pixelSize: 13; font.weight: Font.Bold; width: 14 }
                                    Text { text: w.cap(vrow.modelData.role); color: Theme.text; font.family: Theme.font; font.pixelSize: 13; font.weight: Font.DemiBold; width: 100 }
                                    Text { text: vrow.modelData.summary; color: Theme.dim; font.family: Theme.font; font.pixelSize: 13; width: askCol.width - 130; wrapMode: Text.Wrap }
                                }
                            }
                        }
                        Row {
                            spacing: 10
                            Btn { label: "Aprobar"; primary: true; onClicked: w.decide(ask.modelData.id, true) }
                            Btn { label: "Rechazar"; danger: true; onClicked: w.decide(ask.modelData.id, false) }
                        }
                    }
                }
            }
        }

        // -------------------------------------------------------------- nothing yet: what agents are
        // (centred when it fits; in a short or narrow window it scrolls instead of being cut at the top)
        Flickable {
            id: emptyFlick
            visible: !w.editing && !w.sel && w.loaded && !w.approvals.length
            anchors.fill: parent
            contentWidth: width; contentHeight: emptyCol.y + emptyCol.height
            clip: true; boundsBehavior: Flickable.StopAtBounds
            ScrollBar.vertical: ScrollBar { policy: ScrollBar.AsNeeded }
            Column {
                id: emptyCol
                width: Math.min(emptyFlick.width, 680)
                x: Math.round((emptyFlick.width - width) / 2)
                y: Math.max(0, Math.round((emptyFlick.height - height) / 2))
                spacing: 14
                Text { width: parent.width; wrapMode: Text.Wrap; text: "Tus agentes, bajo control"; color: Theme.text; font.family: Theme.font; font.pixelSize: 26; font.weight: Font.DemiBold }
                Text { width: parent.width; wrapMode: Text.Wrap; lineHeight: 1.25; color: Theme.dim; font.family: Theme.font; font.pixelSize: 14
                       text: "Un agente es un programa de IA (Claude Code o cualquiera que hable MCP) que trabaja en un proyecto. Créalo aquí, dale una carpeta y permisos, y arráncalo en la terminal con «nexus-agente nombre -- claude»." }
                PromptBox {
                    width: parent.width
                    placeholder: "Por ejemplo: «un agente para mi web de ~/Projects/finolas-web que arregle fallos y escriba tests, sin poder publicar nada»"
                    button: "Prepararlo con NEXUS AI"
                    hint: "NEXUS AI rellena el formulario (carpeta, permisos, límites); tú lo revisas antes de crearlo. Cuesta unos 2 céntimos."
                    busy: w.drafting; error: w.drafting ? "" : w.draftErr
                    onSubmit: (t) => w.draftFromText(t)
                }
                Grid {
                    id: featGrid
                    columns: parent.width >= 560 ? 2 : 1; spacing: 12
                    Repeater {
                        model: [
                            ["Aislado", "Solo ve su carpeta. Sin tus claves SSH, sin tokens, sin escritorio."],
                            ["Tú decides lo crítico", "git push, borrar carpetas, DROP TABLE o desplegar esperan tu clic."],
                            ["Comité de revisión", "Cada commit lo revisan tres IA: arquitectura, seguridad y rendimiento."],
                            ["Se corrige solo", "Si sus cambios rompen los tests, NEXUS se lo dice al momento."]
                        ]
                        Card {
                            id: feat
                            required property var modelData
                            width: Math.min(330, (featGrid.parent.width - (featGrid.columns - 1) * 12) / featGrid.columns)
                            height: Math.max(84, featCol.implicitHeight + 28)
                            Column {
                                id: featCol
                                x: 16; anchors.verticalCenter: parent.verticalCenter; width: parent.width - 32; spacing: 4
                                Text { text: feat.modelData[0]; color: Theme.text; font.family: Theme.font; font.pixelSize: 15; font.weight: Font.DemiBold }
                                Text { text: feat.modelData[1]; color: Theme.dim; font.family: Theme.font; font.pixelSize: 13; wrapMode: Text.Wrap; width: parent.width }
                            }
                        }
                    }
                }
            }
        }

        // -------------------------------------------------------------- one agent
        Flickable {
            visible: !w.editing && !!w.sel
            anchors.top: asks.visible ? asks.bottom : parent.top; anchors.topMargin: asks.visible ? 18 : 0
            anchors.left: parent.left; anchors.right: parent.right; anchors.bottom: parent.bottom
            contentHeight: detail.implicitHeight + 20
            clip: true
            ScrollBar.vertical: ScrollBar { policy: ScrollBar.AsNeeded }
            Column {
                id: detail
                width: parent.width
                spacing: 16
                Row {
                    spacing: 12
                    Text { text: w.sel ? w.sel.name : ""; width: Math.min(implicitWidth, detail.width - pill.width - 32); elide: Text.ElideRight; color: Theme.text; font.family: Theme.font; font.pixelSize: 26; font.weight: Font.DemiBold; anchors.verticalCenter: parent.verticalCenter }
                    Rectangle {
                        anchors.verticalCenter: parent.verticalCenter
                        width: pill.implicitWidth + 20; height: 26; radius: 13
                        readonly property var live: w.sel ? w.liveOf(w.sel) : null
                        color: live ? Theme.alpha(live.status === "waiting" ? Theme.warn : Theme.good, 0.16) : Theme.card2
                        Text { id: pill; anchors.centerIn: parent; text: parent.live ? (parent.live.status === "waiting" ? "Esperando permiso" : "Trabajando") : "Parado"; color: parent.live ? (parent.live.status === "waiting" ? Theme.warn : Theme.good) : Theme.dim; font.family: Theme.font; font.pixelSize: 12; font.weight: Font.DemiBold }
                    }
                }
                Flow {
                    width: parent.width
                    spacing: 10
                    Btn { label: "■  Detener"; danger: true; visible: !!(w.sel && w.liveOf(w.sel)); onClicked: w.halt() }
                    Btn { label: "Editar"; onClicked: w.openForm(w.sel) }
                    Btn { label: w.confirmDelete ? "¿Seguro? Pulsa otra vez" : "Borrar"; danger: true; onClicked: w.remove() }
                }
                // how to start it (click to copy)
                Flow {
                    width: parent.width; spacing: 10
                    Text { text: "Arráncalo en la terminal:"; color: Theme.dim; font.family: Theme.font; font.pixelSize: 13; height: 32; verticalAlignment: Text.AlignVCenter }
                    Repeater {
                        model: w.sel ? ["nexus-agente " + w.sel.id + " -- claude", "nexus-agente " + w.sel.id] : []
                        Rectangle {
                            id: cmdChip
                            required property var modelData
                            width: Math.min(cmdLbl.implicitWidth + 24, detail.width); height: 32; radius: 9
                            color: cmdArea.containsMouse ? Theme.hover : Theme.card2; border.color: w.copied === modelData ? Theme.good : Theme.border
                            Text { id: cmdLbl; anchors.centerIn: parent; width: Math.min(implicitWidth, parent.width - 24); elide: Text.ElideMiddle; text: w.copied === cmdChip.modelData ? "Copiado ✓" : cmdChip.modelData; color: w.copied === cmdChip.modelData ? Theme.good : Theme.text; font.family: Theme.mono; font.pixelSize: 13 }
                            MouseArea { id: cmdArea; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor; onClicked: w.copy(cmdChip.modelData) }
                            ToolTip.visible: cmdArea.containsMouse; ToolTip.delay: 500
                            ToolTip.text: index === 0 ? "Claude Code con el MCP de NEXUS ya conectado (clic para copiar)" : "Una terminal dentro de su sandbox, para ver lo que ve (clic para copiar)"
                            required property int index
                        }
                    }
                }
                // the current or last run
                Card {
                    visible: !!w.selRun
                    width: parent.width; height: runCol.implicitHeight + 32
                    Column {
                        id: runCol
                        x: 18; y: 16; width: parent.width - 36; spacing: 10
                        Label_ { text: w.selRun ? ("ÚLTIMA SESIÓN · " + w.ago(w.selRun.started).toUpperCase() + (w.selRun.client ? " · " + w.selRun.client.toUpperCase() : "")) : "" }
                        Row {
                            spacing: 28
                            Repeater {
                                model: w.selRun ? [
                                    [String(w.selRun.calls), "llamadas a NEXUS"],
                                    [w.big(w.selRun.llm.input + w.selRun.llm.output), "tokens de Claude"],
                                    [w.usd(w.selRun.llm.usd) + (w.selRun.llm.unpriced ? "*" : ""), w.selRun.llm.unpriced ? "gastado (*modelo sin precio)" : w.selRun.llm.councilUsd ? "gastado (comité " + w.usd(w.selRun.llm.councilUsd) + ")" : "gastado en Claude"],
                                    [w.big(Math.round(w.selRun.served / 4)), "tokens de contexto"],
                                    [w.selRun.health ? (w.selRun.health.ok ? "✓" : "✕") : "–", w.selRun.health ? ("tests " + (w.selRun.health.ok ? "pasan" : "fallan")) : "sin comprobar"]
                                ] : []
                                Column {
                                    id: stat
                                    required property var modelData
                                    spacing: 2
                                    Text { text: stat.modelData[0]; color: stat.modelData[0] === "✕" ? Theme.danger : stat.modelData[0] === "✓" ? Theme.good : Theme.text; font.family: Theme.font; font.pixelSize: 22; font.weight: Font.DemiBold }
                                    Text { text: stat.modelData[1]; color: Theme.dim; font.family: Theme.font; font.pixelSize: 12 }
                                }
                            }
                        }
                        Text { visible: !!(w.selRun && w.selRun.goal); text: w.selRun && w.selRun.goal ? "Objetivo: " + w.selRun.goal : ""; color: Theme.text; font.family: Theme.font; font.pixelSize: 13; width: parent.width; wrapMode: Text.Wrap }
                        Text { visible: !!(w.selRun && w.selRun.reason); text: w.selRun && w.selRun.reason ? "Detenido: " + w.selRun.reason : ""; color: Theme.danger; font.family: Theme.font; font.pixelSize: 13; width: parent.width; wrapMode: Text.Wrap }
                        Label_ { text: "ACTIVIDAD"; topPadding: 4 }
                        Repeater {
                            model: w.selRun ? w.selRun.activity.slice().reverse().slice(0, 40) : []
                            // a Flow: in a narrow window (half the screen) what happened goes on its own line, full width
                            Flow {
                                id: act
                                required property var modelData
                                readonly property bool narrow: runCol.width < 440
                                spacing: 10
                                width: runCol.width
                                Text { text: w.hm(act.modelData.at); color: Theme.faint; font.family: Theme.mono; font.pixelSize: 12; width: 62 }
                                Text { text: w.outcomeGlyph(act.modelData.outcome); color: w.outcomeColor(act.modelData.outcome); font.pixelSize: 13; font.weight: Font.Bold; width: 14 }
                                Text { text: act.modelData.tool; color: Theme.text; font.family: Theme.mono; font.pixelSize: 12; width: 130; elide: Text.ElideRight }
                                Text { text: act.modelData.text; color: act.modelData.outcome === "denied" || act.modelData.outcome === "error" ? Theme.danger : Theme.dim; font.family: Theme.font; font.pixelSize: 13; width: act.narrow ? runCol.width : runCol.width - 236; wrapMode: Text.Wrap; maximumLineCount: 3; elide: Text.ElideRight }
                            }
                        }
                    }
                }
                // capabilities and limits
                Card {
                    width: parent.width; height: capCol.implicitHeight + 32
                    Column {
                        id: capCol
                        x: 18; y: 16; width: parent.width - 36; spacing: 10
                        Label_ { visible: !!(w.sel && w.sel.brief); text: "SU ENCARGO" }
                        Text { visible: !!(w.sel && w.sel.brief); width: parent.width; wrapMode: Text.Wrap; text: w.sel ? (w.sel.brief || "") : ""; color: Theme.text; font.family: Theme.font; font.pixelSize: 14; lineHeight: 1.2; bottomPadding: 6 }
                        Label_ { text: "PERMISOS (URIs MCP)" }
                        Flow {
                            width: parent.width; spacing: 8
                            Repeater {
                                model: w.sel ? w.sel.scopes : []
                                Rectangle {
                                    id: sc
                                    required property var modelData
                                    width: scText.implicitWidth + 22; height: 30; radius: 15; color: Theme.alpha(Theme.accent, 0.12); border.color: Theme.alpha(Theme.accent, 0.4)
                                    Text { id: scText; anchors.centerIn: parent; text: w.scopeLabel(sc.modelData); color: Theme.text; font.family: Theme.font; font.pixelSize: 12 }
                                    ToolTip.visible: scHover.containsMouse; ToolTip.text: sc.modelData; ToolTip.delay: 400
                                    MouseArea { id: scHover; anchors.fill: parent; hoverEnabled: true }
                                }
                            }
                        }
                        Text {
                            width: parent.width; wrapMode: Text.Wrap; color: Theme.dim; font.family: Theme.font; font.pixelSize: 13; lineHeight: 1.2
                            text: w.sel ? ("Límites: " + w.sel.maxCalls + " llamadas · " + w.sel.maxMinutes + " min · " + (w.sel.maxTokens ? w.big(w.sel.maxTokens) + " tokens de Claude" : "tokens sin límite") + " · " + (w.sel.maxUsd ? w.usd(w.sel.maxUsd) + " por sesión" : "dólares sin límite")
                                  + "\nComité de revisión: " + (w.sel.council ? "sí, en cada commit y push" : "no")
                                  + "\nComprobación automática: " + (w.sel.checkAuto ? w.sel.checkAuto : "ninguna (no encuentro tests)")) : ""
                        }
                    }
                }
            }
        }

        // -------------------------------------------------------------- new / edit
        Flickable {
            visible: w.editing
            anchors.fill: parent
            contentHeight: form.implicitHeight + 20
            clip: true
            ScrollBar.vertical: ScrollBar { policy: ScrollBar.AsNeeded }
            Column {
                id: form
                width: Math.min(parent.width, 720)
                spacing: 12
                Text { text: w.fId ? "Editar agente" : "Nuevo agente"; color: Theme.text; font.family: Theme.font; font.pixelSize: 26; font.weight: Font.DemiBold; bottomPadding: 6 }
                PromptBox {
                    visible: !w.fId && !w.fromAi
                    width: parent.width
                    placeholder: "Dime qué quieres que haga y en qué carpeta, con tus palabras"
                    button: "Rellenarlo con NEXUS AI"
                    hint: "Cuesta unos 2 céntimos. Luego lo revisas aquí abajo."
                    busy: w.drafting; error: w.drafting ? "" : w.draftErr
                    onSubmit: (t) => w.draftFromText(t)
                }
                Rectangle {
                    visible: w.fromAi
                    width: parent.width; height: aiNote.implicitHeight + 24; radius: 14
                    color: Theme.alpha(Theme.accent, 0.12); border.color: Theme.alpha(Theme.accent, 0.4)
                    NexusMark { x: 14; y: 12; width: 22; height: 22 }
                    Text { id: aiNote; x: 48; y: 12; width: parent.width - 62; wrapMode: Text.Wrap; color: Theme.text; font.family: Theme.font; font.pixelSize: 13; lineHeight: 1.15
                           text: "NEXUS AI lo ha preparado (le ha costado " + w.draftUsd + " US$). Revisa la carpeta y los permisos: no se crea nada hasta que pulses «Crear agente»." }
                }
                Label_ { text: "Nombre" }
                Field { id: fName; width: parent.width; placeholderText: "web, backend, docs…"; enabled: !w.fId }
                Label_ { text: "Carpeta del proyecto" }
                Field { id: fFolder; width: parent.width; mono: true; placeholderText: "~/proyectos/web" }
                Label_ { text: "Su encargo (opcional)"; topPadding: 6 }
                Rectangle {
                    width: parent.width; height: Math.max(84, fBrief.implicitHeight + 8); radius: 12
                    color: Theme.card; border.color: fBrief.activeFocus ? Theme.accent : Theme.border; border.width: fBrief.activeFocus ? 2 : 1
                    TextArea {
                        id: fBrief
                        anchors.fill: parent; anchors.margins: 1
                        wrapMode: TextEdit.Wrap; placeholderText: "Qué hace en este proyecto y cómo: «arregla fallos, escribe tests y no toques el diseño»"; placeholderTextColor: Theme.faint
                        color: Theme.text; selectByMouse: true; selectionColor: Theme.alpha(Theme.accent, 0.45); selectedTextColor: Theme.text
                        font.family: Theme.font; font.pixelSize: 14; leftPadding: 12; rightPadding: 12; topPadding: 10; bottomPadding: 10
                        background: null
                    }
                }
                Text { width: parent.width; wrapMode: Text.Wrap; color: Theme.faint; font.family: Theme.font; font.pixelSize: 12
                       text: "El agente lo lee cada vez que empieza. Nunca le da más permisos de los que marques abajo." }
                Label_ { text: "Qué puede hacer"; topPadding: 6 }
                Flow {
                    width: parent.width; spacing: 8
                    Repeater {
                        model: w.permKinds
                        Chip { required property var modelData; label: modelData[1]; on: !!w.fPerms[modelData[0]]; onPicked: w.togglePerm(modelData[0]) }
                    }
                }
                Text { width: parent.width; wrapMode: Text.Wrap; color: Theme.faint; font.family: Theme.font; font.pixelSize: 12
                       text: "Los comandos se ejecutan aislados y los críticos (git push, rm -r, DROP TABLE, desplegar…) siempre te esperan. Las claves SSH y los .env nunca se le dan a un agente." }
                Label_ { text: "Comprobación automática (tests y linter)"; topPadding: 6 }
                Field { id: fCheck; width: parent.width; mono: true; placeholderText: "vacío = la detecta NEXUS (npm test, pytest, cargo test…)" }
                Flow {
                    width: parent.width; spacing: 12; topPadding: 6
                    Column { spacing: 6; Label_ { text: "Máx. llamadas" } Field { id: fCalls; width: 150; mono: true; inputMethodHints: Qt.ImhDigitsOnly } }
                    Column { spacing: 6; Label_ { text: "Máx. minutos" } Field { id: fMinutes; width: 150; mono: true; inputMethodHints: Qt.ImhDigitsOnly } }
                    Column { spacing: 6; Label_ { text: "Máx. tokens de Claude" } Field { id: fTokens; width: 200; mono: true; inputMethodHints: Qt.ImhDigitsOnly } }
                    Column { spacing: 6; Label_ { text: "Máx. dólares (0 = sin límite)" } Field { id: fUsd; width: 150; mono: true; inputMethodHints: Qt.ImhFormattedNumbersOnly } }
                }
                Row {
                    spacing: 12; topPadding: 6
                    NexusSwitch { checked: w.fCouncil; onToggled: w.fCouncil = checked; anchors.verticalCenter: parent.verticalCenter }
                    Text { width: parent.parent.width - 64; wrapMode: Text.Wrap; text: "Comité de revisión antes de cada commit y push (usa tu clave de Claude)"; color: Theme.text; font.family: Theme.font; font.pixelSize: 14; anchors.verticalCenter: parent.verticalCenter }
                }
                Text { visible: !!w.formErr; text: w.formErr; color: Theme.danger; font.family: Theme.font; font.pixelSize: 13; width: parent.width; wrapMode: Text.Wrap }
                Row {
                    spacing: 10; topPadding: 8
                    Btn { label: w.saving ? "Guardando…" : (w.fId ? "Guardar" : "Crear agente"); primary: true; enabled_: !w.saving; onClicked: w.save() }
                    Btn { label: "Cancelar"; onClicked: { w.editing = false; w.formErr = "" } }
                }
            }
        }
    }
    Shortcut { sequence: "Ctrl+N"; enabled: w.tab === "codigo"; onActivated: w.openForm(null) }
    Shortcut { sequence: "Esc"; enabled: w.tab === "codigo" && w.editing; onActivated: w.editing = false }
    Shortcut { sequence: "Ctrl+Return"; enabled: w.tab === "codigo" && w.editing; onActivated: w.save() }
}
