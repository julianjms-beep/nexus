import QtQuick
import QtQuick.Controls
import "../shell"

// Agentes → Agencias: teams of AI workers with a boss, roles, a schedule, a shared board and an office you can watch
// (core/src/agency.ts in nexus-sessiond). Describe the team in your words and NEXUS AI designs it, or start from the
// marketing office template; nothing works until you press Crear. Workers only read (web, your connected services,
// the agency folder) and deliver documents into ~/Agencias/<agencia>/; whatever would need sending or changing data
// arrives here as a proposal for you.
Item {
    id: ag
    signal switchTab(string tab)

    property var items: []
    property var connections: []
    property bool loaded: false
    property string selId: ""
    readonly property var sel: { for (var i = 0; i < items.length; i++) if (items[i].id === selId) return items[i]; return null }
    property var detail: null
    property string mode: ""            // "" = an agency, "new" = how to start, "edit" = the form
    property string selWorker: ""
    readonly property var worker: { if (!sel) return null; for (var i = 0; i < sel.workers.length; i++) if (sel.workers[i].id === selWorker) return sel.workers[i]; return null }
    property string pane: "equipo"      // equipo | entregas | propuestas | tablon
    property bool confirmDel: false
    property string msg: ""
    // creating
    property bool drafting: false
    property string draftErr: ""
    property string draftNote: ""
    // the form: a plain JS object edited in place; edGen rebuilds the Repeaters, edTick refreshes small bindings
    property var ed: null
    property int edGen: 0
    property int edTick: 0
    property string edErr: ""
    property bool saving: false
    // a delivered document
    property var doc: null
    // chat
    property bool chatBusy: false
    property string chatErr: ""

    readonly property var palette: ["#7c5cff", "#ff6b9a", "#2ec5ff", "#ffb84d", "#3ddc97", "#ff7a45", "#a78bfa", "#22d3ee", "#f472b6", "#84cc16"]
    readonly property var dayNames: ["lun", "mar", "mié", "jue", "vie", "sáb", "dom"]
    readonly property var models: [["claude-haiku-5-5", "Haiku 5.5", "el más barato"], ["claude-sonnet-5-5", "Sonnet 5.5", "recomendado"], ["claude-opus-5-5", "Opus 5.5", "el mejor, más caro"]]

    function cap(s) { s = String(s || ""); return s.charAt(0).toUpperCase() + s.slice(1) }
    function esc(s) { return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;") }
    function money(n) { return Number(n || 0).toFixed(2).replace(".", ",") + " US$" }
    function hm(iso) { return new Date(iso).toLocaleTimeString(Qt.locale("es_ES"), "HH:mm") }
    function ago(iso) {
        var d = (Session.now.getTime() - new Date(iso).getTime()) / 1000
        if (!(d >= 0)) return ""
        if (d < 45) return "hace un momento"
        if (d < 3600) return "hace " + Math.round(d / 60) + " min"
        if (d < 86400) return "hace " + Math.round(d / 3600) + " h"
        return new Date(iso).toLocaleDateString(Qt.locale("es_ES"), "d MMM")
    }
    function when(iso) {
        var d = new Date(iso), n = Session.now
        var a = new Date(n.getFullYear(), n.getMonth(), n.getDate()).getTime(), b = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
        var days = Math.round((b - a) / 86400000)
        return (days === 0 ? "hoy" : days === 1 ? "mañana" : dayNames[(d.getDay() + 6) % 7]) + " " + hm(iso)
    }
    function schedule(t) {
        if (!t.time) return "Solo cuando se la pidas"
        var d = t.days || [], s = d.join(",")
        var txt = s === "1,2,3,4,5,6,7" ? "todos los días" : s === "1,2,3,4,5" ? "de lunes a viernes" : s === "6,7" ? "fines de semana" : d.map(function(x) { return dayNames[x - 1] }).join(", ")
        return cap(txt) + " a las " + t.time
    }
    // a delivered document is shown as Markdown, without remote images (opening it must not reach any website)
    function safeMarkdown(t) { return String(t || "").replace(/!\[[^\]]*\]\([^)]*\)/g, "").replace(/<img[^>]*>/gi, "") }
    function liveFor(id) { return sel && sel.live ? sel.live[id] || null : null }
    function anyLive(a) { return !!a && !!a.live && Object.keys(a.live).length > 0 }
    function hash(s) { var h = 0; s = String(s || ""); for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) & 0xffff; return h }
    function connName(id) { for (var i = 0; i < connections.length; i++) if (connections[i].id === id) return connections[i].name; return id }
    function workerName(id) { if (!sel) return id; for (var i = 0; i < sel.workers.length; i++) if (sel.workers[i].id === id) return sel.workers[i].name; return id }
    function errText(st, j, what) { return cap(j && j.error ? j.error : what + " (error " + st + ")") + "." }

    // ---- data
    function load() {
        Session.request("GET", "/agencias", null, function(st, j) {
            if (st !== 200 || !j) return
            ag.items = j.items || []; ag.connections = j.connections || []; ag.loaded = true
            if (ag.selId && !ag.sel) { ag.selId = ""; ag.detail = null }
            if (!ag.selId && ag.items.length && ag.mode === "") ag.pick(ag.items[0].id)
            else ag.loadDetail()
        })
    }
    function loadDetail() {
        if (!selId) { detail = null; return }
        var id = selId
        Session.request("GET", "/agencias/" + id, null, function(st, j) { if (st === 200 && j && j.agency && ag.selId === id) ag.detail = j })
    }
    function pick(id) { if (selId !== id) { selWorker = ""; detail = null } selId = id; mode = ""; confirmDel = false; msg = ""; doc = null; loadDetail() }
    function post(path, body, done) { Session.request("POST", path, body || {}, function(st, j) { if (done) done(st, j); ag.load() }) }

    function runTask(wid, tid) {
        msg = ""
        post("/agencias/" + selId + "/run", { worker: wid, task: tid }, function(st, j) {
            if (st !== 200) ag.msg = ag.errText(st, j, "no se ha podido empezar")
            else if (j && j.queued === false) ag.msg = ag.cap(j.reason) + "."
        })
    }
    function stopRun(runId) { post("/agencias/" + selId + "/stop", { run: runId }) }
    function setProposal(pid, status) { post("/agencias/" + selId + "/proposal", { id: pid, status: status }) }
    function setEnabled(on) { post("/agencias/" + selId + "/enable", { on: on }) }
    function removeSel() {
        if (!confirmDel) { confirmDel = true; delReset.restart(); return }
        post("/agencias/" + selId + "/delete", {}, function() { ag.selId = ""; ag.detail = null; ag.confirmDel = false })
    }
    function openDoc(file) {
        if (!file) return
        Session.request("GET", "/agencias/" + selId + "/doc?file=" + encodeURIComponent(file), null, function(st, j) {
            if (st === 200 && j) ag.doc = j; else ag.msg = ag.errText(st, j, "no se ha podido abrir el documento")
        })
    }
    function sendChat(text) {
        if (!worker || chatBusy || !text.trim()) return
        chatBusy = true; chatErr = ""
        Session.request("POST", "/agencias/" + selId + "/chat", { worker: worker.id, text: text }, function(st, j) {
            ag.chatBusy = false
            if (st !== 200) ag.chatErr = ag.errText(st, j, "no ha contestado")
            ag.load()
        })
    }

    // ---- creating and editing
    function startNew() { mode = "new"; draftErr = ""; draftNote = ""; doc = null; edErr = "" }
    function openEditor(a, note) {
        var x = JSON.parse(JSON.stringify(a || {}))
        x.name = x.name || ""; x.purpose = x.purpose || ""; x.model = x.model || "claude-sonnet-5-5"
        x.budgetUsd = x.budgetUsd || 20; x.taskUsd = x.taskUsd || 0.5
        x.workers = (x.workers || []).map(function(v) {
            return { name: v.name || "", role: v.role || "", emoji: v.emoji || "🙂", color: v.color || "#7c5cff", boss: !!v.boss, web: !!v.web,
                     connections: (v.connections || []).slice(), brief: v.brief || "",
                     tasks: (v.tasks || []).map(function(t) { return { title: t.title || "", instructions: t.instructions || "", days: (t.days || []).slice(), time: t.time || "" } }) }
        })
        if (!x.workers.length) x.workers.push({ name: "", role: "", emoji: "🧑‍💼", color: palette[0], boss: true, web: false, connections: [], brief: "", tasks: [] })
        ed = x; edGen++; edTick++; edErr = ""; draftNote = note || ""; mode = "edit"
    }
    function draftNow(text) {
        drafting = true; draftErr = ""
        Session.request("POST", "/agencias/draft", { descripcion: text }, function(st, j) {
            ag.drafting = false
            if (st === 200 && j && j.agency) {
                ag.openEditor(j.agency, "NEXUS AI ha diseñado este equipo (le ha costado " + ag.money(j.usd) + "). Revísalo y cambia lo que quieras: nadie trabaja hasta que pulses Crear.")
                if (j.problem) ag.edErr = ag.cap(j.problem) + "."
            } else ag.draftErr = ag.errText(st, j, "NEXUS AI no ha podido diseñarla")
        })
    }
    function fromTemplate() {
        Session.request("GET", "/agencias/plantilla", null, function(st, j) {
            if (st === 200 && j && j.agency) ag.openEditor(j.agency, "Es la plantilla «Agencia de marketing», como tu oficina: cámbiale los nombres, las tareas y las horas a tu gusto. Nadie trabaja hasta que pulses Crear.")
        })
    }
    function workerSlots() { var a = []; if (!ed) return a; for (var i = 0; i < ed.workers.length; i++) a.push(edGen * 1000 + i); return a }
    function taskSlots(wi) { var a = []; if (!ed || !ed.workers[wi]) return a; for (var i = 0; i < ed.workers[wi].tasks.length; i++) a.push(edGen * 1000 + i); return a }
    function addWorker() { ed.workers.push({ name: "", role: "", emoji: "🙂", color: palette[ed.workers.length % palette.length], boss: false, web: false, connections: [], brief: "", tasks: [] }); edGen++ }
    function dropWorker(wi) { ed.workers.splice(wi, 1); edGen++ }
    function setBoss(wi) { for (var i = 0; i < ed.workers.length; i++) ed.workers[i].boss = (i === wi) ? !ed.workers[i].boss : false; edTick++ }
    function toggleConn(wi, id) { var c = ed.workers[wi].connections, k = c.indexOf(id); if (k >= 0) c.splice(k, 1); else c.push(id); edTick++ }
    function addTask(wi) { ed.workers[wi].tasks.push({ title: "", instructions: "", days: [1, 2, 3, 4, 5], time: "09:00" }); edGen++ }
    function dropTask(wi, ti) { ed.workers[wi].tasks.splice(ti, 1); edGen++ }
    function toggleDay(wi, ti, d) { var a = ed.workers[wi].tasks[ti].days, k = a.indexOf(d); if (k >= 0) a.splice(k, 1); else { a.push(d); a.sort() } edTick++ }
    function saveEd() {
        saving = true; edErr = ""
        Session.request("POST", "/agencias", { agency: ed }, function(st, j) {
            ag.saving = false
            if (st === 200 && j && j.id) { ag.mode = ""; ag.ed = null; ag.selWorker = ""; ag.selId = j.id; ag.detail = null; ag.load() }
            else ag.edErr = ag.errText(st, j, "no se ha podido guardar")
        })
    }
    function cancelEd() { mode = ""; ed = null; edErr = ""; if (!sel && items.length) pick(items[0].id) }

    Component.onCompleted: if (visible) load()
    onVisibleChanged: if (visible) load()
    Connections { target: Session; function onAgencyChanged(id) { if (ag.visible) reload.restart() } }
    Timer { id: reload; interval: 200; onTriggered: ag.load() }
    Timer { interval: 5000; repeat: true; running: ag.visible; onTriggered: ag.load() }
    Timer { id: delReset; interval: 3500; onTriggered: ag.confirmDel = false }

    // ------------------------------------------------------------------ small building blocks (no outer ids inside)
    component Btn: Rectangle {
        id: btn
        property string label: ""
        property bool primary: false
        property bool danger: false
        property bool enabled_: true
        property bool small: false
        signal clicked()
        width: btnText.implicitWidth + (small ? 22 : 32); height: small ? 30 : 38; radius: small ? 10 : 12
        opacity: enabled_ ? 1 : 0.5
        color: primary ? (btnArea.pressed ? Qt.darker(Theme.accent, 1.2) : Theme.accent)
             : danger ? (btnArea.containsMouse ? Theme.alpha(Theme.danger, 0.16) : "transparent")
             : (btnArea.containsMouse ? Theme.hover : Theme.card2)
        border.color: primary ? "transparent" : danger ? Theme.alpha(Theme.danger, 0.55) : Theme.border
        Text { id: btnText; anchors.centerIn: parent; text: btn.label; color: btn.primary ? "#ffffff" : btn.danger ? Theme.danger : Theme.text; font.family: Theme.font; font.pixelSize: btn.small ? 12 : 14; font.weight: btn.primary ? Font.DemiBold : Font.Normal }
        MouseArea { id: btnArea; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor; onClicked: if (btn.enabled_) btn.clicked() }
    }
    component Chip: Rectangle {
        id: chip
        property string label: ""
        property bool on: false
        signal picked()
        width: chipText.implicitWidth + 24; height: 30; radius: 15
        color: on ? Theme.alpha(Theme.accent, 0.22) : chipArea.containsMouse ? Theme.hover : Theme.card2
        border.color: on ? Theme.accent : Theme.border
        Text { id: chipText; anchors.centerIn: parent; text: (chip.on ? "✓ " : "") + chip.label; color: chip.on ? Theme.text : Theme.dim; font.family: Theme.font; font.pixelSize: 12; font.weight: chip.on ? Font.DemiBold : Font.Normal }
        MouseArea { id: chipArea; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor; onClicked: chip.picked() }
    }
    component Field: TextField {
        id: fld
        color: Theme.text; placeholderTextColor: Theme.faint
        selectByMouse: true; selectionColor: Theme.alpha(Theme.accent, 0.45); selectedTextColor: Theme.text
        font.family: Theme.font; font.pixelSize: 14
        leftPadding: 12; rightPadding: 12
        background: Rectangle { implicitHeight: 40; radius: 10; color: Theme.card; border.color: fld.activeFocus ? Theme.accent : Theme.border; border.width: fld.activeFocus ? 2 : 1 }
    }
    component Area: Rectangle {
        id: areaBox
        property alias text: areaEdit.text
        property string placeholder: ""
        height: Math.max(64, areaEdit.implicitHeight + 8); radius: 10
        color: Theme.card; border.color: areaEdit.activeFocus ? Theme.accent : Theme.border; border.width: areaEdit.activeFocus ? 2 : 1
        TextArea {
            id: areaEdit
            anchors.fill: parent; anchors.margins: 1
            wrapMode: TextEdit.Wrap; placeholderText: areaBox.placeholder; placeholderTextColor: Theme.faint
            color: Theme.text; selectByMouse: true; selectionColor: Theme.alpha(Theme.accent, 0.45); selectedTextColor: Theme.text
            font.family: Theme.font; font.pixelSize: 13; leftPadding: 10; rightPadding: 10; topPadding: 8; bottomPadding: 8
            background: null
        }
    }
    component Lbl: Text { color: Theme.dim; font.family: Theme.font; font.pixelSize: 12; font.weight: Font.DemiBold }
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

    // ------------------------------------------------------------------ list of agencies
    Rectangle {
        id: side
        width: Math.round(Math.min(380, Math.max(280, ag.width * 0.36))); height: parent.height
        color: Theme.card
        Rectangle { anchors.right: parent.right; width: 1; height: parent.height; color: Theme.border }
        Column {
            id: head
            x: 20; y: 22; width: parent.width - 40
            spacing: 10
            Row {
                spacing: 12
                Image { width: 34; height: 34; sourceSize: Qt.size(68, 68); source: Qt.resolvedUrl("../icons/app-agents.svg"); anchors.verticalCenter: parent.verticalCenter }
                Text { text: "Agentes"; color: Theme.text; font.family: Theme.font; font.pixelSize: 22; font.weight: Font.DemiBold; anchors.verticalCenter: parent.verticalCenter }
            }
            Seg { options: [["codigo", "Código"], ["agencias", "Agencias"]]; current: "agencias"; onPicked: (id) => ag.switchTab(id) }
            Text { width: parent.width; wrapMode: Text.Wrap; text: "Equipos de IA con jefe, horarios y un tablón, como una oficina. Trabajan solos y te entregan documentos y propuestas."; color: Theme.dim; font.family: Theme.font; font.pixelSize: 13; lineHeight: 1.2 }
            Btn { label: "+  Nueva agencia"; primary: true; width: parent.width; onClicked: ag.startNew() }
        }
        ListView {
            id: list
            anchors.top: head.bottom; anchors.topMargin: 16; anchors.bottom: parent.bottom; anchors.bottomMargin: 12
            x: 12; width: parent.width - 24
            clip: true; spacing: 6
            model: ag.items
            delegate: Rectangle {
                id: card
                required property var modelData
                readonly property bool picked: ag.selId === modelData.id && ag.mode === ""
                width: list.width; height: 84; radius: 14
                color: picked ? Theme.alpha(Theme.accent, 0.14) : cardArea.containsMouse ? Theme.hover : "transparent"
                border.color: picked ? Theme.alpha(Theme.accent, 0.5) : "transparent"
                MouseArea { id: cardArea; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor; onClicked: ag.pick(card.modelData.id) }
                Column {
                    x: 16; anchors.verticalCenter: parent.verticalCenter; width: parent.width - 32
                    spacing: 4
                    Row {
                        spacing: 8
                        Rectangle {
                            width: 9; height: 9; radius: 5; anchors.verticalCenter: parent.verticalCenter
                            color: !card.modelData.enabled ? Theme.faint : ag.anyLive(card.modelData) ? Theme.good : Theme.accent
                            SequentialAnimation on opacity { running: ag.anyLive(card.modelData); loops: Animation.Infinite; NumberAnimation { to: 0.25; duration: 650 } NumberAnimation { to: 1; duration: 650 } }
                        }
                        Text { text: card.modelData.name; color: Theme.text; font.family: Theme.font; font.pixelSize: 15; font.weight: Font.DemiBold; elide: Text.ElideRight; width: card.width - 60 }
                    }
                    Text { text: card.modelData.workers.map(function(x) { return x.emoji || "🙂" }).join(" ") + "  " + card.modelData.workers.length + " en el equipo"; color: Theme.dim; font.family: Theme.font; font.pixelSize: 12; elide: Text.ElideRight; width: parent.width }
                    Text {
                        text: (card.modelData.enabled ? "" : "En pausa · ") + ag.money(card.modelData.spentMonth) + " de " + ag.money(card.modelData.budgetUsd) + " este mes" + (card.modelData.pending ? " · " + card.modelData.pending + " propuestas" : "")
                        color: card.modelData.pending ? Theme.warn : Theme.faint; font.family: Theme.font; font.pixelSize: 12; elide: Text.ElideRight; width: parent.width
                    }
                }
            }
        }
        Text {
            visible: ag.loaded && !ag.items.length
            anchors.top: head.bottom; anchors.topMargin: 28; x: 24; width: parent.width - 48
            wrapMode: Text.Wrap; horizontalAlignment: Text.AlignHCenter
            text: "Aún no tienes ninguna."; color: Theme.faint; font.family: Theme.font; font.pixelSize: 13
        }
    }

    Item {
        id: main
        anchors.left: side.right; anchors.right: parent.right; anchors.top: parent.top; anchors.bottom: parent.bottom
        anchors.margins: 28

        // -------------------------------------------------------------- how to start (also when there is none)
        Flickable {
            id: startFlick
            visible: ag.loaded && (ag.mode === "new" || (ag.mode === "" && !ag.items.length))
            anchors.fill: parent
            contentWidth: width; contentHeight: startCol.y + startCol.height + 20
            clip: true; boundsBehavior: Flickable.StopAtBounds
            ScrollBar.vertical: ScrollBar { policy: ScrollBar.AsNeeded }
            Column {
                id: startCol
                width: Math.min(startFlick.width, 700)
                x: Math.round((startFlick.width - width) / 2)
                y: Math.max(0, Math.round((startFlick.height - height) / 2))
                spacing: 16
                Text { width: parent.width; wrapMode: Text.Wrap; text: "Crea tu agencia"; color: Theme.text; font.family: Theme.font; font.pixelSize: 26; font.weight: Font.DemiBold }
                Text {
                    width: parent.width; wrapMode: Text.Wrap; lineHeight: 1.25; color: Theme.dim; font.family: Theme.font; font.pixelSize: 14
                    text: "Una agencia es un equipo de IA que trabaja solo a sus horas: alguien busca tendencias por la mañana, otra persona escribe ideas para redes, alguien mira tus ventas y la jefa te deja un parte al final del día. Leen la web y tus servicios conectados, pero no envían ni publican nada: te lo proponen a ti."
                }
                PromptBox {
                    width: parent.width
                    title: "Descríbela con tus palabras"
                    placeholder: "Por ejemplo: «una agencia de marketing para mis marcas de cosmética coreana: tendencias de TikTok, ideas para Instagram, prensa, y un informe de ventas de Wiwink cada tarde»"
                    button: "Diseñarla con NEXUS AI"
                    hint: "NEXUS AI propone el equipo, sus tareas y horarios; tú lo revisas antes de crearla. Diseñarla cuesta unos 5 céntimos de tu saldo de Claude."
                    busy: ag.drafting; error: ag.drafting ? "" : ag.draftErr
                    onSubmit: (t) => ag.draftNow(t)
                }
                Rectangle {
                    width: parent.width; height: 82; radius: 16
                    color: tplArea.containsMouse ? Theme.hover : Theme.card; border.color: tplArea.containsMouse ? Theme.accent : Theme.border
                    Text { x: 18; anchors.verticalCenter: parent.verticalCenter; text: "👩‍💼🔎🎨📰📊"; font.pixelSize: 22 }
                    Column {
                        x: 160; anchors.verticalCenter: parent.verticalCenter; width: parent.width - 180; spacing: 4
                        Text { text: "Empezar con la plantilla «Agencia de marketing»"; color: Theme.text; font.family: Theme.font; font.pixelSize: 15; font.weight: Font.DemiBold; width: parent.width; elide: Text.ElideRight }
                        Text { text: "Como tu oficina: directora, tendencias, contenido para redes, prensa y analista de ventas. No cuesta nada hasta que trabajen."; color: Theme.dim; font.family: Theme.font; font.pixelSize: 13; width: parent.width; wrapMode: Text.Wrap; maximumLineCount: 2; elide: Text.ElideRight }
                    }
                    MouseArea { id: tplArea; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor; onClicked: ag.fromTemplate() }
                }
                Row {
                    spacing: 10
                    Btn { label: "Empezar desde cero"; onClicked: ag.openEditor({ workers: [] }, "") }
                    Btn { label: "Cancelar"; visible: ag.items.length > 0; onClicked: ag.cancelEd() }
                }
            }
        }

        // -------------------------------------------------------------- one agency: the office
        Flickable {
            id: deskFlick
            visible: ag.mode === "" && !!ag.sel && !ag.doc
            anchors.fill: parent
            contentHeight: deskCol.implicitHeight + 20
            clip: true; boundsBehavior: Flickable.StopAtBounds
            ScrollBar.vertical: ScrollBar { policy: ScrollBar.AsNeeded }
            Column {
                id: deskCol
                width: deskFlick.width - 4
                spacing: 16
                // name, on/off
                Item {
                    width: parent.width; height: 44
                    Text { text: ag.sel ? ag.sel.name : ""; width: Math.min(implicitWidth, parent.width - 240); elide: Text.ElideRight; color: Theme.text; font.family: Theme.font; font.pixelSize: 26; font.weight: Font.DemiBold; anchors.verticalCenter: parent.verticalCenter }
                    Row {
                        anchors.right: parent.right; anchors.verticalCenter: parent.verticalCenter; spacing: 10
                        Text { text: ag.sel && ag.sel.enabled ? "Trabaja a sus horas" : "En pausa"; color: ag.sel && ag.sel.enabled ? Theme.good : Theme.dim; font.family: Theme.font; font.pixelSize: 13; anchors.verticalCenter: parent.verticalCenter }
                        NexusSwitch { id: enSw; onToggled: ag.setEnabled(checked); anchors.verticalCenter: parent.verticalCenter }
                        // the switch flips itself on click (which would break a plain binding): keep it following the agency shown
                        Binding { target: enSw; property: "checked"; value: !!ag.sel && ag.sel.enabled }
                    }
                }
                Text { visible: !!(ag.sel && ag.sel.purpose); width: parent.width; wrapMode: Text.Wrap; text: ag.sel ? ag.sel.purpose : ""; color: Theme.dim; font.family: Theme.font; font.pixelSize: 14; lineHeight: 1.2 }
                // what it has spent this month
                Column {
                    id: budget
                    readonly property real frac: ag.sel ? Math.min(1, ag.sel.spentMonth / Math.max(0.01, ag.sel.budgetUsd)) : 0
                    width: parent.width; spacing: 6
                    Rectangle {
                        width: parent.width; height: 8; radius: 4; color: Theme.card2
                        Rectangle { width: Math.max(budget.frac > 0 ? 8 : 0, parent.width * budget.frac); height: 8; radius: 4; color: budget.frac >= 0.9 ? Theme.danger : budget.frac >= 0.7 ? Theme.warn : Theme.accent }
                    }
                    Text {
                        text: ag.sel ? ("Gastado este mes: " + ag.money(ag.sel.spentMonth) + " de " + ag.money(ag.sel.budgetUsd) + " · máximo " + ag.money(ag.sel.taskUsd) + " por tarea · " + (ag.sel.model.indexOf("haiku") >= 0 ? "Haiku 5.5" : ag.sel.model.indexOf("opus") >= 0 ? "Opus 5.5" : "Sonnet 5.5")) : ""
                        color: Theme.dim; font.family: Theme.font; font.pixelSize: 12
                    }
                }
                Flow {
                    width: parent.width; spacing: 10
                    Btn { label: "Editar"; onClicked: ag.openEditor(ag.sel, "") }
                    Btn { label: "Abrir carpeta"; onClicked: Session.openFolder(ag.sel.folderPath) }
                    Btn { label: "■  Parar a todos"; danger: true; visible: ag.anyLive(ag.sel); onClicked: ag.stopRun("") }
                    Btn { label: ag.confirmDel ? "¿Seguro? Pulsa otra vez" : "Borrar"; danger: true; onClicked: ag.removeSel() }
                }
                Text { visible: ag.msg !== ""; width: parent.width; wrapMode: Text.Wrap; text: ag.msg; color: Theme.warn; font.family: Theme.font; font.pixelSize: 13 }

                // ---- the office: wall with windows (the sky follows the time of day), a tiled floor, a desk per person
                Rectangle {
                    id: office
                    readonly property int cols: Math.max(1, Math.floor((width - 24) / 178))
                    readonly property int rows: ag.sel ? Math.max(1, Math.ceil(ag.sel.workers.length / cols)) : 1
                    readonly property int hour: Session.now.getHours()
                    width: parent.width; height: 96 + rows * 168 + 12; radius: 18; clip: true
                    color: Theme.dark ? "#2a2433" : "#e9dfd2"
                    border.color: Theme.border
                    Rectangle {
                        width: parent.width; height: 78
                        color: Theme.dark ? "#3a3347" : "#f4ede4"
                        Rectangle { y: parent.height - 6; width: parent.width; height: 6; color: Theme.dark ? "#4a4058" : "#d8c8b5" }
                        Row {
                            x: 24; y: 14; spacing: 26
                            Repeater {
                                model: Math.max(1, Math.floor((office.width - 220) / 120))
                                Rectangle {
                                    width: 92; height: 46; color: "#5b4a3a"
                                    Rectangle {
                                        anchors.fill: parent; anchors.margins: 4
                                        gradient: Gradient {
                                            GradientStop { position: 0; color: office.hour >= 21 || office.hour < 7 ? "#141a3a" : office.hour >= 18 ? "#ff9a62" : "#7cc8ff" }
                                            GradientStop { position: 1; color: office.hour >= 21 || office.hour < 7 ? "#2b2f5c" : office.hour >= 18 ? "#ffd29a" : "#c9ecff" }
                                        }
                                    }
                                    Rectangle { x: parent.width / 2 - 2; y: 4; width: 4; height: parent.height - 8; color: "#5b4a3a" }
                                }
                            }
                        }
                        Rectangle {
                            anchors.right: parent.right; anchors.rightMargin: 22; y: 16; width: 74; height: 38; radius: 8
                            color: "#1d1b24"; border.color: "#5b4a3a"; border.width: 3
                            Text { anchors.centerIn: parent; text: Qt.formatTime(Session.now, "HH:mm"); color: "#7dffb2"; font.family: Theme.mono; font.pixelSize: 17; font.weight: Font.Bold }
                        }
                    }
                    Canvas {
                        y: 78; width: parent.width; height: parent.height - 78
                        property bool dark: Theme.dark
                        onDarkChanged: requestPaint()
                        onWidthChanged: requestPaint()
                        onHeightChanged: requestPaint()
                        onPaint: {
                            var c = getContext("2d"); var s = 28
                            for (var y = 0; y < height; y += s) for (var x = 0; x < width; x += s) {
                                c.fillStyle = ((x / s + y / s) % 2 === 0) ? (dark ? "#2d2737" : "#e6dccd") : (dark ? "#28222f" : "#ded2c1")
                                c.fillRect(x, y, s, s)
                            }
                        }
                    }
                    Repeater {
                        model: 2
                        Item {
                            required property int index
                            x: index === 0 ? 6 : office.width - 30; y: office.height - 46; width: 24; height: 40
                            Rectangle { x: 4; y: 22; width: 16; height: 16; color: "#b5653d" }
                            Rectangle { x: 2; y: 6; width: 20; height: 18; radius: 9; color: "#3f9b5a" }
                            Rectangle { x: 7; y: 0; width: 10; height: 12; radius: 5; color: "#57b872" }
                        }
                    }
                    Grid {
                        x: Math.round((office.width - (office.cols * 178 - 10)) / 2); y: 92
                        columns: office.cols; spacing: 10
                        Repeater {
                            model: ag.sel ? ag.sel.workers : []
                            Item {
                                id: st
                                required property var modelData
                                readonly property var live: ag.liveFor(modelData.id)
                                readonly property bool working: !!live && live.status === "running"
                                readonly property bool queued: !!live && live.status === "queued"
                                readonly property bool picked: ag.selWorker === modelData.id
                                readonly property int h: ag.hash(modelData.name)
                                readonly property color skin: ["#f2c9a0", "#e0a97e", "#c68863", "#8d5a3b", "#f6d5b8"][h % 5]
                                readonly property color hair: ["#3b2a20", "#151515", "#a0522d", "#e8c26a", "#6b4a2f", "#b8b8c8"][(h >> 3) % 6]
                                property real bob: 0
                                width: 168; height: 158
                                SequentialAnimation on bob {
                                    running: st.working; loops: Animation.Infinite
                                    NumberAnimation { to: -3; duration: 260; easing.type: Easing.InOutQuad }
                                    NumberAnimation { to: 0; duration: 260; easing.type: Easing.InOutQuad }
                                }
                                Rectangle { x: 6; y: 52; width: parent.width - 12; height: 66; radius: 12; color: Theme.alpha(Theme.accent, 0.18); border.color: Theme.alpha(Theme.accent, 0.6); visible: st.picked }
                                // speech bubble: what they are doing right now
                                Rectangle {
                                    anchors.horizontalCenter: parent.horizontalCenter
                                    width: Math.min(164, bubbleText.implicitWidth + 16); height: bubbleText.implicitHeight + 10; radius: 8
                                    color: st.working ? "#ffffff" : Theme.alpha(Theme.card, 0.92)
                                    border.color: st.working ? st.modelData.color : Theme.border; border.width: st.working ? 2 : 1
                                    Rectangle { x: parent.width / 2 - 4; y: parent.height - 4; width: 8; height: 8; rotation: 45; color: parent.color; border.color: parent.border.color; border.width: parent.border.width; z: -1 }
                                    Text {
                                        id: bubbleText
                                        x: 8; y: 5; width: Math.min(148, implicitWidth)
                                        text: st.working ? (st.live.activity || "Trabajando…") : st.queued ? "En cola: «" + st.live.title + "»" : !ag.sel.enabled ? "En pausa" : st.modelData.next ? "Próxima: " + ag.when(st.modelData.next.at) : "Libre"
                                        wrapMode: Text.Wrap; maximumLineCount: 2; elide: Text.ElideRight
                                        color: st.working ? "#1d1b24" : Theme.dim; font.family: Theme.font; font.pixelSize: 11; font.weight: st.working ? Font.DemiBold : Font.Normal
                                    }
                                }
                                // the person (pixel art), behind the desk
                                Item {
                                    x: 84; y: 50 + st.bob; width: 40; height: 46
                                    Rectangle { x: 8; y: 0; width: 24; height: 7; color: st.hair }
                                    Rectangle { x: 6; y: 3; width: 4; height: 12; color: st.hair }
                                    Rectangle { x: 8; y: 7; width: 24; height: 15; color: st.skin }
                                    Rectangle { x: 13; y: 12; width: 4; height: 4; color: "#1d1b24" }
                                    Rectangle { x: 23; y: 12; width: 4; height: 4; color: "#1d1b24" }
                                    Rectangle { x: 16; y: 18; width: 8; height: 2; color: "#a0524a"; visible: st.working || st.picked }
                                    Rectangle { x: 2; y: 22; width: 36; height: 24; color: st.modelData.color }
                                    Rectangle { x: 16; y: 22; width: 8; height: 6; color: st.skin }
                                    Text { visible: st.modelData.boss; x: 26; y: -16; text: "★"; color: "#ffcc33"; font.pixelSize: 14; font.weight: Font.Bold }
                                }
                                // the desk and the computer (its screen glows in their colour while they work)
                                Rectangle { x: 14; y: 92; width: 140; height: 12; color: "#9a6a43" }
                                Rectangle { x: 14; y: 104; width: 140; height: 4; color: "#7a5032" }
                                Rectangle { x: 20; y: 108; width: 6; height: 10; color: "#7a5032" }
                                Rectangle { x: 142; y: 108; width: 6; height: 10; color: "#7a5032" }
                                Rectangle {
                                    x: 28; y: 62; width: 46; height: 30; color: "#1d1f2b"; border.color: "#0d0f16"; border.width: 2
                                    Rectangle {
                                        anchors.fill: parent; anchors.margins: 3
                                        color: st.working ? st.modelData.color : "#2a3142"
                                        SequentialAnimation on opacity { running: st.working; loops: Animation.Infinite; NumberAnimation { to: 0.6; duration: 420 } NumberAnimation { to: 1; duration: 420 } }
                                    }
                                    Text { anchors.centerIn: parent; text: st.modelData.emoji || "🙂"; font.pixelSize: 14 }
                                }
                                Rectangle { x: 46; y: 88; width: 10; height: 4; color: "#0d0f16" }
                                Rectangle { x: 90; y: 88 + (st.working ? st.bob : 0); width: 8; height: 4; color: st.skin }
                                Rectangle { x: 110; y: 88 - (st.working ? st.bob : 0); width: 8; height: 4; color: st.skin }
                                Column {
                                    y: 122; width: parent.width; spacing: 1
                                    Text { width: parent.width; horizontalAlignment: Text.AlignHCenter; text: st.modelData.name; color: Theme.text; font.family: Theme.font; font.pixelSize: 13; font.weight: Font.DemiBold; elide: Text.ElideRight }
                                    Text { width: parent.width; horizontalAlignment: Text.AlignHCenter; text: st.modelData.role; color: Theme.dim; font.family: Theme.font; font.pixelSize: 11; elide: Text.ElideRight }
                                }
                                MouseArea {
                                    anchors.fill: parent; cursorShape: Qt.PointingHandCursor
                                    onClicked: { ag.selWorker = st.modelData.id; ag.pane = "equipo"; ag.chatErr = "" }
                                }
                            }
                        }
                    }
                }

                // ---- the person picked, deliveries, proposals, board
                Seg {
                    options: [["equipo", ag.worker ? ag.worker.name : "Equipo"], ["entregas", "Entregas"], ["propuestas", "Propuestas" + (ag.sel && ag.sel.pending ? " (" + ag.sel.pending + ")" : "")], ["tablon", "Tablón"]]
                    current: ag.pane; onPicked: (id) => ag.pane = id
                }
                Text {
                    visible: ag.pane === "equipo" && !ag.worker
                    width: parent.width; wrapMode: Text.Wrap; color: Theme.dim; font.family: Theme.font; font.pixelSize: 14
                    text: "Pulsa a alguien de la oficina para ver sus tareas, pedirle que haga una ahora o hablar con esa persona."
                }
                Card {
                    visible: ag.pane === "equipo" && !!ag.worker
                    width: parent.width; height: wkCol.implicitHeight + 32
                    Column {
                        id: wkCol
                        x: 18; y: 16; width: parent.width - 36; spacing: 12
                        Row {
                            spacing: 12
                            Text { text: ag.worker ? (ag.worker.emoji || "🙂") : ""; font.pixelSize: 30; anchors.verticalCenter: parent.verticalCenter }
                            Column {
                                anchors.verticalCenter: parent.verticalCenter; spacing: 2
                                Text { text: ag.worker ? ag.worker.name + (ag.worker.boss ? "  ★ dirige la agencia" : "") : ""; color: Theme.text; font.family: Theme.font; font.pixelSize: 18; font.weight: Font.DemiBold }
                                Text { text: ag.worker ? ag.worker.role : ""; color: Theme.dim; font.family: Theme.font; font.pixelSize: 13 }
                            }
                        }
                        Text { visible: !!(ag.worker && ag.worker.brief); width: parent.width; wrapMode: Text.Wrap; text: ag.worker ? ag.worker.brief : ""; color: Theme.text; font.family: Theme.font; font.pixelSize: 13; lineHeight: 1.2 }
                        Flow {
                            width: parent.width; spacing: 6
                            Repeater {
                                model: ag.worker ? (ag.worker.web ? ["🌐 Busca en Internet"] : []).concat(ag.worker.connections.map(function(c) { return "🔌 Lee " + ag.connName(c) })) : []
                                Rectangle {
                                    id: capChip
                                    required property var modelData
                                    width: capText.implicitWidth + 18; height: 26; radius: 13; color: Theme.card2; border.color: Theme.border
                                    Text { id: capText; anchors.centerIn: parent; text: capChip.modelData; color: Theme.dim; font.family: Theme.font; font.pixelSize: 12 }
                                }
                            }
                        }
                        Rectangle {
                            id: liveBox
                            readonly property var live: ag.worker ? ag.liveFor(ag.worker.id) : null
                            visible: !!live
                            width: parent.width; height: 48; radius: 12
                            color: Theme.alpha(Theme.good, 0.10); border.color: Theme.alpha(Theme.good, 0.5)
                            Text {
                                x: 14; anchors.verticalCenter: parent.verticalCenter; width: parent.width - 140; elide: Text.ElideRight
                                text: liveBox.live ? (liveBox.live.status === "queued" ? "En cola: «" + liveBox.live.title + "»" : "Con «" + liveBox.live.title + "» · " + (liveBox.live.activity || "trabajando…")) : ""
                                color: Theme.text; font.family: Theme.font; font.pixelSize: 13
                            }
                            Btn { small: true; danger: true; label: "■ Detener"; visible: !!liveBox.live && liveBox.live.run !== ""; anchors.right: parent.right; anchors.rightMargin: 10; anchors.verticalCenter: parent.verticalCenter; onClicked: ag.stopRun(liveBox.live.run) }
                        }
                        Lbl { text: "TAREAS" }
                        Repeater {
                            model: ag.worker ? ag.worker.tasks : []
                            Rectangle {
                                id: taskRow
                                required property var modelData
                                width: wkCol.width; height: Math.max(56, taskInfo.implicitHeight + 20); radius: 12; color: Theme.card2
                                Column {
                                    id: taskInfo
                                    x: 14; anchors.verticalCenter: parent.verticalCenter; width: parent.width - 150; spacing: 3
                                    Text { text: taskRow.modelData.title; color: Theme.text; font.family: Theme.font; font.pixelSize: 14; font.weight: Font.DemiBold; width: parent.width; elide: Text.ElideRight }
                                    Text { text: ag.schedule(taskRow.modelData); color: Theme.dim; font.family: Theme.font; font.pixelSize: 12 }
                                }
                                Btn { small: true; label: "▶ Hacer ahora"; anchors.right: parent.right; anchors.rightMargin: 10; anchors.verticalCenter: parent.verticalCenter; onClicked: ag.runTask(ag.worker.id, taskRow.modelData.id) }
                            }
                        }
                        Text { visible: !!ag.worker && !ag.worker.tasks.length; text: "No tiene tareas: añádeselas en «Editar»."; color: Theme.faint; font.family: Theme.font; font.pixelSize: 13 }
                        Lbl { text: "SUS ÚLTIMAS ENTREGAS"; topPadding: 4 }
                        Repeater {
                            model: ag.detail && ag.worker ? ag.detail.runs.filter(function(r) { return r.worker === ag.worker.id && r.status !== "running" }).slice(0, 5) : []
                            Rectangle {
                                id: wrun
                                required property var modelData
                                width: wkCol.width; height: 40; radius: 10
                                color: wrunArea.containsMouse && wrun.modelData.file ? Theme.hover : "transparent"
                                Text { x: 8; anchors.verticalCenter: parent.verticalCenter; text: wrun.modelData.status === "done" ? "✓" : wrun.modelData.status === "stopped" ? "■" : "✕"; color: wrun.modelData.status === "done" ? Theme.good : Theme.danger; font.pixelSize: 13; font.weight: Font.Bold }
                                Text { x: 30; anchors.verticalCenter: parent.verticalCenter; width: parent.width - 150; elide: Text.ElideRight; text: wrun.modelData.status === "done" ? wrun.modelData.title : wrun.modelData.title + " — " + (wrun.modelData.error || ""); color: Theme.text; font.family: Theme.font; font.pixelSize: 13 }
                                Text { anchors.right: parent.right; anchors.rightMargin: 8; anchors.verticalCenter: parent.verticalCenter; text: ag.ago(wrun.modelData.ended || wrun.modelData.started); color: Theme.faint; font.family: Theme.font; font.pixelSize: 12 }
                                MouseArea { id: wrunArea; anchors.fill: parent; hoverEnabled: true; cursorShape: wrun.modelData.file ? Qt.PointingHandCursor : Qt.ArrowCursor; onClicked: ag.openDoc(wrun.modelData.file) }
                            }
                        }
                        Lbl { text: "HABLAR CON " + (ag.worker ? ag.worker.name.toUpperCase() : ""); topPadding: 4 }
                        Repeater {
                            model: ag.detail && ag.worker && ag.detail.chats[ag.worker.id] ? ag.detail.chats[ag.worker.id].slice(-8) : []
                            Item {
                                id: msgItem
                                required property var modelData
                                readonly property bool mine: modelData.role === "user"
                                width: wkCol.width; height: bub.height
                                Rectangle {
                                    id: bub
                                    x: msgItem.mine ? parent.width - width : 0
                                    width: Math.min(parent.width * 0.8, msgText.implicitWidth + 24); height: msgText.implicitHeight + 16; radius: 12
                                    color: msgItem.mine ? Theme.alpha(Theme.accent, 0.2) : Theme.card2
                                    Text { id: msgText; x: 12; y: 8; width: Math.min(wkCol.width * 0.8 - 24, implicitWidth); wrapMode: Text.Wrap; text: msgItem.modelData.text; color: Theme.text; font.family: Theme.font; font.pixelSize: 13; lineHeight: 1.15 }
                                }
                            }
                        }
                        Row {
                            width: parent.width; spacing: 8
                            Field {
                                id: chatIn
                                width: parent.width - sendBtn.width - 8
                                enabled: !ag.chatBusy
                                placeholderText: ag.chatBusy ? (ag.worker ? ag.worker.name : "") + " está escribiendo…" : "Pregúntale algo o dale una idea…"
                                onAccepted: { ag.sendChat(text); text = "" }
                            }
                            Btn { id: sendBtn; label: "Enviar"; primary: true; enabled_: !ag.chatBusy; onClicked: { ag.sendChat(chatIn.text); chatIn.text = "" } }
                        }
                        Text { visible: ag.chatErr !== ""; width: parent.width; wrapMode: Text.Wrap; text: ag.chatErr; color: Theme.danger; font.family: Theme.font; font.pixelSize: 13 }
                    }
                }
                // every delivery
                Card {
                    visible: ag.pane === "entregas"
                    width: parent.width; height: runsCol.implicitHeight + 24
                    Column {
                        id: runsCol
                        x: 12; y: 12; width: parent.width - 24; spacing: 2
                        Text { visible: !ag.detail || !ag.detail.runs.length; text: "Todavía no ha entregado nada. Pulsa a alguien y «Hacer ahora», o espera a sus horas."; color: Theme.faint; font.family: Theme.font; font.pixelSize: 13; width: parent.width; wrapMode: Text.Wrap; padding: 8 }
                        Repeater {
                            model: ag.detail ? ag.detail.runs : []
                            Rectangle {
                                id: run
                                required property var modelData
                                width: runsCol.width; height: runInfo.implicitHeight + 16; radius: 10
                                color: runArea.containsMouse && run.modelData.file ? Theme.hover : "transparent"
                                Text { x: 8; y: 8; text: run.modelData.status === "done" ? "✓" : run.modelData.status === "running" ? "…" : run.modelData.status === "stopped" ? "■" : "✕"; color: run.modelData.status === "done" ? Theme.good : run.modelData.status === "running" ? Theme.accent : Theme.danger; font.pixelSize: 13; font.weight: Font.Bold }
                                Column {
                                    id: runInfo
                                    x: 30; y: 8; width: parent.width - 40; spacing: 2
                                    Text { width: parent.width; elide: Text.ElideRight; text: ag.workerName(run.modelData.worker) + " · " + run.modelData.title; color: Theme.text; font.family: Theme.font; font.pixelSize: 13; font.weight: Font.DemiBold }
                                    Text {
                                        width: parent.width; wrapMode: Text.Wrap; maximumLineCount: 2; elide: Text.ElideRight
                                        text: (run.modelData.status === "done" ? run.modelData.summary : run.modelData.status === "running" ? (run.modelData.activity || "Trabajando…") : (run.modelData.error || ""))
                                              + "  ·  " + ag.ago(run.modelData.ended || run.modelData.started) + " · " + (run.modelData.why === "horario" ? "a su hora" : "a mano") + " · " + ag.money(run.modelData.usd)
                                        color: run.modelData.status === "failed" ? Theme.danger : Theme.dim; font.family: Theme.font; font.pixelSize: 12
                                    }
                                }
                                MouseArea { id: runArea; anchors.fill: parent; hoverEnabled: true; cursorShape: run.modelData.file ? Qt.PointingHandCursor : Qt.ArrowCursor; onClicked: ag.openDoc(run.modelData.file) }
                            }
                        }
                    }
                }
                // proposals: what the team would need you to do
                Card {
                    visible: ag.pane === "propuestas"
                    width: parent.width; height: propCol.implicitHeight + 24
                    Column {
                        id: propCol
                        x: 12; y: 12; width: parent.width - 24; spacing: 6
                        Text { visible: !ag.detail || !ag.detail.proposals.length; text: "Sin propuestas. Cuando el equipo necesite que envíes, publiques o llames a alguien, te lo dejará aquí."; color: Theme.faint; font.family: Theme.font; font.pixelSize: 13; width: parent.width; wrapMode: Text.Wrap; padding: 8 }
                        Repeater {
                            model: ag.detail ? ag.detail.proposals : []
                            Rectangle {
                                id: prop
                                required property var modelData
                                readonly property bool pending: modelData.status === "pending"
                                width: propCol.width; height: Math.max(52, propText.implicitHeight + 24); radius: 12
                                color: pending ? Theme.alpha(Theme.warn, 0.08) : "transparent"; border.color: pending ? Theme.alpha(Theme.warn, 0.4) : Theme.border
                                opacity: pending ? 1 : 0.6
                                Text {
                                    id: propText
                                    x: 14; anchors.verticalCenter: parent.verticalCenter; width: parent.width - (prop.pending ? 210 : 120); wrapMode: Text.Wrap
                                    text: "<b>" + ag.esc(prop.modelData.who) + "</b>: " + ag.esc(prop.modelData.text); textFormat: Text.StyledText
                                    color: Theme.text; font.family: Theme.font; font.pixelSize: 13
                                }
                                Row {
                                    anchors.right: parent.right; anchors.rightMargin: 10; anchors.verticalCenter: parent.verticalCenter; spacing: 6
                                    Btn { small: true; label: "✓ Hecha"; visible: prop.pending; onClicked: ag.setProposal(prop.modelData.id, "done") }
                                    Btn { small: true; label: "Descartar"; visible: prop.pending; onClicked: ag.setProposal(prop.modelData.id, "dismissed") }
                                    Text { visible: !prop.pending; text: prop.modelData.status === "done" ? "Hecha" : "Descartada"; color: Theme.dim; font.family: Theme.font; font.pixelSize: 12 }
                                }
                            }
                        }
                    }
                }
                // the board: notes the team leaves for each other
                Card {
                    visible: ag.pane === "tablon"
                    width: parent.width; height: boardCol.implicitHeight + 24
                    color: Theme.dark ? "#3b3128" : "#f3e3c3"
                    Column {
                        id: boardCol
                        x: 14; y: 12; width: parent.width - 28; spacing: 8
                        Text { visible: !ag.detail || !ag.detail.board.length; text: "El tablón está vacío."; color: Theme.dim; font.family: Theme.font; font.pixelSize: 13 }
                        Repeater {
                            model: ag.detail ? ag.detail.board : []
                            Rectangle {
                                id: note
                                required property var modelData
                                required property int index
                                width: boardCol.width; height: noteText.implicitHeight + 18; radius: 4
                                color: ["#fff6a8", "#ffd6e0", "#cdeeff", "#d9f7c8"][index % 4]
                                rotation: index % 2 === 0 ? -0.4 : 0.4
                                Text {
                                    id: noteText
                                    x: 12; y: 9; width: parent.width - 24; wrapMode: Text.Wrap; textFormat: Text.StyledText
                                    text: "<b>" + ag.esc(note.modelData.who) + "</b> · " + ag.ago(note.modelData.at) + "<br>" + ag.esc(note.modelData.text)
                                    color: "#2b2620"; font.family: Theme.font; font.pixelSize: 13
                                }
                            }
                        }
                    }
                }
            }
        }

        // -------------------------------------------------------------- a delivered document
        Item {
            visible: !!ag.doc && ag.mode === ""
            anchors.fill: parent
            Row {
                id: docBar
                spacing: 10
                Btn { label: "←  Volver"; onClicked: ag.doc = null }
                Btn { label: "Abrir su carpeta"; onClicked: { var p = String(ag.doc.path); Session.openFolder(p.substring(0, p.lastIndexOf("/"))) } }
            }
            Card {
                anchors.top: docBar.bottom; anchors.topMargin: 14; anchors.left: parent.left; anchors.right: parent.right; anchors.bottom: parent.bottom
                Flickable {
                    id: docFlick
                    anchors.fill: parent; anchors.margins: 22
                    contentHeight: docText.implicitHeight; clip: true; boundsBehavior: Flickable.StopAtBounds
                    ScrollBar.vertical: ScrollBar { policy: ScrollBar.AsNeeded }
                    Text {
                        id: docText
                        width: docFlick.width - 12; wrapMode: Text.Wrap
                        textFormat: Text.MarkdownText; text: ag.doc ? ag.safeMarkdown(ag.doc.text) : ""
                        color: Theme.text; font.family: Theme.font; font.pixelSize: 14; lineHeight: 1.2
                        onLinkActivated: (link) => { if (/^https?:\/\//.test(link)) Qt.openUrlExternally(link) }
                    }
                }
            }
        }

        // -------------------------------------------------------------- create / edit the team
        Flickable {
            id: edFlick
            visible: ag.mode === "edit" && !!ag.ed
            anchors.fill: parent
            contentHeight: edCol.implicitHeight + 30
            clip: true; boundsBehavior: Flickable.StopAtBounds
            ScrollBar.vertical: ScrollBar { policy: ScrollBar.AsNeeded }
            Column {
                id: edCol
                width: Math.min(edFlick.width - 16, 760)
                spacing: 12
                Text { text: ag.ed && ag.ed.id ? "Editar agencia" : "Nueva agencia"; color: Theme.text; font.family: Theme.font; font.pixelSize: 26; font.weight: Font.DemiBold; bottomPadding: 4 }
                Rectangle {
                    visible: ag.draftNote !== ""
                    width: parent.width; height: noteLbl.implicitHeight + 24; radius: 14
                    color: Theme.alpha(Theme.accent, 0.12); border.color: Theme.alpha(Theme.accent, 0.4)
                    NexusMark { x: 14; y: 12; width: 22; height: 22 }
                    Text { id: noteLbl; x: 48; y: 12; width: parent.width - 62; wrapMode: Text.Wrap; text: ag.draftNote; color: Theme.text; font.family: Theme.font; font.pixelSize: 13; lineHeight: 1.15 }
                }
                Lbl { text: "NOMBRE" }
                Field { width: parent.width; maximumLength: 40; placeholderText: "Agencia de marketing"; text: ag.ed ? ag.ed.name : ""; onTextChanged: if (ag.ed) ag.ed.name = text }
                Lbl { text: "PARA QUÉ ES (todo el equipo lo lee)" }
                Area { width: parent.width; placeholder: "Llevar el marketing de mis marcas…"; text: ag.ed ? ag.ed.purpose : ""; onTextChanged: if (ag.ed) ag.ed.purpose = text }
                Lbl { text: "MODELO DE CLAUDE" }
                Flow {
                    width: parent.width; spacing: 8
                    Repeater {
                        model: ag.models
                        Chip { required property var modelData; label: modelData[1] + " · " + modelData[2]; on: ag.edTick >= 0 && !!ag.ed && ag.ed.model === modelData[0]; onPicked: { ag.ed.model = modelData[0]; ag.edTick++ } }
                    }
                }
                Row {
                    spacing: 14
                    Column { spacing: 6; Lbl { text: "PRESUPUESTO AL MES (US$)" } Field { width: 180; text: ag.ed ? String(ag.ed.budgetUsd).replace(".", ",") : ""; onTextChanged: if (ag.ed) ag.ed.budgetUsd = Number(text.replace(",", ".")) } }
                    Column { spacing: 6; Lbl { text: "MÁXIMO POR TAREA (US$)" } Field { width: 180; text: ag.ed ? String(ag.ed.taskUsd).replace(".", ",") : ""; onTextChanged: if (ag.ed) ag.ed.taskUsd = Number(text.replace(",", ".")) } }
                }
                Text { width: parent.width; wrapMode: Text.Wrap; color: Theme.faint; font.family: Theme.font; font.pixelSize: 12
                       text: "Con Sonnet, una tarea suele costar entre 0,05 y 0,40 US$ (más si busca mucho en Internet). Al llegar al presupuesto el equipo para hasta el mes siguiente." }

                Text { text: "El equipo"; color: Theme.text; font.family: Theme.font; font.pixelSize: 20; font.weight: Font.DemiBold; topPadding: 10 }
                Repeater {
                    model: ag.workerSlots()
                    Card {
                        id: wcard
                        required property int modelData
                        readonly property int wi: modelData % 1000
                        readonly property var wk: ag.ed ? ag.ed.workers[wi] : null
                        width: edCol.width; height: wcol.implicitHeight + 32
                        border.color: ag.edTick >= 0 && wk && wk.boss ? Theme.alpha(Theme.accent, 0.6) : Theme.border
                        Column {
                            id: wcol
                            x: 18; y: 16; width: parent.width - 36; spacing: 10
                            Row {
                                width: parent.width; spacing: 10
                                Column { spacing: 6; Lbl { text: "EMOJI" } Field { width: 70; maximumLength: 8; horizontalAlignment: Text.AlignHCenter; text: wcard.wk ? wcard.wk.emoji : ""; onTextChanged: if (wcard.wk) wcard.wk.emoji = text } }
                                Column { spacing: 6; Lbl { text: "NOMBRE" } Field { width: 170; maximumLength: 30; placeholderText: "Leo"; text: wcard.wk ? wcard.wk.name : ""; onTextChanged: if (wcard.wk) wcard.wk.name = text } }
                                Column { spacing: 6; Lbl { text: "PUESTO" } Field { width: wcol.width - 270; maximumLength: 60; placeholderText: "Tendencias"; text: wcard.wk ? wcard.wk.role : ""; onTextChanged: if (wcard.wk) wcard.wk.role = text } }
                            }
                            Flow {
                                width: parent.width; spacing: 8
                                Repeater {
                                    model: ag.palette
                                    Rectangle {
                                        id: swatch
                                        required property var modelData
                                        width: 24; height: 24; radius: 12; color: modelData
                                        border.color: Theme.text; border.width: ag.edTick >= 0 && wcard.wk && wcard.wk.color === modelData ? 3 : 0
                                        MouseArea { anchors.fill: parent; cursorShape: Qt.PointingHandCursor; onClicked: { wcard.wk.color = swatch.modelData; ag.edTick++ } }
                                    }
                                }
                            }
                            Flow {
                                width: parent.width; spacing: 8
                                Chip { label: "★ Dirige la agencia"; on: ag.edTick >= 0 && !!wcard.wk && wcard.wk.boss; onPicked: ag.setBoss(wcard.wi) }
                                Chip { label: "🌐 Puede buscar en Internet"; on: ag.edTick >= 0 && !!wcard.wk && wcard.wk.web; onPicked: { wcard.wk.web = !wcard.wk.web; ag.edTick++ } }
                                Repeater {
                                    model: ag.connections
                                    Chip { required property var modelData; label: "🔌 Lee " + modelData.name; on: ag.edTick >= 0 && !!wcard.wk && wcard.wk.connections.indexOf(modelData.id) >= 0; onPicked: ag.toggleConn(wcard.wi, modelData.id) }
                                }
                            }
                            Text { visible: !ag.connections.length; width: parent.width; wrapMode: Text.Wrap; text: "Para que alguien lea tus ventas o tus clientes, conecta el servicio en la app Conexiones."; color: Theme.faint; font.family: Theme.font; font.pixelSize: 12 }
                            Lbl { text: "SU ENCARGO" }
                            Area { width: parent.width; placeholder: "Qué hace esta persona en la agencia y cómo"; text: wcard.wk ? wcard.wk.brief : ""; onTextChanged: if (wcard.wk) wcard.wk.brief = text }
                            Lbl { text: "TAREAS" }
                            Repeater {
                                model: ag.taskSlots(wcard.wi)
                                Rectangle {
                                    id: tcard
                                    required property int modelData
                                    readonly property int ti: modelData % 1000
                                    readonly property var tk: wcard.wk ? wcard.wk.tasks[ti] : null
                                    width: wcol.width; height: tcol.implicitHeight + 24; radius: 12; color: Theme.card2; border.color: Theme.border
                                    Column {
                                        id: tcol
                                        x: 12; y: 12; width: parent.width - 24; spacing: 8
                                        Row {
                                            width: parent.width; spacing: 8
                                            Field { width: parent.width - 170; maximumLength: 80; placeholderText: "Título: Tendencias del día"; text: tcard.tk ? tcard.tk.title : ""; onTextChanged: if (tcard.tk) tcard.tk.title = text }
                                            Field { width: 80; maximumLength: 5; placeholderText: "09:30"; horizontalAlignment: Text.AlignHCenter; text: tcard.tk ? tcard.tk.time : ""; onTextChanged: if (tcard.tk) { tcard.tk.time = text; ag.edTick++ } }
                                            Btn { small: true; danger: true; label: "Quitar"; anchors.verticalCenter: parent.verticalCenter; onClicked: ag.dropTask(wcard.wi, tcard.ti) }
                                        }
                                        Flow {
                                            width: parent.width; spacing: 6
                                            Repeater {
                                                model: 7
                                                Chip { required property int index; label: ag.dayNames[index]; on: ag.edTick >= 0 && !!tcard.tk && tcard.tk.days.indexOf(index + 1) >= 0; onPicked: ag.toggleDay(wcard.wi, tcard.ti, index + 1) }
                                            }
                                            Text { text: ag.edTick >= 0 && tcard.tk && !tcard.tk.time ? "Sin hora: solo cuando se la pidas" : ""; color: Theme.faint; font.family: Theme.font; font.pixelSize: 12; height: 30; verticalAlignment: Text.AlignVCenter }
                                        }
                                        Area { width: parent.width; placeholder: "Qué tiene que hacer, qué entrega y cómo de largo"; text: tcard.tk ? tcard.tk.instructions : ""; onTextChanged: if (tcard.tk) tcard.tk.instructions = text }
                                    }
                                }
                            }
                            Row {
                                spacing: 10
                                Btn { small: true; label: "+ Añadir tarea"; onClicked: ag.addTask(wcard.wi) }
                                Btn { small: true; danger: true; label: "Quitar a " + (wcard.wk && wcard.wk.name ? wcard.wk.name : "esta persona"); visible: !!ag.ed && ag.ed.workers.length > 1; onClicked: ag.dropWorker(wcard.wi) }
                            }
                        }
                    }
                }
                Btn { label: "+  Añadir a alguien al equipo"; onClicked: ag.addWorker() }
                Text { visible: ag.edErr !== ""; width: parent.width; wrapMode: Text.Wrap; text: ag.edErr; color: Theme.danger; font.family: Theme.font; font.pixelSize: 13 }
                Row {
                    spacing: 10; topPadding: 8
                    Btn { label: ag.saving ? "Guardando…" : ag.ed && ag.ed.id ? "Guardar cambios" : "Crear agencia"; primary: true; enabled_: !ag.saving; onClicked: ag.saveEd() }
                    Btn { label: "Cancelar"; onClicked: ag.cancelEd() }
                }
            }
        }
    }
    Shortcut { sequence: "Esc"; enabled: ag.visible && (ag.mode !== "" || !!ag.doc); onActivated: { if (ag.doc) ag.doc = null; else ag.cancelEd() } }
}
